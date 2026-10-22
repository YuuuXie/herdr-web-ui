import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from production import Production, atomic_json, digest, switch_link, verified_report


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ovis-personal-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = {
            "repository": str(self.root), "data_dir": str(self.root / "data"),
            "releases_dir": str(self.root / "releases"), "tool_path": "/usr/bin",
            "bun": "/fixture/bun", "port": 7318, "service": "fixture.service",
            "state_dir": str(self.root / "state"), "fallback_release": str(self.root / "fallback"),
        }
        self.app = Production(self.config)
        self.old = self.app.releases / ("a" * 40)
        self.new = self.app.releases / ("b" * 40)
        for release in [self.old, self.new]:
            release.mkdir(parents=True)
        switch_link(self.app.data / "current", self.old)
        self.report = {
            "status": "success", "verification": {"status": "verified"},
            "source": {"unchanged": True, "end": {
                "head": self.new.name, "trackedDiffSha256": hashlib.sha256(b"").hexdigest(),
                "untrackedFileCount": 0,
            }},
        }

    def deployment_mocks(self):
        self.app.receipt = Mock()
        self.app.json_get = Mock(return_value={"machines": []})
        self.app.machines = Mock(return_value=[])
        self.app.remote = Mock(return_value={"machines": []})
        self.app.run = Mock()
        self.app.git = Mock(side_effect=lambda *args, cwd=None: Path(cwd).name)
        self.app.wait_healthy = Mock()

    def test_report_requires_success_and_clean_unchanged_exact_revision(self):
        self.assertTrue(verified_report(self.report, self.new.name))
        for change in [
            {"status": "failed"}, {"verification": {"status": "unverified"}},
            {"source": {"unchanged": False}}, {"source": {"unchanged": True, "end": {}}},
        ]:
            report = {**copy.deepcopy(self.report), **change}
            self.assertFalse(verified_report(report, self.new.name))
        self.assertFalse(verified_report(self.report, self.old.name))
        self.report["source"]["end"]["untrackedFileCount"] = 1
        self.assertFalse(verified_report(self.report, self.new.name))

    def test_artifact_changes_cannot_be_promoted(self):
        artifact = self.new / "dist/index.html"
        artifact.parent.mkdir()
        artifact.write_text("verified")
        report = self.app.data / "report.json"
        atomic_json(report, self.report)
        atomic_json(self.app.data / "verified" / f"{self.new.name}.json", {
            "revision": self.new.name, "report": str(report), "artifacts": {"dist/index.html": digest(artifact)},
        })
        self.app.git = Mock(side_effect=[self.new.name, ""])
        self.app.receipt(self.new)
        artifact.write_text("changed")
        self.app.git = Mock(side_effect=[self.new.name, ""])
        with self.assertRaisesRegex(RuntimeError, "artifact changed"):
            self.app.receipt(self.new)

    def test_failed_staging_never_stops_current_service(self):
        self.deployment_mocks()
        self.app.remote.side_effect = [{"machines": [{"id": "fixture"}]}, RuntimeError("upload failed"), {}]
        with self.assertRaisesRegex(RuntimeError, "previous release was restored"):
            self.app.deploy(self.new)
        self.app.run.assert_not_called()
        self.assertEqual((self.app.data / "current").resolve(), self.old)

    def test_health_failure_restores_previous_pinned_build(self):
        self.deployment_mocks()
        self.app.wait_healthy.side_effect = [RuntimeError("unhealthy"), None]
        with self.assertRaisesRegex(RuntimeError, "previous release was restored"):
            self.app.deploy(self.new)
        self.assertEqual((self.app.data / "current").resolve(), self.old)
        self.assertEqual(self.app.wait_healthy.call_count, 2)
        self.assertFalse((self.app.data / "transaction.json").exists())

    def test_success_retains_previous_build_and_clears_transaction(self):
        self.deployment_mocks()
        self.app.deploy(self.new)
        self.assertEqual((self.app.data / "current").resolve(), self.new)
        self.assertEqual((self.app.data / "previous").resolve(), self.old)
        self.assertFalse((self.app.data / "transaction.json").exists())

    def test_recovery_uses_saved_roster_even_when_current_server_is_down(self):
        self.deployment_mocks()
        switch_link(self.app.data / "current", self.new)
        atomic_json(self.app.data / "transaction.json", {
            "previous": str(self.old), "candidate": str(self.new), "helper": str(self.new),
            "machines": [], "before": [], "local_stopped": True,
        })
        self.app.json_get.side_effect = OSError("server down")
        self.app.rollback()
        self.app.json_get.assert_not_called()
        self.app.machines.assert_not_called()
        self.assertEqual((self.app.data / "current").resolve(), self.old)

    def test_remote_failure_restores_local_and_other_hosts_and_keeps_original_journal(self):
        self.deployment_mocks()
        switch_link(self.app.data / "current", self.new)
        saved = {"previous": str(self.old), "candidate": str(self.new), "helper": str(self.new),
                 "machines": [{"id": "offline"}, {"id": "healthy"}], "before": [], "local_stopped": True}
        atomic_json(self.app.data / "transaction.json", saved)
        self.app.remote.side_effect = [RuntimeError("offline"), {}]
        with self.assertRaisesRegex(RuntimeError, "recovery journal retained"):
            self.app.rollback()
        self.assertEqual((self.app.data / "current").resolve(), self.old)
        self.app.run.assert_any_call(["systemctl", "--user", "start", "fixture.service"])
        self.assertEqual(self.app.remote.call_count, 2)
        self.assertEqual(json.loads((self.app.data / "transaction.json").read_text())["previous"], str(self.old))

    def test_redeploying_current_preserves_previous_and_does_not_touch_services(self):
        self.deployment_mocks()
        switch_link(self.app.data / "previous", self.new)
        self.app.deploy(self.old)
        self.assertEqual((self.app.data / "previous").resolve(), self.new)
        self.app.remote.assert_not_called()
        self.app.run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
