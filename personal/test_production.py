import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

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
        self.app.receipt = Mock(return_value={})
        self.app.json_get = Mock(return_value={"machines": []})
        self.app.machines = Mock(return_value=[])
        self.app.remote = Mock(return_value={"machines": []})
        self.app.run = Mock()
        self.app.git = Mock(side_effect=lambda *args, cwd=None: Path(cwd).name)
        self.app.wait_healthy = Mock()

    def test_rollout_scope_excludes_only_explicit_enabled_ssh_pcs(self):
        roster = [
            {"id": "local", "kind": "local", "enabled": True, "state": "connected"},
            {"id": "selected", "kind": "ssh", "enabled": True, "state": "connected", "target": {}},
            {"id": "offline", "kind": "ssh", "enabled": True, "state": "reconnecting", "target": {}},
            {"id": "disabled", "kind": "ssh", "enabled": False, "state": "disconnected", "target": {}},
        ]
        self.app.json_get = Mock(return_value={"machines": roster})
        with self.assertRaisesRegex(RuntimeError, "Reconnect every selected PC"):
            self.app.machines()
        self.app.excluded_machines = ["offline"]
        self.assertEqual(self.app.machines(), [{"id": "selected", "target": {}}])
        self.assertTrue(roster[2]["enabled"])
        for invalid in ["missing", "local", "disabled"]:
            self.app.excluded_machines = [invalid]
            with self.assertRaisesRegex(RuntimeError, "enabled SSH PC"):
                self.app.machines()
        self.app.excluded_machines = ["selected"]
        with self.assertRaisesRegex(RuntimeError, "Reconnect every selected PC"):
            self.app.machines()

    def test_prepared_scope_cannot_be_changed_at_promotion_or_reuse(self):
        self.deployment_mocks()
        self.app.receipt.return_value = {"excluded_machines": ["offline"]}
        with self.assertRaisesRegex(RuntimeError, "different rollout scope"):
            self.app.deploy(self.new)
        self.app.run.assert_not_called()
        self.app.remote.assert_not_called()
        atomic_json(self.app.data / "verified" / f"{self.new.name}.json", {})
        self.app.git.return_value = self.new.name
        self.app.git.side_effect = None
        with self.assertRaisesRegex(RuntimeError, "different rollout scope"):
            self.app.prepare(self.new.name)

    def test_scoped_promotion_and_recovery_retain_exact_exclusions(self):
        self.deployment_mocks()
        self.app.excluded_machines = ["offline"]
        self.app.receipt.return_value = {"excluded_machines": ["offline"]}
        selected = {"id": "local", "kind": "local", "enabled": True,
                    "state": "connected", "snapshot": {"panes": [{"pane_id": "kept"}]}}
        self.app.json_get.return_value = {"machines": [
            selected, {"id": "offline", "kind": "ssh", "enabled": True, "state": "reconnecting"},
        ]}
        self.app.deploy(self.new)
        before = [{"id": "local", "snapshot": {"panes": [{"pane_id": "kept"}]}}]
        self.app.wait_healthy.assert_called_once_with(self.new.name, before, ["offline"])
        saved = json.loads((self.app.data / "previous-deployment.json").read_text())
        self.assertEqual(saved["excluded_machines"], ["offline"])
        self.assertEqual(saved["before"], before)
        self.app.excluded_machines = []
        self.app.wait_healthy.reset_mock()
        self.app.rollback()
        self.app.wait_healthy.assert_called_once_with(self.old.name, before, ["offline"])

    def test_scoped_health_still_requires_selected_connection_and_panes(self):
        local = {"id": "local", "enabled": True, "state": "connected",
                 "snapshot": {"panes": [{"pane_id": "kept"}]}}
        offline = {"id": "offline", "enabled": True, "state": "reconnecting"}
        self.app.json_get = Mock(side_effect=[
            {"ok": True, "web_ui": {"revision": self.new.name}},
            {"machines": [local, offline]},
        ])
        before = [{"id": "local", "snapshot": {"panes": [{"pane_id": "kept"}]}}]
        self.app.wait_healthy(self.new.name, before, ["offline"])
        for roster, excluded, message in [
            ([local, offline], [], "health check failed"),
            ([{**local, "state": "disconnected"}, offline], ["offline"], "health check failed"),
            ([], ["offline"], "selected PC is missing"),
            ([{**local, "enabled": False}, offline], ["offline"], "selected PC is missing"),
            ([{**local, "snapshot": {"panes": []}}, offline], ["offline"], "pane is missing"),
        ]:
            self.app.json_get = Mock(side_effect=lambda path, timeout=5: (
                {"ok": True, "web_ui": {"revision": self.new.name}} if path == "/api/health"
                else {"machines": roster}
            ))
            with patch("production.time.monotonic", side_effect=[0, 0, 100]), patch("production.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, message):
                    self.app.wait_healthy(self.new.name, before, excluded)

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
