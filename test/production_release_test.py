import importlib.util
import inspect
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
DEPLOY_PATH = ROOT / "infra" / "production" / "deploy_anylist.py"
BUILD_PATH = ROOT / "infra" / "production" / "build_release.py"
SPEC_PATH = ROOT / "infra" / "production" / "release-spec.json"

spec = importlib.util.spec_from_file_location("deploy_anylist", DEPLOY_PATH)
deploy_anylist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy_anylist)
build_spec = importlib.util.spec_from_file_location("build_release", BUILD_PATH)
build_release = importlib.util.module_from_spec(build_spec)
build_spec.loader.exec_module(build_release)


class ProductionReleaseTests(unittest.TestCase):
    def test_release_spec_is_exactly_scoped_to_live_anylist(self):
        release = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
        self.assertEqual(release["expected_baseline"]["commit"], "714ec5cba171af4cb18628c603d1bd36e9a0d199")
        self.assertEqual(release["production"]["source_directory"], "/home/deploy/web-caddy/anylist-upstream")
        self.assertEqual(release["production"]["volume_name"], "web-caddy_anylist-mcp-data")
        self.assertEqual(release["production"]["container_name"], "anylist-mcp")
        self.assertEqual(release["expected_baseline"]["oauth_client_columns"], [
            "client_id", "redirect_uri", "created_at", "client_secret_hash", "user_id", "client_name",
        ])
        self.assertEqual(release["candidate_schema"]["oauth_client_columns"][-2:], ["profile", "source"])

    def test_exact_baseline_code_accepts_candidate_migrated_live_schema(self):
        release = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
        baseline = release["expected_baseline"]
        with tempfile.TemporaryDirectory(dir=ROOT) as directory_name:
            directory = Path(directory_name)
            data = directory / "data"
            data.mkdir()
            db_path = data / "anylist-mcp.db"
            db = sqlite3.connect(db_path)
            try:
                db.executescript("""
                  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
                    pw_hash TEXT, google_sub TEXT UNIQUE, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
                  CREATE TABLE anylist_credentials (user_id TEXT PRIMARY KEY REFERENCES users(id),
                    encrypted_user TEXT NOT NULL, encrypted_pass TEXT NOT NULL, default_list TEXT,
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
                  CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, redirect_uri TEXT,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch()), client_secret_hash TEXT,
                    user_id TEXT REFERENCES users(id), client_name TEXT);
                  CREATE TABLE oauth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id), redirect_uri TEXT NOT NULL,
                    code_challenge TEXT, challenge_method TEXT, scope TEXT, expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch()));
                  CREATE TABLE oauth_tokens (access_token TEXT PRIMARY KEY, refresh_token TEXT UNIQUE NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL, scope TEXT,
                    expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch()));
                  INSERT INTO users(id,email) VALUES ('user-1','fixture@example.invalid');
                  INSERT INTO oauth_clients(client_id,redirect_uri,user_id,client_name)
                    VALUES ('existing','https://example.invalid/callback','user-1','Existing');
                """)
                db.commit()
            finally:
                db.close()
            baseline_db = directory / "baseline-db.mjs"
            baseline_source = subprocess.run(
                ["git", "show", f"{baseline['commit']}:src/http/db.js"], cwd=ROOT,
                check=True, text=True, stdout=subprocess.PIPE,
            ).stdout
            baseline_db.write_text(baseline_source, encoding="utf-8")
            node_code = """
import { pathToFileURL } from 'url';
const module = await import(pathToFileURL(process.argv[1]));
const db = module.getDb();
if (process.argv[2] === 'rollback') {
  module.registerOAuthClient({clientId:'rollback-client', redirectUri:'https://example.invalid/rollback'});
}
const columns=db.prepare('PRAGMA table_info(oauth_clients)').all().map(row=>row.name);
const count=Number(db.prepare('SELECT COUNT(*) AS count FROM oauth_clients').get().count);
db.close();
process.stdout.write(JSON.stringify({columns,count}));
"""
            env = os.environ.copy()
            env.pop("NODE_EXTRA_CA_CERTS", None)
            env["DATA_DIR"] = str(data)
            candidate = subprocess.run(
                ["node", "--input-type=module", "-e", node_code,
                 str(ROOT / "src" / "http" / "db.js"), "candidate"],
                cwd=ROOT, env=env, check=True, text=True, stdout=subprocess.PIPE,
            )
            rollback = subprocess.run(
                ["node", "--input-type=module", "-e", node_code, str(baseline_db), "rollback"],
                cwd=ROOT, env=env, check=True, text=True, stdout=subprocess.PIPE,
            )
            candidate_result = json.loads(candidate.stdout)
            rollback_result = json.loads(rollback.stdout)
            self.assertEqual(candidate_result["columns"], release["candidate_schema"]["oauth_client_columns"])
            self.assertEqual(rollback_result["columns"], candidate_result["columns"])
            self.assertEqual(rollback_result["count"], candidate_result["count"] + 1)

    def test_preflight_schema_allowlist_is_exact(self):
        release = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
        allowed = deploy_anylist.allowed_oauth_client_schemas(release)
        self.assertEqual(allowed, [
            release["expected_baseline"]["oauth_client_columns"],
            release["candidate_schema"]["oauth_client_columns"],
        ])
        self.assertNotIn(allowed[-1] + ["unexpected"], allowed)

    def test_compose_mutation_is_service_scoped(self):
        prod = {"compose_file": "/srv/docker-compose.yml"}
        command = deploy_anylist.compose(
            prod, "up", "-d", "--no-deps", "--no-build", "--force-recreate", "anylist-mcp"
        )
        self.assertEqual(command[-1], "anylist-mcp")
        self.assertIn("--no-deps", command)
        self.assertIn("--no-build", command)
        self.assertNotIn("down", command)

    def test_concurrent_token_issuance_does_not_mask_identity_drift(self):
        baseline = {
            "users": 1, "credential_records": 1, "oauth_clients": 6,
            "public_oauth_clients": 4, "confidential_oauth_clients": 2,
            "oauth_tokens": 2572,
        }
        concurrent_refresh = {**baseline, "oauth_tokens": 2573}
        deploy_anylist.assert_metadata_compatible(baseline, concurrent_refresh)
        with self.assertRaises(deploy_anylist.ReleaseError):
            deploy_anylist.assert_metadata_compatible(
                baseline, {**concurrent_refresh, "oauth_clients": 7, "public_oauth_clients": 5},
            )

    def test_public_health_retries_transient_reset_then_succeeds(self):
        transient = deploy_anylist.ReleaseError("transport reset")
        transient.__cause__ = ConnectionResetError("peer reset")
        with patch.object(
            deploy_anylist, "http_json", side_effect=[transient, transient, {"status": "ok"}],
        ) as health, patch.object(deploy_anylist.time, "monotonic", side_effect=[0, 1, 2]), \
                patch.object(deploy_anylist.time, "sleep") as sleep:
            deploy_anylist.wait_for_public_health("https://anylist.example", timeout_seconds=10)
        self.assertEqual(health.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_public_health_does_not_retry_bad_payload(self):
        with patch.object(deploy_anylist, "http_json", return_value={"status": "wrong"}) as health, \
                patch.object(deploy_anylist.time, "monotonic", return_value=0), \
                patch.object(deploy_anylist.time, "sleep") as sleep:
            with self.assertRaises(deploy_anylist.ReleaseError):
                deploy_anylist.wait_for_public_health("https://anylist.example", timeout_seconds=10)
        health.assert_called_once()
        sleep.assert_not_called()

    def test_recreate_verification_polls_through_healthcheck_warmup(self):
        prod = {"container_name": "anylist-mcp"}
        health_config = json.dumps([{"Config": {"Healthcheck": {
            "Interval": 30_000_000_000, "Timeout": 5_000_000_000, "Retries": 3,
        }}}])
        warming = {"running": True, "health": "starting"}
        healthy = {"running": True, "health": "healthy"}
        with patch.object(deploy_anylist, "run", return_value=health_config), \
                patch.object(deploy_anylist, "inspect_container",
                             side_effect=[warming, warming, healthy]) as container, \
                patch.object(deploy_anylist.time, "monotonic", side_effect=[0, 1, 2]), \
                patch.object(deploy_anylist.time, "sleep") as sleep:
            result = deploy_anylist.wait_for_container_health(prod, "container-1")
        self.assertEqual(result, healthy)
        self.assertEqual(container.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        for name in ("deploy", "rollback"):
            source = inspect.getsource(getattr(deploy_anylist, name))
            self.assertIn("current = wait_for_container_health(prod, current_id)", source)
            self.assertNotIn("current = inspect_container(prod, current_id)", source)

    def test_recreate_verification_fails_only_on_terminal_verdict_or_deadline(self):
        prod = {"container_name": "anylist-mcp"}
        health_config = json.dumps([{"Config": {"Healthcheck": {"Interval": 30_000_000_000}}}])
        with patch.object(deploy_anylist, "run", return_value=health_config), \
                patch.object(deploy_anylist, "inspect_container",
                             return_value={"running": True, "health": "unhealthy"}), \
                patch.object(deploy_anylist.time, "monotonic", return_value=0), \
                patch.object(deploy_anylist.time, "sleep") as sleep:
            with self.assertRaises(deploy_anylist.ReleaseError):
                deploy_anylist.wait_for_container_health(prod, "container-1")
        sleep.assert_not_called()
        with patch.object(deploy_anylist, "run", return_value=health_config), \
                patch.object(deploy_anylist, "inspect_container",
                             return_value={"running": True, "health": "starting"}), \
                patch.object(deploy_anylist.time, "monotonic", side_effect=[0, 10_000]), \
                patch.object(deploy_anylist.time, "sleep") as sleep:
            with self.assertRaises(deploy_anylist.ReleaseError):
                deploy_anylist.wait_for_container_health(prod, "container-1")
        sleep.assert_not_called()

    def test_reconcile_mount_comparison_ignores_docker_report_order(self):
        data = {"type": "volume", "name": "web-caddy_anylist-mcp-data", "source": None,
                "destination": "/data", "rw": True}
        allowlist = {"type": "bind", "name": None,
                     "source": "/home/deploy/web-caddy/anylist-allowed-emails.txt",
                     "destination": "/config/allowed-emails.txt", "rw": False}
        self.assertEqual(deploy_anylist.canonical_mounts([data, allowlist]),
                         deploy_anylist.canonical_mounts([allowlist, data]))
        self.assertNotEqual(deploy_anylist.canonical_mounts([data, allowlist]),
                            deploy_anylist.canonical_mounts([data, {**allowlist, "rw": True}]))
        source = inspect.getsource(deploy_anylist.reconcile_rollback)
        self.assertIn(
            'canonical_mounts(current["mounts"]) != canonical_mounts(snapshot["container"]["mounts"])',
            source,
        )

    def test_reconcile_state_accepts_only_known_regular_files(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            for name in ("snapshot.json", "status.json", "release-manifest.json", "source-before.bundle"):
                (directory / name).write_text("fixture", encoding="utf-8")
            accepted = deploy_anylist.reconcile_state_files(directory)
            self.assertEqual({path.name for path in accepted}, {
                "snapshot.json", "status.json", "release-manifest.json", "source-before.bundle",
            })
            (directory / "unexpected.secret").write_text("fixture", encoding="utf-8")
            with self.assertRaises(deploy_anylist.ReleaseError):
                deploy_anylist.reconcile_state_files(directory)

    def test_reconcile_has_no_runtime_or_database_mutation(self):
        source = inspect.getsource(deploy_anylist.reconcile_rollback)
        self.assertNotIn('compose(prod, "up"', source)
        self.assertNotIn('"docker", "volume", "rm"', source)
        self.assertNotIn('git(source, "switch"', source)
        self.assertNotIn('docker", "exec"', source)
        self.assertIn('if not execute:', source)
        self.assertIn('run(["docker", "image", "rm", candidate_tag])', source)
        self.assertIn('run(["docker", "image", "rm", rollback_tag])', source)
        self.assertNotIn('run(["docker", "image", "rm", prod["image"]])', source)
        self.assertIn('git(source, "update-ref", "-d", release_ref, candidate)', source)

    def test_fingerprint_detects_content_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "protected"
            path.write_text("one", encoding="utf-8")
            before = deploy_anylist.fingerprint(path)
            path.write_text("two", encoding="utf-8")
            after = deploy_anylist.fingerprint(path)
            self.assertNotEqual(before["sha256"], after["sha256"])

    def test_deploy_source_contains_no_broad_compose_shutdown(self):
        source = DEPLOY_PATH.read_text(encoding="utf-8")
        self.assertNotIn('"down"', source)
        self.assertNotIn('systemctl', source)
        self.assertNotIn('["docker", "volume", "rm", prod["volume_name"]]', source)

    def test_checksum_sidecar_is_lf_only_for_linux_sha256sum(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "release.tar"
            checksum = Path(directory) / "release.tar.sha256"
            artifact.write_bytes(b"release")
            build_release.write_checksum(checksum, artifact)
            content = checksum.read_bytes()
            self.assertTrue(content.endswith(b"\n"))
            self.assertNotIn(b"\r", content)

    def test_submodule_gate_accepts_only_clean_exact_checkout(self):
        commit = "1d3c9816c4ecfc3b2d8c5c48dd35619b125381c3"
        clean = f"{commit} anylist-js (heads/master)"
        self.assertTrue(deploy_anylist.submodule_is_exact(clean, commit))
        self.assertFalse(deploy_anylist.submodule_is_exact(f"+{commit} anylist-js", commit))
        self.assertFalse(deploy_anylist.submodule_is_exact(f"-{commit} anylist-js", commit))
        self.assertFalse(deploy_anylist.submodule_is_exact(f"U{commit} anylist-js", commit))


if __name__ == "__main__":
    unittest.main()
