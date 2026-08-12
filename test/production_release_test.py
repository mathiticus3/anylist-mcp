import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
DEPLOY_PATH = ROOT / "infra" / "production" / "deploy_anylist.py"
SPEC_PATH = ROOT / "infra" / "production" / "release-spec.json"

spec = importlib.util.spec_from_file_location("deploy_anylist", DEPLOY_PATH)
deploy_anylist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy_anylist)


class ProductionReleaseTests(unittest.TestCase):
    def test_release_spec_is_exactly_scoped_to_live_anylist(self):
        release = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
        self.assertEqual(release["expected_baseline"]["commit"], "714ec5cba171af4cb18628c603d1bd36e9a0d199")
        self.assertEqual(release["production"]["source_directory"], "/home/deploy/web-caddy/anylist-upstream")
        self.assertEqual(release["production"]["volume_name"], "web-caddy_anylist-mcp-data")
        self.assertEqual(release["production"]["container_name"], "anylist-mcp")

    def test_compose_mutation_is_service_scoped(self):
        prod = {"compose_file": "/srv/docker-compose.yml"}
        command = deploy_anylist.compose(
            prod, "up", "-d", "--no-deps", "--no-build", "--force-recreate", "anylist-mcp"
        )
        self.assertEqual(command[-1], "anylist-mcp")
        self.assertIn("--no-deps", command)
        self.assertIn("--no-build", command)
        self.assertNotIn("down", command)

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
        self.assertNotIn('docker", "volume", "rm', source)


if __name__ == "__main__":
    unittest.main()
