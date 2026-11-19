"""Exercise the TrueNAS upgrade transaction without a NAS or Docker daemon."""
import copy
from contextlib import ExitStack, closing
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("solid_update_installer", ROOT / "tools" / "install_template.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "apps" / "solid_studio"
        (self.root / "data").mkdir(parents=True)
        self.bundle = self.base / "bundle.zip"
        with zipfile.ZipFile(self.bundle, "w") as archive:
            for name in ("server.py", "Dockerfile", "static/index.html", "static/app.js", "static/geometry.js",
                         "static/geometry-worker.js", "static/viewport.js", "static/vendor/manifold.wasm"):
                archive.writestr(name, b"test fixture")
        self.digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        self.marker = {"app": installer.APP, "root": str(self.root), "version": "1.0.0", "bundle": "a" * 64,
                       "port": 8819, "status": "healthy", "image": "local/solid-studio:1.0.0-old", "release": "/old/release"}
        installer.atomic_json(self.root / "install-state.json", self.marker)
        self.previous = installer.compose_config(self.root, self.marker["image"], self.marker["port"], self.marker["bundle"])
        self.previous["services"][installer.APP]["environment"]["TZ"] = "Europe/London"
        self.previous["services"][installer.APP]["mem_limit"] = "768m"
        self.config = copy.deepcopy(self.previous)
        installer.atomic_json(self.root / "compose.yaml", self.previous)
        self.db_path = self.root / "data" / "solid-studio.sqlite3"
        self.db = sqlite3.connect(self.db_path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE projects(id TEXT PRIMARY KEY, document TEXT)")
        self.db.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)")
        self.db.execute("INSERT INTO projects VALUES('keep-me','editable user project')")
        self.db.execute("INSERT INTO settings VALUES('layerLibraryUrl','http://library.internal:8777')")
        self.db.commit()
        # The WAL connection intentionally remains open: backup must include it.
        self.state = "RUNNING"
        self.calls = []
        self.fail_new_health = False
        self.unresolved_update = False
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(installer.shutil, "which", return_value="/fixture/tool"))
        self.stack.enter_context(patch.object(installer.os, "geteuid", return_value=0))
        self.stack.enter_context(patch.object(installer, "run", side_effect=self.command_run))
        self.stack.enter_context(patch.object(installer, "midcall", side_effect=self.midcall))
        self.stack.enter_context(patch.object(installer, "job_call", side_effect=self.jobcall))
        self.stack.enter_context(patch.object(installer, "health", side_effect=self.health))
        self.stack.enter_context(patch.object(installer, "verify_data_access", return_value=None))
        self.stack.enter_context(patch.object(installer, "say", return_value=None))

    def tearDown(self):
        self.stack.close()
        self.db.close()
        self.temp.cleanup()

    def command_run(self, command, **kwargs):
        self.calls.append(("run", list(command)))
        if command[:2] == ["docker", "build"]:
            self.assertEqual(self.state, "RUNNING", "Old app must stay up during image build")

    def midcall(self, method, *args):
        self.calls.append((method, copy.deepcopy(args)))
        if method == "app.query":
            return [{"id": installer.APP, "state": self.state}, {"id": "unrelated", "state": "RUNNING"}]
        if method == "app.config":
            self.assertEqual(args, (installer.APP,))
            return {"custom_compose_config": copy.deepcopy(self.config)}
        self.fail("Unexpected middleware read: " + method)

    def jobcall(self, method, *args, **kwargs):
        self.calls.append((method, copy.deepcopy(args)))
        self.assertEqual(args[0], installer.APP, "Only Solid Studio may be changed")
        if method == "app.stop":
            self.state = "STOPPED"
        elif method == "app.start":
            self.state = "RUNNING"
        elif method == "app.update":
            new_config = json.loads(args[1]["custom_compose_config_string"])
            is_new = new_config["services"][installer.APP]["environment"]["SOLID_STUDIO_BUNDLE"] == self.digest
            if is_new:
                backup = Path(json.loads((self.root / "update-state.json").read_text())["backup"]) / "solid-studio.sqlite3"
                self.assertTrue(backup.is_file(), "This update's backup must exist before activation")
                with closing(sqlite3.connect(backup)) as saved:
                    self.assertEqual(saved.execute("SELECT document FROM projects").fetchone()[0], "editable user project")
                    self.assertEqual(saved.execute("SELECT value FROM settings").fetchone()[0], "http://library.internal:8777")
                if self.unresolved_update:
                    raise installer.UnresolvedJob("fixture job still running")
            self.config = new_config
            self.state = "RUNNING"
        else:
            self.fail("Unexpected middleware mutation: " + method)

    def health(self, port, digest, **kwargs):
        self.calls.append(("health", (port, digest, kwargs)))
        self.assertEqual(port, 8819)
        if digest == self.digest and self.fail_new_health:
            raise installer.InstallError("fixture new release failed health")
        if digest == self.marker["bundle"]:
            self.assertEqual(kwargs.get("version"), self.marker["version"])
        return {"ok": True, "service": installer.APP, "version": kwargs.get("version", installer.VERSION), "bundle": digest}

    def install(self, *extra):
        return installer.main(["--install", "--bundle", str(self.bundle), "--root", str(self.root), *extra])

    def marker_now(self):
        return json.loads((self.root / "install-state.json").read_text())

    def test_upgrade_preserves_port_config_live_data_and_wal_backup(self):
        self.assertEqual(self.install(), 0)
        final = self.marker_now()
        self.assertEqual((final["version"], final["port"], final["status"]), (installer.VERSION, 8819, "healthy"))
        service = self.config["services"][installer.APP]
        self.assertEqual(service["environment"]["TZ"], "Europe/London")
        self.assertEqual(service["mem_limit"], "768m")
        self.assertEqual(service["ports"], self.previous["services"][installer.APP]["ports"])
        self.assertEqual(service["volumes"], self.previous["services"][installer.APP]["volumes"])
        self.assertEqual(self.db.execute("SELECT document FROM projects").fetchone()[0], "editable user project")
        self.assertEqual(self.db.execute("SELECT value FROM settings").fetchone()[0], "http://library.internal:8777")
        jobs = [method for method, _ in self.calls if method in ("app.stop", "app.start", "app.update", "app.create")]
        self.assertEqual(jobs, ["app.stop", "app.update"])
        self.assertEqual(json.loads((self.root / "update-state.json").read_text())["status"], "complete")
        self.calls.clear()
        self.assertEqual(self.install(), 0)
        self.assertFalse(any(method in ("run", "app.stop", "app.update") for method, _ in self.calls), "Same release must be idempotent")

    def test_upgrade_from_1_1_preserves_port_data_and_supports_rollback(self):
        self.marker.update(version="1.1.0", image="local/solid-studio:1.1.0-old")
        self.previous["services"][installer.APP]["image"] = self.marker["image"]
        self.config = copy.deepcopy(self.previous)
        installer.atomic_json(self.root / "install-state.json", self.marker)
        installer.atomic_json(self.root / "compose.yaml", self.previous)
        self.fail_new_health = True
        with self.assertRaisesRegex(installer.InstallError, "previous Solid Studio application was restored"):
            self.install()
        self.assertEqual(self.config, self.previous)
        self.assertEqual(self.marker_now()["version"], "1.1.0")
        self.assertEqual(self.state, "RUNNING")
        self.assertEqual(self.db.execute("SELECT document FROM projects").fetchone()[0], "editable user project")
        self.fail_new_health = False
        self.assertEqual(self.install(), 0)
        self.assertEqual(self.marker_now()["version"], installer.VERSION)
        self.assertEqual(self.marker_now()["port"], 8819)
        self.assertEqual(self.db.execute("SELECT value FROM settings").fetchone()[0], "http://library.internal:8777")

    def test_failed_health_restores_original_definition_and_marker_without_replacing_data(self):
        self.fail_new_health = True
        with self.assertRaisesRegex(installer.InstallError, "previous Solid Studio application was restored"):
            self.install()
        self.assertEqual(self.config, self.previous)
        self.assertEqual(self.marker_now()["bundle"], self.marker["bundle"])
        self.assertEqual(self.marker_now()["status"], "healthy")
        self.assertEqual(self.state, "RUNNING")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 1)
        self.assertEqual(json.loads((self.root / "update-state.json").read_text())["status"], "rolled_back")
        self.assertEqual(sum(method == "app.update" for method, _ in self.calls), 2)

    def test_unresolved_update_is_recorded_without_competing_rollback(self):
        self.unresolved_update = True
        with self.assertRaises(installer.UnresolvedJob):
            self.install()
        self.assertEqual(sum(method == "app.update" for method, _ in self.calls), 1)
        self.assertEqual(self.marker_now()["status"], "unresolved")
        self.calls.clear()
        with self.assertRaisesRegex(installer.InstallError, "needs review"):
            self.install()
        self.assertEqual(self.calls, [])

    def test_failed_build_leaves_old_app_and_marker_untouched(self):
        def failing_run(command, **kwargs):
            if command[:2] == ["docker", "build"]:
                raise installer.InstallError("fixture build failure")
        with patch.object(installer, "run", side_effect=failing_run):
            with self.assertRaisesRegex(installer.InstallError, "build failure"):
                self.install()
        self.assertEqual(self.marker_now(), self.marker)
        self.assertEqual(self.config, self.previous)
        self.assertEqual(self.state, "RUNNING")
        self.assertFalse(any(method in ("app.stop", "app.update") for method, _ in self.calls))

    def test_backup_failure_restarts_old_app_without_updating_or_replacing_database(self):
        with patch.object(installer, "backup_database", side_effect=installer.InstallError("fixture backup failure")):
            with self.assertRaisesRegex(installer.InstallError, "previous Solid Studio application was restored"):
                self.install()
        self.assertEqual(self.config, self.previous)
        self.assertEqual(self.marker_now()["status"], "healthy")
        self.assertEqual(self.state, "RUNNING")
        self.assertFalse(any(method == "app.update" for method, _ in self.calls))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 1)

    def test_disk_full_audit_failure_does_not_prevent_old_app_restart(self):
        atomic_json = installer.atomic_json
        disk_full = False
        def failing_backup(*_args):
            nonlocal disk_full
            self.assertEqual(self.state, "STOPPED")
            disk_full = True
            raise OSError(28, "No space left on device during backup")
        def audit_write(path, value, **kwargs):
            if disk_full:
                raise OSError(28, "No space left on device during state write")
            return atomic_json(path, value, **kwargs)
        with patch.object(installer, "backup_database", side_effect=failing_backup), patch.object(installer, "atomic_json", side_effect=audit_write):
            with self.assertRaisesRegex(installer.InstallError, "previous Solid Studio application was restored.*Recovery state files"):
                self.install()
        self.assertEqual(self.state, "RUNNING")
        self.assertEqual(self.config, self.previous)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 1)
        jobs = [method for method, _ in self.calls if method in ("app.stop", "app.start", "app.update")]
        self.assertEqual(jobs, ["app.stop", "app.start"], "Failed auditing must not block recovery or cause repeated app changes")
        self.assertEqual(self.marker_now(), self.marker)

    def test_foreign_app_or_port_change_is_refused_before_writes(self):
        with self.assertRaisesRegex(installer.InstallError, "retain the installed port"):
            self.install("--port", "8820")
        self.config["services"][installer.APP]["labels"]["com.solid-studio.install-root"] = "/somewhere/else"
        with self.assertRaisesRegex(installer.InstallError, "ownership"):
            self.install()
        self.assertEqual(self.marker_now(), self.marker)
        self.assertFalse((self.root / "releases").exists())

    def test_upgrade_dry_run_does_not_create_staging_or_backups(self):
        self.assertEqual(installer.main(["--dry-run", "--bundle", str(self.bundle), "--root", str(self.root)]), 0)
        self.assertEqual(self.marker_now(), self.marker)
        self.assertFalse((self.root / "releases").exists())
        self.assertFalse((self.root / "backups").exists())
        self.assertFalse(any(method in ("run", "app.stop", "app.update") for method, _ in self.calls))


if __name__ == "__main__":
    unittest.main()
