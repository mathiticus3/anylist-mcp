#!/usr/bin/env python3
"""Build a digest-gated AnyList release artifact from a clean Git commit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "infra" / "production" / "release-spec.json"
DEPLOY = ROOT / "infra" / "production" / "deploy_anylist.py"


def run(*args: str) -> str:
    result = subprocess.run(args, cwd=ROOT, check=True, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_clean_repository() -> str:
    if run("git", "status", "--porcelain=v1", "--untracked-files=all"):
        raise RuntimeError("release artifacts require a completely clean Git worktree")
    head = run("git", "rev-parse", "HEAD")
    if len(head) != 40:
        raise RuntimeError("could not resolve an exact candidate commit")
    return head


def add_file(archive: tarfile.TarFile, path: Path, name: str) -> None:
    info = archive.gettarinfo(str(path), name)
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = 0
    info.mode = 0o755 if name == "deploy_anylist.py" else 0o644
    with path.open("rb") as stream:
        archive.addfile(info, stream)


def build(output: Path) -> tuple[Path, Path]:
    candidate = require_clean_repository()
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    if run("git", "rev-parse", "HEAD:anylist-js") != spec["expected_baseline"]["submodule_commit"]:
        raise RuntimeError("candidate changed the production-pinned AnyList submodule")

    output.mkdir(parents=True, exist_ok=True)
    artifact = output / f"anylist-mcp-{candidate}.tar"
    digest_path = output / f"{artifact.name}.sha256"
    if artifact.exists() or digest_path.exists():
        raise RuntimeError(f"refusing to overwrite immutable artifact {artifact}")

    with tempfile.TemporaryDirectory(prefix="anylist-release-") as temp_name:
        temp = Path(temp_name)
        bundle = temp / "source.bundle"
        run("git", "bundle", "create", str(bundle), "HEAD")
        if candidate not in run("git", "bundle", "list-heads", str(bundle)):
            raise RuntimeError("candidate commit is missing from source bundle")

        components = {"source.bundle": bundle, "release-spec.json": SPEC, "deploy_anylist.py": DEPLOY}
        manifest_data = {
            "schema_version": 1,
            "service": "anylist-mcp",
            "candidate_commit": candidate,
            "candidate_version": json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"],
            "source_commit_time": int(run("git", "show", "-s", "--format=%ct", "HEAD")),
            "components": {
                name: {"sha256": sha256(path), "size": path.stat().st_size}
                for name, path in components.items()
            },
        }
        manifest = temp / "release-manifest.json"
        manifest.write_text(json.dumps(manifest_data, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        partial = artifact.with_suffix(".tar.partial")
        with tarfile.open(partial, "w", format=tarfile.PAX_FORMAT) as archive:
            add_file(archive, manifest, "release-manifest.json")
            for name in sorted(components):
                add_file(archive, components[name], name)
        os.replace(partial, artifact)

    digest_path.write_text(f"{sha256(artifact)}  {artifact.name}\n", encoding="ascii")
    return artifact, digest_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    artifact, digest = build(args.output.resolve())
    print(artifact)
    print(digest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
