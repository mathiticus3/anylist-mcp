#!/usr/bin/env python3
"""Fail-closed, AnyList-only production release and rollback workflow."""

from __future__ import annotations

import argparse
import http.client
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import ssl
import stat
import subprocess
import sys
import time
from urllib import error, request

HERE = Path(__file__).resolve().parent
MANIFEST_PATH = HERE / "release-manifest.json"
SPEC_PATH = HERE / "release-spec.json"
BUNDLE_PATH = HERE / "source.bundle"
COMPONENT_NAMES = {"source.bundle", "release-spec.json", "deploy_anylist.py"}
HEX40 = re.compile(r"^[0-9a-f]{40}$")
RECONCILE_STATE_FILES = {
    "snapshot.json", "status.json", "release-manifest.json", "source-before.bundle",
    "candidate.override.yaml", "candidate-smoke.json", "migration-smoke.json",
    "deployed-smoke.json",
}
NONVOLATILE_METADATA_KEYS = {
    "users", "credential_records", "oauth_clients",
    "public_oauth_clients", "confidential_oauth_clients",
}
TRANSIENT_HTTP_ERRORS = (
    ConnectionResetError, ConnectionRefusedError, TimeoutError,
    ConnectionAbortedError, BrokenPipeError, EOFError,
    http.client.RemoteDisconnected, http.client.IncompleteRead, ssl.SSLEOFError,
)


class ReleaseError(RuntimeError):
    pass


def emit(message: str) -> None:
    print(f"[anylist-release] {message}", flush=True)


def run(args: list[str], *, cwd: Path | None = None, input_text: str | None = None) -> str:
    result = subprocess.run(
        args, cwd=cwd, input=input_text, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        label = " ".join(args[:3])
        raise ReleaseError(f"command failed ({result.returncode}): {label}")
    return result.stdout.strip()


def command_succeeds(args: list[str], *, cwd: Path | None = None) -> bool:
    result = subprocess.run(
        args, cwd=cwd, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"invalid JSON component: {path.name}") from exc
    if not isinstance(value, dict):
        raise ReleaseError(f"JSON component must be an object: {path.name}")
    return value


def validate_artifact() -> tuple[dict, dict]:
    manifest = load_json(MANIFEST_PATH)
    spec = load_json(SPEC_PATH)
    if manifest.get("schema_version") != 1 or manifest.get("service") != "anylist-mcp":
        raise ReleaseError("unsupported release manifest")
    candidate = manifest.get("candidate_commit", "")
    if not HEX40.fullmatch(candidate):
        raise ReleaseError("manifest candidate commit is not exact")
    components = manifest.get("components")
    if not isinstance(components, dict) or set(components) != COMPONENT_NAMES:
        raise ReleaseError("manifest component set is not exact")
    for name in sorted(COMPONENT_NAMES):
        path = HERE / name
        expected = components[name]
        if not path.is_file() or path.is_symlink():
            raise ReleaseError(f"missing or unsafe component: {name}")
        if path.stat().st_size != expected.get("size") or sha256(path) != expected.get("sha256"):
            raise ReleaseError(f"component digest mismatch: {name}")
    if spec.get("schema_version") != 1 or spec.get("service") != "anylist-mcp":
        raise ReleaseError("unsupported release specification")
    heads = run(["git", "bundle", "list-heads", str(BUNDLE_PATH)])
    if candidate not in heads:
        raise ReleaseError("source bundle does not advertise candidate commit")
    return manifest, spec


def git(source: Path, *args: str) -> str:
    return run(["git", "-C", str(source), *args])


def submodule_is_exact(output: str, expected_commit: str) -> bool:
    # run() strips the clean status's leading space. Dirty/missing/conflicted
    # statuses retain their +, -, or U marker and therefore cannot match.
    return output.startswith(f"{expected_commit} ")


def compose(prod: dict, *args: str) -> list[str]:
    return ["docker", "compose", "-f", prod["compose_file"], *args]


def fingerprint(path: Path) -> dict:
    info = path.stat()
    return {
        "path": str(path), "sha256": sha256(path),
        "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid,
        "gid": info.st_gid, "inode": info.st_ino, "size": info.st_size,
    }


def metadata_counts(container_id: str) -> dict:
    code = r'''
import Database from "better-sqlite3";
const db = new Database("/data/anylist-mcp.db", {readonly:true, fileMustExist:true});
const n = sql => Number(db.prepare(sql).get().count);
const result = {
  users:n("SELECT COUNT(*) AS count FROM users"),
  credential_records:n("SELECT COUNT(*) AS count FROM anylist_credentials"),
  oauth_clients:n("SELECT COUNT(*) AS count FROM oauth_clients"),
  public_oauth_clients:n("SELECT COUNT(*) AS count FROM oauth_clients WHERE client_secret_hash IS NULL"),
  confidential_oauth_clients:n("SELECT COUNT(*) AS count FROM oauth_clients WHERE client_secret_hash IS NOT NULL"),
  oauth_tokens:n("SELECT COUNT(*) AS count FROM oauth_tokens")
};
db.close(); process.stdout.write(JSON.stringify(result));
'''
    value = json.loads(run(["docker", "exec", "-w", "/app", container_id,
                            "node", "--input-type=module", "-e", code]))
    if not all(isinstance(item, int) and item >= 0 for item in value.values()):
        raise ReleaseError("invalid database metadata counts")
    if value["oauth_clients"] != value["public_oauth_clients"] + value["confidential_oauth_clients"]:
        raise ReleaseError("OAuth client metadata partition is inconsistent")
    if value["credential_records"] > value["users"]:
        raise ReleaseError("credential metadata count exceeds users")
    return value


def nonvolatile_metadata(value: dict) -> dict:
    if not isinstance(value, dict) or any(
        not isinstance(value.get(key), int) or value[key] < 0
        for key in NONVOLATILE_METADATA_KEYS
    ):
        raise ReleaseError("invalid nonvolatile metadata counts")
    return {key: value[key] for key in sorted(NONVOLATILE_METADATA_KEYS)}


def assert_metadata_compatible(before: dict, after: dict) -> None:
    if nonvolatile_metadata(after) != nonvolatile_metadata(before):
        raise ReleaseError("nonvolatile account/OAuth metadata changed")


def database_integrity(container_id: str) -> dict:
    code = r'''
import Database from "better-sqlite3";
const db = new Database("/data/anylist-mcp.db", {readonly:true, fileMustExist:true});
const scalar = sql => db.prepare(sql).get();
const quick = db.pragma("quick_check", {simple:true});
const invalidTokens = Number(scalar(`SELECT COUNT(*) AS count FROM oauth_tokens t
  LEFT JOIN users u ON u.id=t.user_id LEFT JOIN oauth_clients c ON c.client_id=t.client_id
  WHERE u.id IS NULL OR c.client_id IS NULL
    OR length(t.access_token)!=64 OR t.access_token GLOB '*[^0-9a-f]*'
    OR length(t.refresh_token)!=64 OR t.refresh_token GLOB '*[^0-9a-f]*'
    OR typeof(t.created_at)!='integer' OR t.created_at<0
    OR typeof(t.expires_at)!='integer' OR typeof(t.refresh_expires_at)!='integer'
    OR t.created_at>t.expires_at OR t.expires_at>t.refresh_expires_at`).count);
const duplicateAccess = Number(scalar(`SELECT COUNT(*) AS count FROM
  (SELECT access_token FROM oauth_tokens GROUP BY access_token HAVING COUNT(*)>1)`).count);
const duplicateRefresh = Number(scalar(`SELECT COUNT(*) AS count FROM
  (SELECT refresh_token FROM oauth_tokens GROUP BY refresh_token HAVING COUNT(*)>1)`).count);
const tokenCount = Number(scalar("SELECT COUNT(*) AS count FROM oauth_tokens").count);
db.close(); process.stdout.write(JSON.stringify({quick_check:quick, invalid_tokens:invalidTokens,
  duplicate_access_tokens:duplicateAccess, duplicate_refresh_tokens:duplicateRefresh,
  oauth_tokens:tokenCount}));
'''
    value = json.loads(run(["docker", "exec", "-w", "/app", container_id,
                            "node", "--input-type=module", "-e", code]))
    expected_zero = ("invalid_tokens", "duplicate_access_tokens", "duplicate_refresh_tokens")
    if value.get("quick_check") != "ok" or any(value.get(key) != 0 for key in expected_zero):
        raise ReleaseError("database or OAuth-token integrity check failed")
    if not isinstance(value.get("oauth_tokens"), int) or value["oauth_tokens"] < 0:
        raise ReleaseError("invalid OAuth-token count")
    return value


def oauth_client_columns(container_id: str) -> list[str]:
    code = r'''
import Database from "better-sqlite3";
const db = new Database("/data/anylist-mcp.db", {readonly:true, fileMustExist:true});
const columns = db.prepare("PRAGMA table_info(oauth_clients)").all().map(row => row.name);
db.close(); process.stdout.write(JSON.stringify(columns));
'''
    value = json.loads(run(["docker", "exec", "-w", "/app", container_id,
                            "node", "--input-type=module", "-e", code]))
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ReleaseError("invalid oauth_clients schema")
    return value


def allowed_oauth_client_schemas(spec: dict) -> list[list[str]]:
    return [
        spec["expected_baseline"]["oauth_client_columns"],
        spec["candidate_schema"]["oauth_client_columns"],
    ]


def http_json(url: str) -> dict:
    try:
        with request.urlopen(url, timeout=10) as response:
            if response.status != 200:
                raise ReleaseError(f"unexpected HTTP status at {url}")
            return json.loads(response.read())
    except (error.URLError, json.JSONDecodeError, *TRANSIENT_HTTP_ERRORS) as exc:
        raise ReleaseError(f"HTTP JSON check failed at {url}") from exc


def transient_transport_error(exc: BaseException) -> bool:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, TRANSIENT_HTTP_ERRORS):
            return True
        if isinstance(current, error.URLError) and isinstance(current.reason, TRANSIENT_HTTP_ERRORS):
            return True
        current = current.__cause__
    return False


def wait_for_public_health(base_url: str, timeout_seconds: int = 90) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            if http_json(f"{base_url}/health").get("status") != "ok":
                raise ReleaseError("public AnyList health payload is not ok")
            return
        except ReleaseError as exc:
            if not transient_transport_error(exc) or time.monotonic() >= deadline:
                raise
        time.sleep(2)


def http_status(url: str, payload: dict) -> int:
    req = request.Request(url, data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json"}, method="POST")
    try:
        with request.urlopen(req, timeout=10) as response:
            return response.status
    except error.HTTPError as exc:
        return exc.code
    except error.URLError as exc:
        raise ReleaseError(f"HTTP boundary check failed at {url}") from exc


def wait_for_health(base_url: str, timeout_seconds: int = 90) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            if http_json(f"{base_url}/health").get("status") == "ok":
                return
        except ReleaseError:
            pass
        time.sleep(2)
    raise ReleaseError("AnyList health did not recover before timeout")


def service_ids(prod: dict) -> dict:
    cwd = Path(prod["compose_directory"])
    names = run(compose(prod, "config", "--services"), cwd=cwd).splitlines()
    return {
        name: run(compose(prod, "ps", "--all", "-q", name), cwd=cwd)
        for name in names if name != "anylist-mcp"
    }


def inspect_container(prod: dict, container_id: str) -> dict:
    raw = json.loads(run(["docker", "inspect", container_id]))[0]
    mounts = [{
        "type": item["Type"], "name": item.get("Name"),
        "source": item.get("Source"), "destination": item["Destination"],
        "rw": item["RW"],
    } for item in raw["Mounts"]]
    state = raw["State"]
    return {
        "id": raw["Id"], "name": raw["Name"].lstrip("/"),
        "configured_image": raw["Config"]["Image"], "image_id": raw["Image"],
        "running": state["Running"],
        "health": (state.get("Health") or {}).get("Status"),
        "restart": raw["HostConfig"]["RestartPolicy"]["Name"],
        "environment_sha256": hashlib.sha256(
            "\0".join(sorted(raw["Config"].get("Env") or [])).encode()
        ).hexdigest(),
        "networks": sorted((raw.get("NetworkSettings", {}).get("Networks") or {}).keys()),
        "mounts": mounts,
    }


def assert_container(snapshot: dict, prod: dict, *, expected_image_id: str | None = None) -> None:
    if snapshot["name"] != prod["container_name"] or snapshot["configured_image"] != prod["image"]:
        raise ReleaseError("unexpected AnyList container identity")
    if not snapshot["running"] or snapshot["health"] != "healthy" or snapshot["restart"] != "unless-stopped":
        raise ReleaseError("AnyList container is not healthy with expected restart policy")
    if expected_image_id and snapshot["image_id"] != expected_image_id:
        raise ReleaseError("AnyList container image ID is not the expected checkpoint")
    data = [m for m in snapshot["mounts"] if m["destination"] == prod["volume_target"]]
    allow = [m for m in snapshot["mounts"] if m["destination"] == prod["allowlist_target"]]
    if len(data) != 1 or data[0]["type"] != "volume" or data[0]["name"] != prod["volume_name"] or not data[0]["rw"]:
        raise ReleaseError("unexpected AnyList data-volume identity")
    if len(allow) != 1 or allow[0]["type"] != "bind" or allow[0]["source"] != prod["allowlist_path"] or allow[0]["rw"]:
        raise ReleaseError("unexpected AnyList allowlist bind")


def preflight(manifest: dict, spec: dict) -> dict:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        raise ReleaseError("run as the unprivileged deploy account, not root")
    base = spec["expected_baseline"]
    prod = spec["production"]
    source = Path(prod["source_directory"])
    cwd = Path(prod["compose_directory"])
    if not source.is_dir() or not cwd.is_dir():
        raise ReleaseError("production source or Compose directory is missing")
    if git(source, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ReleaseError("production source checkout is not clean")
    if git(source, "rev-parse", "HEAD") != base["commit"]:
        raise ReleaseError("production source is not at the expected baseline")
    if git(source, "symbolic-ref", "--short", "HEAD") != base["branch"]:
        raise ReleaseError("production source branch is not the expected release branch")
    if git(source, "remote", "get-url", "origin") != base["origin"]:
        raise ReleaseError("production Git origin changed")
    if git(source, "rev-parse", f"HEAD:{base['submodule_path']}") != base["submodule_commit"]:
        raise ReleaseError("production submodule pointer changed")
    submodule = git(source, "submodule", "status", base["submodule_path"])
    if not submodule_is_exact(submodule, base["submodule_commit"]):
        raise ReleaseError("production submodule checkout is missing or dirty")

    config = json.loads(run(compose(prod, "config", "--format", "json"), cwd=cwd))
    service = config.get("services", {}).get("anylist-mcp")
    if not service or service.get("container_name") != prod["container_name"]:
        raise ReleaseError("effective Compose service identity changed")
    if service.get("image") != prod["image"] or service.get("build", {}).get("context") != str(source):
        raise ReleaseError("effective AnyList image/build context changed")
    environment = service.get("environment") or {}
    if any(not environment.get(key) for key in prod["required_environment_keys"]):
        raise ReleaseError("required effective environment is missing")
    if environment.get("BASE_URL") != prod["public_base_url"]:
        raise ReleaseError("effective AnyList BASE_URL changed")
    volume_names = {key: value.get("name") for key, value in (config.get("volumes") or {}).items()}
    if prod["volume_name"] not in volume_names.values():
        raise ReleaseError("effective Compose data volume changed")

    env_file = Path(prod["environment_file"])
    allowlist = Path(prod["allowlist_path"])
    if not env_file.is_file() or stat.S_IMODE(env_file.stat().st_mode) != 0o600:
        raise ReleaseError("AnyList environment file is missing or not mode 600")
    if not allowlist.is_file():
        raise ReleaseError("AnyList allowlist file is missing")

    run(["git", "-C", str(source), "bundle", "verify", str(BUNDLE_PATH)])
    container_id = run(compose(prod, "ps", "-q", "anylist-mcp"), cwd=cwd)
    if not container_id:
        raise ReleaseError("AnyList container is not running")
    container = inspect_container(prod, container_id)
    assert_container(container, prod)
    schema = oauth_client_columns(container_id)
    if schema not in allowed_oauth_client_schemas(spec):
        raise ReleaseError("production oauth_clients schema is not an approved release schema")
    if http_json(f"{prod['local_base_url']}/health").get("status") != "ok":
        raise ReleaseError("local AnyList health failed")
    if http_json(f"{prod['public_base_url']}/health").get("status") != "ok":
        raise ReleaseError("public AnyList health failed")

    return {
        "candidate_commit": manifest["candidate_commit"],
        "source": {"branch": base["branch"], "commit": base["commit"], "origin": base["origin"]},
        "container": container,
        "metadata": metadata_counts(container_id),
        "database_integrity": database_integrity(container_id),
        "oauth_client_columns": schema,
        "environment_file": fingerprint(env_file),
        "allowlist_file": fingerprint(allowlist),
        "compose_file": fingerprint(Path(prod["compose_file"])),
        "other_service_ids": service_ids(prod),
        "checked_at": int(time.time()),
    }


def state_root(candidate: str) -> Path:
    return Path.home() / ".local" / "state" / "anylist-mcp" / "releases" / candidate


def incident_report_path(candidate: str) -> Path:
    return Path.home() / ".local" / "state" / "anylist-mcp" / "incidents" / f"{candidate}.json"


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def update_status(directory: Path, phase: str, **extra: object) -> None:
    path = directory / "status.json"
    value = load_json(path) if path.exists() else {}
    value.update({"phase": phase, "updated_at": int(time.time()), **extra})
    write_json(path, value)


def verify_unchanged_files(snapshot: dict) -> None:
    for key in ("environment_file", "allowlist_file", "compose_file"):
        current = fingerprint(Path(snapshot[key]["path"]))
        if current != snapshot[key]:
            raise ReleaseError(f"protected deployment file changed: {key}")


def image_snapshot(reference: str) -> dict:
    raw = json.loads(run(["docker", "image", "inspect", reference]))[0]
    return {
        "id": raw["Id"],
        "tags": sorted(raw.get("RepoTags") or []),
        "release_commit": (raw.get("Config", {}).get("Labels") or {}).get(
            "io.vector72.release.commit"
        ),
    }


def reconcile_state_files(directory: Path) -> list[Path]:
    if not directory.is_dir() or directory.is_symlink():
        raise ReleaseError("release state directory is missing or unsafe")
    files = list(directory.iterdir())
    if any(path.is_symlink() or not path.is_file() for path in files):
        raise ReleaseError("release state contains a symlink or non-file entry")
    names = {path.name for path in files}
    required = {"snapshot.json", "status.json", "release-manifest.json", "source-before.bundle"}
    if not required.issubset(names) or not names.issubset(RECONCILE_STATE_FILES):
        raise ReleaseError("release state file set is not recognized")
    return sorted(files, key=lambda path: path.name)


def reconcile_rollback(spec: dict, candidate: str, *, execute: bool = False) -> dict:
    """Certify an already-restored incident, then optionally remove exact residue."""
    directory = state_root(candidate)
    expected_directory = (
        Path.home() / ".local" / "state" / "anylist-mcp" / "releases" / candidate
    )
    if directory != expected_directory or directory.name != candidate:
        raise ReleaseError("release state path is not exact")
    files = reconcile_state_files(directory)
    snapshot = load_json(directory / "snapshot.json")
    status = load_json(directory / "status.json")
    state_manifest = load_json(directory / "release-manifest.json")
    if snapshot.get("candidate_commit") != candidate or status.get("candidate") != candidate:
        raise ReleaseError("incident candidate identity is inconsistent")
    if state_manifest.get("candidate_commit") != candidate:
        raise ReleaseError("incident release manifest identity is inconsistent")
    if status.get("phase") not in {"verification_failed", "rolled_back"}:
        raise ReleaseError("incident is not in a reconcilable rollback phase")

    prod = spec["production"]
    baseline = spec["expected_baseline"]
    source = Path(prod["source_directory"])
    cwd = Path(prod["compose_directory"])
    if snapshot.get("source") != {
        "branch": baseline["branch"], "commit": baseline["commit"], "origin": baseline["origin"],
    }:
        raise ReleaseError("source checkpoint does not match the release specification")
    protected_paths = {
        "environment_file": prod["environment_file"],
        "allowlist_file": prod["allowlist_path"],
        "compose_file": prod["compose_file"],
    }
    if any(snapshot.get(key, {}).get("path") != value for key, value in protected_paths.items()):
        raise ReleaseError("protected-file checkpoint paths are not exact")
    before_status = git(source, "status", "--porcelain=v1", "--untracked-files=all")
    if before_status or git(source, "rev-parse", "HEAD") != snapshot["source"]["commit"]:
        raise ReleaseError("source is not at the clean rollback checkpoint")
    if git(source, "symbolic-ref", "--short", "HEAD") != snapshot["source"]["branch"]:
        raise ReleaseError("source rollback branch is not exact")
    if git(source, "remote", "get-url", "origin") != snapshot["source"]["origin"]:
        raise ReleaseError("source rollback origin is not exact")

    current_id = run(compose(prod, "ps", "-q", "anylist-mcp"), cwd=cwd)
    current = inspect_container(prod, current_id)
    assert_container(current, prod, expected_image_id=snapshot["container"]["image_id"])
    if current["mounts"] != snapshot["container"]["mounts"]:
        raise ReleaseError("runtime mounts differ from rollback checkpoint")
    if (current["environment_sha256"] != snapshot["container"]["environment_sha256"] or
            current["networks"] != snapshot["container"]["networks"]):
        raise ReleaseError("runtime environment or networks differ from rollback checkpoint")
    verify_unchanged_files(snapshot)
    if service_ids(prod) != snapshot["other_service_ids"] or len(snapshot["other_service_ids"]) != 5:
        raise ReleaseError("peer service IDs differ from the five-service checkpoint")
    current_columns = oauth_client_columns(current_id)
    allowed_schemas = allowed_oauth_client_schemas(spec)
    if current_columns not in allowed_schemas:
        raise ReleaseError("database schema is not rollback-compatible")
    current_metadata = metadata_counts(current_id)
    assert_metadata_compatible(snapshot["metadata"], current_metadata)
    integrity = database_integrity(current_id)
    if http_json(f"{prod['local_base_url']}/health").get("status") != "ok":
        raise ReleaseError("local AnyList health failed during reconciliation")
    wait_for_public_health(prod["public_base_url"])

    candidate_tag = f"anylist-mcp:candidate-{candidate[:12]}"
    rollback_tag = f"anylist-mcp:rollback-{candidate[:12]}"
    if status.get("rollback_tag") != rollback_tag:
        raise ReleaseError("rollback tag identity is inconsistent")
    candidate_image = image_snapshot(candidate_tag)
    rollback_image = image_snapshot(rollback_tag)
    if candidate_image["id"] != status.get("candidate_image"):
        raise ReleaseError("candidate tag does not reference the checkpointed candidate image")
    if candidate_image["release_commit"] != candidate or candidate_image["tags"] != [candidate_tag]:
        raise ReleaseError("candidate image label or tag set is not exact")
    if rollback_image["id"] != snapshot["container"]["image_id"]:
        raise ReleaseError("rollback tag does not reference the original image")
    if image_snapshot(prod["image"])["id"] != snapshot["container"]["image_id"]:
        raise ReleaseError("production image tag is not restored")
    referencing = run([
        "docker", "ps", "-aq", "--filter", f"ancestor={candidate_image['id']}",
    ]).splitlines()
    if referencing:
        raise ReleaseError("a container still references the candidate image")
    release_ref = f"refs/anylist-releases/{candidate}"
    if git(source, "rev-parse", "--verify", release_ref) != candidate:
        raise ReleaseError("release Git ref is not exact")
    run(["git", "-C", str(source), "bundle", "verify", str(directory / "source-before.bundle")])
    if snapshot["source"]["commit"] not in run([
        "git", "bundle", "list-heads", str(directory / "source-before.bundle"),
    ]):
        raise ReleaseError("source checkpoint bundle does not advertise the baseline commit")

    proof = {
        "schema_version": 1,
        "candidate_commit": candidate,
        "checked_at": int(time.time()),
        "source_commit": snapshot["source"]["commit"],
        "runtime_image": current["image_id"],
        "container_healthy": current["health"] == "healthy",
        "volume_name": prod["volume_name"],
        "peer_service_count": len(snapshot["other_service_ids"]),
        "nonvolatile_metadata": nonvolatile_metadata(current_metadata),
        "oauth_tokens_observed": current_metadata["oauth_tokens"],
        "database_integrity": integrity,
        "state_files": {path.name: sha256(path) for path in files},
        "planned_removals": {
            "candidate_tag": candidate_tag,
            "candidate_image": candidate_image["id"],
            "rollback_tag": rollback_tag,
            "release_ref": release_ref,
            "state_directory": str(directory),
        },
        "executed": False,
    }
    if not execute:
        return proof

    report = incident_report_path(candidate)
    if report.exists() or report.is_symlink():
        raise ReleaseError(f"incident report already exists: {report}")
    if report.parent.exists() and (not report.parent.is_dir() or report.parent.is_symlink()):
        raise ReleaseError("incident report directory is unsafe")
    report.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(report.parent, 0o700)
    write_json(report, proof)
    run(["docker", "image", "rm", candidate_tag])
    run(["docker", "image", "rm", rollback_tag])
    git(source, "update-ref", "-d", release_ref, candidate)
    for path in files:
        path.unlink()
    directory.rmdir()
    if command_succeeds(["docker", "image", "inspect", candidate_tag]) or command_succeeds([
        "docker", "image", "inspect", candidate_image["id"],
    ]):
        raise ReleaseError("candidate image residue remains after reconciliation")
    if command_succeeds(["docker", "image", "inspect", rollback_tag]):
        raise ReleaseError("rollback tag remains after reconciliation")
    if command_succeeds(["git", "-C", str(source), "show-ref", "--verify", release_ref]):
        raise ReleaseError("release Git ref remains after reconciliation")
    if directory.exists() or directory.is_symlink():
        raise ReleaseError("active release state remains after reconciliation")
    if image_snapshot(prod["image"])["id"] != snapshot["container"]["image_id"]:
        raise ReleaseError("production image changed during reconciliation")
    proof.update({"executed": True, "completed_at": int(time.time()), "report": str(report)})
    write_json(report, proof)
    emit(f"rollback incident reconciled; report: {report}")
    return proof


def candidate_smoke(prod: dict, candidate_tag: str, directory: Path) -> dict:
    override = directory / "candidate.override.yaml"
    override.write_text(f'''services:
  anylist-mcp:
    image: {candidate_tag}
    volumes:
      - type: volume
        source: anylist-release-data
        target: /data
        read_only: true
volumes:
  anylist-release-data:
    external: true
    name: {prod["volume_name"]}
''', encoding="utf-8")
    os.chmod(override, 0o600)
    effective = json.loads(run([
        "docker", "compose", "-f", prod["compose_file"], "-f", str(override),
        "config", "--format", "json",
    ], cwd=Path(prod["compose_directory"])))
    mounts = effective["services"]["anylist-mcp"].get("volumes") or []
    data_mount = [item for item in mounts if item.get("target") == prod["volume_target"]]
    if len(data_mount) != 1 or data_mount[0].get("read_only") is not True:
        raise ReleaseError("candidate smoke data volume is not read-only")
    volume_key = data_mount[0].get("source")
    if effective.get("volumes", {}).get(volume_key, {}).get("name") != prod["volume_name"]:
        raise ReleaseError("candidate smoke resolved an unexpected data volume")
    output = run([
        "docker", "compose", "-f", prod["compose_file"], "-f", str(override),
        "run", "--rm", "--no-deps", "-T", "--entrypoint", "node",
        "anylist-mcp", "/app/scripts/read-only-production-smoke.js",
    ], cwd=Path(prod["compose_directory"]))
    value = json.loads(output.splitlines()[-1])
    if value.get("ok") is not True or value.get("protocol", {}).get("authenticated") is not True:
        raise ReleaseError("candidate read-only AnyList protocol smoke failed")
    return value


def migration_contract_smoke(spec: dict, candidate_tag: str, rollback_image: str) -> dict:
    """Migrate a consistent production DB copy, then open it with the old image."""
    prod = spec["production"]
    volume = f"anylist-release-migration-{secrets.token_hex(8)}"
    copy_code = r'''
import Database from "better-sqlite3";
const source = new Database("/source/anylist-mcp.db", {readonly:true, fileMustExist:true});
await source.backup("/target/anylist-mcp.db");
source.close();
'''
    inspect_code = r'''
const module = await import("/app/src/http/db.js");
const db = module.getDb();
const columns = db.prepare("PRAGMA table_info(oauth_clients)").all().map(row => row.name);
const counts = {
  users:Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count),
  credential_records:Number(db.prepare("SELECT COUNT(*) AS count FROM anylist_credentials").get().count),
  oauth_clients:Number(db.prepare("SELECT COUNT(*) AS count FROM oauth_clients").get().count),
  public_oauth_clients:Number(db.prepare("SELECT COUNT(*) AS count FROM oauth_clients WHERE client_secret_hash IS NULL").get().count),
  confidential_oauth_clients:Number(db.prepare("SELECT COUNT(*) AS count FROM oauth_clients WHERE client_secret_hash IS NOT NULL").get().count),
  oauth_tokens:Number(db.prepare("SELECT COUNT(*) AS count FROM oauth_tokens").get().count)
};
process.stdout.write(JSON.stringify({columns, counts}));
'''
    created = False
    failure: Exception | None = None
    try:
        run(["docker", "volume", "create", "--label", "io.vector72.release=anylist-migration-smoke", volume])
        created = True
        run([
            "docker", "run", "--rm", "--network", "none",
            "--mount", f"type=volume,src={prod['volume_name']},dst=/source,readonly",
            "--mount", f"type=volume,src={volume},dst=/target",
            candidate_tag, "node", "--input-type=module", "-e", copy_code,
        ])
        candidate = json.loads(run([
            "docker", "run", "--rm", "--network", "none",
            "--mount", f"type=volume,src={volume},dst=/data",
            candidate_tag, "node", "--input-type=module", "-e", inspect_code,
        ]))
        if candidate.get("columns") != spec["candidate_schema"]["oauth_client_columns"]:
            raise ReleaseError("candidate migration did not produce the expected schema")
        rollback = json.loads(run([
            "docker", "run", "--rm", "--network", "none",
            "--mount", f"type=volume,src={volume},dst=/data",
            rollback_image, "node", "--input-type=module", "-e", inspect_code,
        ]))
        if rollback != candidate:
            raise ReleaseError("rollback image is not compatible with the migrated schema")
        return {"candidate": candidate, "rollback": rollback}
    except Exception as exc:
        failure = exc
        raise
    finally:
        if created:
            cleanup = subprocess.run(
                ["docker", "volume", "rm", volume], text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            if cleanup.returncode:
                if failure is None:
                    raise ReleaseError("could not remove the isolated migration-smoke volume")
                emit("warning: isolated migration-smoke volume cleanup needs attention")


def oauth_boundary_checks(prod: dict) -> None:
    base = prod["public_base_url"]
    auth = http_json(f"{base}/.well-known/oauth-authorization-server")
    protected = http_json(f"{base}/.well-known/oauth-protected-resource/mcp")
    if auth.get("registration_endpoint") != f"{base}/oauth/register":
        raise ReleaseError("OAuth registration metadata is incorrect")
    if "S256" not in auth.get("code_challenge_methods_supported", []):
        raise ReleaseError("OAuth metadata does not require S256 capability")
    if base not in protected.get("authorization_servers", []):
        raise ReleaseError("protected-resource metadata is incorrect")
    initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "release-probe", "version": "1"}}}
    if http_status(f"{base}/mcp", initialize) != 401:
        raise ReleaseError("unauthenticated MCP request did not return 401")
    bad_dcr = {"redirect_uris": ["https://invalid.example/callback"],
               "token_endpoint_auth_method": "none", "grant_types": ["authorization_code"],
               "response_types": ["code"], "client_name": "release-rejection-probe"}
    if http_status(f"{base}/oauth/register", bad_dcr) != 400:
        raise ReleaseError("unallowlisted OAuth DCR was not rejected")


def rollback(spec: dict, directory: Path, *, automatic: bool = False) -> None:
    snapshot = load_json(directory / "snapshot.json")
    status = load_json(directory / "status.json")
    prod = spec["production"]
    source = Path(prod["source_directory"])
    cwd = Path(prod["compose_directory"])
    if snapshot.get("candidate_commit") != directory.name:
        raise ReleaseError("release-state candidate identity is inconsistent")
    emit("restoring source and image checkpoints")
    run(["docker", "image", "tag", snapshot["container"]["image_id"], prod["image"]])
    git(source, "switch", snapshot["source"]["branch"])
    if git(source, "rev-parse", "HEAD") != snapshot["source"]["commit"] or git(source, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ReleaseError("source checkpoint could not be restored exactly")
    phases_requiring_recreate = {"runtime_recreate_attempted", "deployed", "verification_failed"}
    effective_phase = status.get("failed_from", status.get("phase"))
    if effective_phase in phases_requiring_recreate:
        run(compose(prod, "up", "-d", "--no-deps", "--no-build", "--force-recreate", "anylist-mcp"), cwd=cwd)
        wait_for_health(prod["local_base_url"])
    current_id = run(compose(prod, "ps", "-q", "anylist-mcp"), cwd=cwd)
    current = inspect_container(prod, current_id)
    assert_container(current, prod, expected_image_id=snapshot["container"]["image_id"])
    if current["environment_sha256"] != snapshot["container"]["environment_sha256"] or current["networks"] != snapshot["container"]["networks"]:
        raise ReleaseError("container environment or network checkpoint was not restored")
    verify_unchanged_files(snapshot)
    current_columns = oauth_client_columns(current_id)
    allowed_schemas = allowed_oauth_client_schemas(spec)
    if current_columns not in allowed_schemas:
        raise ReleaseError("database schema is not rollback-compatible")
    assert_metadata_compatible(snapshot["metadata"], metadata_counts(current_id))
    database_integrity(current_id)
    wait_for_public_health(prod["public_base_url"])
    if service_ids(prod) != snapshot["other_service_ids"]:
        raise ReleaseError("a non-AnyList service changed during rollback")
    update_status(directory, "rolled_back", automatic=automatic)
    emit("rollback verified")


def deploy(manifest: dict, spec: dict, backup_id: str, backup_digest: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{8,128}", backup_id):
        raise ReleaseError("backup ID is not valid")
    if not re.fullmatch(r"[0-9a-f]{64}", backup_digest):
        raise ReleaseError("backup SHA-256 is not exact lowercase hex")
    snapshot = preflight(manifest, spec)
    prod = spec["production"]
    source = Path(prod["source_directory"])
    cwd = Path(prod["compose_directory"])
    candidate = manifest["candidate_commit"]
    directory = state_root(candidate)
    if directory.exists():
        raise ReleaseError(f"release state already exists: {directory}")
    directory.mkdir(parents=True, mode=0o700)
    os.chmod(directory, 0o700)
    snapshot["backup"] = {"id": backup_id, "sha256": backup_digest}
    write_json(directory / "snapshot.json", snapshot)
    shutil.copy2(MANIFEST_PATH, directory / "release-manifest.json")
    os.chmod(directory / "release-manifest.json", 0o600)
    git(source, "bundle", "create", str(directory / "source-before.bundle"), "HEAD")
    os.chmod(directory / "source-before.bundle", 0o600)
    rollback_tag = f"anylist-mcp:rollback-{candidate[:12]}"
    candidate_tag = f"anylist-mcp:candidate-{candidate[:12]}"
    run(["docker", "image", "tag", snapshot["container"]["image_id"], rollback_tag])
    update_status(directory, "checkpointed", candidate=candidate, rollback_tag=rollback_tag)

    try:
        emit("loading the digest-verified candidate into the production checkout")
        git(source, "fetch", str(BUNDLE_PATH), f"{candidate}:refs/anylist-releases/{candidate}")
        git(source, "switch", "--detach", candidate)
        if git(source, "rev-parse", "HEAD") != candidate or git(source, "status", "--porcelain=v1", "--untracked-files=all"):
            raise ReleaseError("candidate source checkout is not exact and clean")
        base = spec["expected_baseline"]
        submodule = git(source, "submodule", "status", base["submodule_path"])
        if not submodule_is_exact(submodule, base["submodule_commit"]):
            raise ReleaseError("candidate submodule checkout changed")
        update_status(directory, "source_switched")

        emit("building isolated candidate image")
        run(["docker", "build", "--label", f"io.vector72.release.commit={candidate}",
             "--tag", candidate_tag, "."], cwd=source)
        candidate_image = run(["docker", "image", "inspect", "--format", "{{.Id}}", candidate_tag])
        update_status(directory, "candidate_built", candidate_image=candidate_image)

        emit("running read-only authenticated AnyList protocol smoke")
        smoke = candidate_smoke(prod, candidate_tag, directory)
        if nonvolatile_metadata(smoke["metadata"]) != nonvolatile_metadata(snapshot["metadata"]):
            raise ReleaseError("candidate observed changed account/OAuth metadata counts")
        write_json(directory / "candidate-smoke.json", smoke)
        migration_smoke = migration_contract_smoke(
            spec, candidate_tag, snapshot["container"]["image_id"],
        )
        if nonvolatile_metadata(migration_smoke["candidate"]["counts"]) != nonvolatile_metadata(snapshot["metadata"]):
            raise ReleaseError("isolated candidate migration changed account/OAuth metadata counts")
        write_json(directory / "migration-smoke.json", migration_smoke)
        verify_unchanged_files(snapshot)
        if service_ids(prod) != snapshot["other_service_ids"]:
            raise ReleaseError("a non-AnyList service changed during candidate validation")

        run(["docker", "image", "tag", candidate_image, prod["image"]])
        update_status(directory, "tag_switched")
        update_status(directory, "runtime_recreate_attempted")
        emit("recreating only the AnyList service")
        run(compose(prod, "up", "-d", "--no-deps", "--no-build", "--force-recreate", "anylist-mcp"), cwd=cwd)
        wait_for_health(prod["local_base_url"])
        wait_for_public_health(prod["public_base_url"])

        current_id = run(compose(prod, "ps", "-q", "anylist-mcp"), cwd=cwd)
        current = inspect_container(prod, current_id)
        assert_container(current, prod, expected_image_id=candidate_image)
        if current["environment_sha256"] != snapshot["container"]["environment_sha256"] or current["networks"] != snapshot["container"]["networks"]:
            raise ReleaseError("deployed container environment or networks changed")
        output = run(["docker", "exec", current_id, "node", "/app/scripts/read-only-production-smoke.js"])
        post_smoke = json.loads(output.splitlines()[-1])
        if post_smoke.get("ok") is not True:
            raise ReleaseError("deployed protocol smoke or metadata-count preservation failed")
        assert_metadata_compatible(snapshot["metadata"], post_smoke["metadata"])
        if oauth_client_columns(current_id) != spec["candidate_schema"]["oauth_client_columns"]:
            raise ReleaseError("deployed oauth_clients schema is not the expected candidate schema")
        oauth_boundary_checks(prod)
        if nonvolatile_metadata(metadata_counts(current_id)) != nonvolatile_metadata(snapshot["metadata"]):
            raise ReleaseError("OAuth boundary checks changed account/OAuth metadata counts")
        database_integrity(current_id)
        verify_unchanged_files(snapshot)
        if service_ids(prod) != snapshot["other_service_ids"]:
            raise ReleaseError("a non-AnyList service changed during deployment")
        write_json(directory / "deployed-smoke.json", post_smoke)
        update_status(directory, "deployed", container_id=current_id, image_id=candidate_image)
        emit(f"deployment verified; state: {directory}")
    except Exception:
        try:
            failed_from = load_json(directory / "status.json").get("phase")
            update_status(directory, "verification_failed", failed_from=failed_from)
            rollback(spec, directory, automatic=True)
        except Exception as rollback_error:
            emit(f"AUTOMATIC ROLLBACK NEEDS OPERATOR ATTENTION: {type(rollback_error).__name__}")
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("preflight")
    deploy_parser = sub.add_parser("deploy")
    deploy_parser.add_argument("--backup-id", required=True)
    deploy_parser.add_argument("--backup-sha256", required=True)
    rollback_parser = sub.add_parser("rollback")
    rollback_parser.add_argument("--candidate", required=True)
    reconcile_parser = sub.add_parser("reconcile-rollback")
    reconcile_parser.add_argument("--candidate", required=True)
    reconcile_parser.add_argument(
        "--execute", action="store_true",
        help="perform the exact cleanup after all read-only proofs pass; default is dry-run",
    )
    args = parser.parse_args()

    try:
        manifest, spec = validate_artifact()
        if args.command == "preflight":
            snapshot = preflight(manifest, spec)
            print(json.dumps({
                "ok": True, "candidate_commit": manifest["candidate_commit"],
                "baseline_commit": snapshot["source"]["commit"],
                "container_healthy": snapshot["container"]["health"] == "healthy",
                "metadata_counts": snapshot["metadata"],
                "other_services_observed": len(snapshot["other_service_ids"]),
            }, sort_keys=True))
        elif args.command == "deploy":
            deploy(manifest, spec, args.backup_id, args.backup_sha256)
        elif args.command == "rollback":
            if not HEX40.fullmatch(args.candidate):
                raise ReleaseError("candidate must be an exact commit")
            if args.candidate != manifest["candidate_commit"]:
                raise ReleaseError("rollback candidate does not match this artifact")
            rollback(spec, state_root(args.candidate))
        else:
            if not HEX40.fullmatch(args.candidate):
                raise ReleaseError("candidate must be an exact commit")
            proof = reconcile_rollback(spec, args.candidate, execute=args.execute)
            print(json.dumps({
                "ok": True,
                "candidate_commit": args.candidate,
                "dry_run": not args.execute,
                "container_healthy": proof["container_healthy"],
                "peer_service_count": proof["peer_service_count"],
                "nonvolatile_metadata": proof["nonvolatile_metadata"],
                "oauth_tokens_observed": proof["oauth_tokens_observed"],
                "planned_removals": proof["planned_removals"],
                "executed": proof["executed"],
            }, sort_keys=True))
        return 0
    except (ReleaseError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"[anylist-release] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
