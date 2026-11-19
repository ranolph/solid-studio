#!/usr/bin/env python3
"""Install the bundled Solid Studio app through TrueNAS Apps.

Default is a read-only dry run. Use --install to install or update this app.
No packages are installed on the NAS host; no other app is stopped or changed.
"""
from __future__ import annotations
import argparse
import base64
from contextlib import closing
from datetime import datetime, timezone
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from urllib.request import ProxyHandler, build_opener
import zipfile

VERSION = "1.2.0"
APP = "solid-studio"
UID = GID = 568
BUNDLE_SHA256 = "__SOLID_BUNDLE_SHA256__"
BUNDLE_BASE64 = "__SOLID_BUNDLE_BASE64__"
HTTP = build_opener(ProxyHandler({}))


class InstallError(Exception):
    pass


class UnresolvedJob(InstallError):
    pass


def say(message, **values):
    print(message + (": " + json.dumps(values) if values else ""), flush=True)


def stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def run(command, timeout=600):
    """Stream useful build progress without a fixed short timeout on image pulls."""
    try:
        result = subprocess.run(command, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise InstallError("Command timed out: " + command[0]) from None
    if result.returncode:
        raise InstallError("Command failed: " + " ".join(command[:3]))


def midcall(method, *parameters):
    command = ["midclt", "call", method] + [value if isinstance(value, str) else json.dumps(value) for value in parameters]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        raise UnresolvedJob(f"TrueNAS did not return from {method}. Check Jobs before retrying; the operation was not repeated.") from None
    if result.returncode:
        raise InstallError(f"TrueNAS {method} failed: {(result.stderr or result.stdout).strip()[-1600:]}")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise UnresolvedJob(f"TrueNAS returned an unexpected response to {method}. Check Jobs before retrying.") from None


def job_call(method, *parameters, timeout=900):
    result = midcall(method, *parameters)
    if not isinstance(result, int) or isinstance(result, bool):
        return result
    deadline, previous = time.monotonic() + timeout, None
    while time.monotonic() < deadline:
        jobs = midcall("core.get_jobs", [["id", "=", result]])
        if not isinstance(jobs, list) or not jobs:
            raise UnresolvedJob(f"TrueNAS job {result} cannot be read. Check Jobs before retrying.")
        state = jobs[0].get("state")
        description = (jobs[0].get("progress") or {}).get("description") or state
        if description != previous:
            say("Waiting for the Solid Studio app job", job_id=result, method=method, state=state, description=description)
            previous = description
        if state == "SUCCESS":
            return jobs[0].get("result")
        if state in ("FAILED", "ABORTED"):
            raise InstallError(f"TrueNAS job {result} {state.lower()}: {jobs[0].get('error') or 'see Jobs'}")
        time.sleep(2)
    raise UnresolvedJob(f"TrueNAS job {result} is still unresolved. It was not cancelled or retried. Check Jobs.")


def safe_directory(path, create=False, mode=0o755):
    path = Path(path).absolute()
    for component in (path, *path.parents):
        if component.is_symlink():
            raise InstallError(f"Refusing a symbolic-link directory: {component}")
    if path.exists():
        if not path.is_dir():
            raise InstallError(f"Not a directory: {path}")
        return False
    if not create:
        raise InstallError(f"Directory does not exist: {path}")
    path.mkdir(parents=True, mode=mode)
    path.chmod(mode)
    return True


def atomic_json(path, value, mode=0o600):
    if path.is_symlink():
        raise InstallError("Refusing a symbolic-link state file.")
    descriptor, temporary = tempfile.mkstemp(prefix=".solid-studio-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_bundle(bundle=None):
    if bundle:
        raw = Path(bundle).read_bytes()
    else:
        if BUNDLE_BASE64.startswith("__SOLID_"):
            raise InstallError("This is the source template. Run tools/package.py first, then use its installer.")
        try:
            raw = base64.b64decode(BUNDLE_BASE64, validate=True)
        except ValueError:
            raise InstallError("The embedded bundle is damaged; download the installer again.") from None
    digest = hashlib.sha256(raw).hexdigest()
    if not BUNDLE_SHA256.startswith("__SOLID_") and digest != BUNDLE_SHA256:
        raise InstallError("The app bundle checksum does not match. Nothing was installed.")
    validate_archive(raw)
    return raw, digest


def validate_archive(raw):
    required = {"server.py", "Dockerfile", "static/index.html", "static/app.js", "static/geometry.js", "static/geometry-worker.js", "static/viewport.js", "static/vendor/manifold.wasm"}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries, names = archive.infolist(), set()
        if len(entries) > 3000 or sum(item.file_size for item in entries) > 128 * 1024 * 1024:
            raise InstallError("The bundle exceeds its file-count or size limit.")
        for item in entries:
            path = PurePosixPath(item.filename)
            kind = stat.S_IFMT(item.external_attr >> 16)
            if (path.is_absolute() or ".." in path.parts or "\\" in item.filename or not path.parts
                    or any(part.startswith(".") and part not in (".dockerignore", ".env.example", ".gitignore", ".github") for part in path.parts)
                    or kind not in (0, stat.S_IFREG, stat.S_IFDIR) or item.filename in names):
                raise InstallError("The bundle contains an unsafe or duplicate path.")
            names.add(item.filename)
        if not required.issubset(names):
            raise InstallError("The bundle is missing required application files.")


def extract_bundle(raw, destination):
    validate_archive(raw)
    destination.mkdir(mode=0o755)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for item in archive.infolist():
            target = destination / item.filename
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with archive.open(item) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644)


def port_available(port, apps):
    for app in apps:
        for mapping in (app.get("active_workloads") or {}).get("used_ports", []):
            for host in mapping.get("host_ports", []):
                if str(host.get("host_port")) == str(port):
                    return False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("0.0.0.0", port))
        try:
            with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
                probe.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                probe.bind(("::", port))
        except OSError as exc:
            if exc.errno not in (97, 99):  # IPv6 unavailable, rather than an occupied port.
                return False
        return True
    except OSError:
        return False


def select_port(requested, apps):
    candidates = [requested] if requested is not None else range(8788, 8889)
    for port in candidates:
        if not isinstance(port, int) or not 1024 <= port <= 65535:
            raise InstallError("Choose a web port from 1024 to 65535.")
        if port_available(port, apps):
            return port
    raise InstallError("No free web port was found. Choose another using --port.")


def compose_config(root, image, port, digest):
    return {"services": {APP: {
        "image": image, "pull_policy": "never", "restart": "unless-stopped", "init": True,
        "user": f"{UID}:{GID}", "ports": [{"target": 8080, "published": str(port), "host_ip": "0.0.0.0", "protocol": "tcp"}],
        "environment": {"DATA_DIR": "/data", "HOST": "0.0.0.0", "PORT": "8080", "SOLID_STUDIO_BUNDLE": digest},
        "volumes": [{"type": "bind", "source": str(root / "data"), "target": "/data", "bind": {"create_host_path": False}}],
        "read_only": True, "tmpfs": ["/tmp:rw,nosuid,nodev,size=16777216,mode=1777"],
        "security_opt": ["no-new-privileges:true"], "cap_drop": ["ALL"], "mem_limit": "512m", "pids_limit": 64,
        "labels": {"com.solid-studio.install-root": str(root), "com.solid-studio.bundle-sha256": digest},
        "healthcheck": {"test": ["CMD", "python", "-c", "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=3)); assert r.get('ok') and r.get('service')=='solid-studio'"], "interval": "30s", "timeout": "5s", "retries": 4, "start_period": "10s"},
        "logging": {"driver": "json-file", "options": {"max-size": "5m", "max-file": "3"}},
    }}}


def verify_data_access(root):
    probe = ".write-test-" + stamp()
    code = "import pathlib,sys; p=pathlib.Path(sys.argv[1])/sys.argv[2]; p.write_text('ok'); p.unlink()"
    result = subprocess.run([sys.executable, "-I", "-B", "-c", code, str(root / "data"), probe],
                            user=UID, group=GID, extra_groups=[], capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise InstallError(f"UID/GID {UID} cannot write {root / 'data'}. Check the dataset ACL; no app was deployed. " + result.stderr.strip()[-400:])


def health(port, digest, timeout=150, version=None):
    version = VERSION if version is None else version
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with HTTP.open(f"http://127.0.0.1:{port}/api/health", timeout=4) as response:
                result = json.load(response)
            if result.get("ok") is True and result.get("service") == APP and result.get("version") == version and result.get("bundle") == digest:
                return result
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise InstallError("Solid Studio did not become healthy. Check its logs in TrueNAS Apps. Its files and data were retained.")


def owned_config(config, root, marker):
    """Verify the old definition before touching this named TrueNAS app."""
    if isinstance(config, dict) and "custom_compose_config" in config:
        config = config["custom_compose_config"]
    if not isinstance(config, dict) or set(config.get("services", {})) != {APP}:
        raise InstallError("The existing app does not have the expected Solid Studio service. It was not changed.")
    service = config["services"][APP]
    labels, environment = service.get("labels", {}), service.get("environment", {})
    if (not isinstance(labels, dict) or not isinstance(environment, dict)
            or labels.get("com.solid-studio.install-root") != str(root)
            or labels.get("com.solid-studio.bundle-sha256") != marker["bundle"]
            or environment.get("SOLID_STUDIO_BUNDLE") != marker["bundle"]
            or environment.get("DATA_DIR") != "/data" or str(environment.get("PORT")) != "8080"
            or service.get("image") != marker.get("image") or service.get("user") != f"{UID}:{GID}"):
        raise InstallError("The existing app ownership, image or data configuration does not match its installer record. It was not changed.")
    volumes = service.get("volumes", [])
    data = [v for v in volumes if isinstance(v, dict) and v.get("target") == "/data"]
    ports = service.get("ports", [])
    web = [p for p in ports if isinstance(p, dict) and str(p.get("target")) == "8080" and p.get("protocol", "tcp") == "tcp"]
    if (len(data) != 1 or data[0].get("type") != "bind" or data[0].get("source") != str(root / "data")
            or len(web) != 1 or str(web[0].get("published")) != str(marker.get("port"))
            or web[0].get("host_ip", "0.0.0.0") not in ("0.0.0.0", "127.0.0.1", "::")):
        raise InstallError("The existing app data directory or web port differs from its installer record. It was not changed.")
    return json.loads(json.dumps(config))


def next_config(previous, image, digest):
    """Keep the installed port, mounts and local options; replace only release identity."""
    result = json.loads(json.dumps(previous))
    service = result["services"][APP]
    service["image"], service["pull_policy"] = image, "never"
    service["environment"]["SOLID_STUDIO_BUNDLE"] = digest
    service["labels"]["com.solid-studio.bundle-sha256"] = digest
    return result


def backup_database(root, destination):
    """SQLite's backup API includes committed WAL content, unlike a file copy."""
    source_path = root / "data" / "solid-studio.sqlite3"
    for suffix in ("", "-wal", "-shm"):
        if Path(str(source_path) + suffix).is_symlink():
            raise InstallError("The Solid Studio database and journal files must not be symbolic links.")
    if not source_path.is_file():
        raise InstallError("The existing Solid Studio database was not found; the update was not applied.")
    output = destination / "solid-studio.sqlite3"
    if output.exists() or output.is_symlink():
        raise InstallError("The database backup path already exists.")
    started = time.monotonic()
    def progress(_status, _remaining, _total):
        if time.monotonic() - started > 90:
            raise InstallError("The database backup exceeded 90 seconds; the update was not applied.")
    with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=15)) as source:
        with closing(sqlite3.connect(output)) as target:
            source.backup(target, pages=256, progress=progress)
            if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise InstallError("The Solid Studio database backup did not pass its integrity check.")
    output.chmod(0o600)
    return output


def app_inventory():
    apps = midcall("app.query")
    if not isinstance(apps, list):
        raise InstallError("TrueNAS did not return a valid app inventory.")
    return apps


def start_if_stopped():
    apps = midcall("app.query", [["id", "=", APP]])
    if isinstance(apps, list) and apps and apps[0].get("state") == "STOPPED":
        job_call("app.start", APP)


def update_app(root, marker, previous, state, config, was_running):
    """Activate a staged release with the original definition available for rollback."""
    marker_path = root / "install-state.json"
    transaction_path = root / "update-state.json"
    safe_directory(root / "backups", create=True, mode=0o700)
    backup = root / "backups" / (marker["version"] + "-before-" + VERSION + "-" + stamp())
    backup.mkdir(mode=0o700)
    atomic_json(backup / "install-state.json", marker)
    atomic_json(backup / "compose.json", previous)
    state.update(status="staged", backup=str(backup), previousVersion=marker["version"])
    atomic_json(transaction_path, state)
    attempted_update = False
    audit_errors = []
    def recovery_record(path, value, **options):
        # Recovery of the running application must not depend on free disk space
        # for its audit trail. Report any missing state writes after restoration.
        try:
            atomic_json(path, value, **options)
        except (InstallError, OSError, ValueError) as error:
            audit_errors.append(f"{path.name}: {error}")
    def audit_note():
        if not audit_errors:
            return ""
        return " Recovery state files could not all be written; inspect TrueNAS Apps/Jobs and the retained backup before rerunning. " + "; ".join(audit_errors)
    try:
        say("New image built; briefly stopping only Solid Studio for its database backup")
        job_call("app.stop", APP)
        database = backup_database(root, backup)
        say("Saved project database and previous application definition", directory=str(backup), database=database.name)
        state["status"] = "updating"
        atomic_json(transaction_path, state)
        attempted_update = True
        job_call("app.update", APP, {"custom_compose_config_string": json.dumps(config)})
        start_if_stopped()
        result = health(state["port"], state["bundle"])
        if not was_running:
            job_call("app.stop", APP)
        state.update(status="healthy", health=result, installedAt=stamp(), appState="RUNNING" if was_running else "STOPPED")
        atomic_json(root / "compose.yaml", config, mode=0o644)
        atomic_json(marker_path, state)
        atomic_json(transaction_path, {**state, "status": "complete"})
    except UnresolvedJob as exc:
        # An unresolved middleware job may still be changing the app. Do not race it.
        state.update(status="unresolved", error=str(exc))
        recovery_record(transaction_path, state)
        recovery_record(marker_path, {**marker, "status": "unresolved", "updateState": str(transaction_path), "backup": str(backup)})
        if audit_errors:
            raise UnresolvedJob(str(exc) + audit_note()) from exc
        raise
    except (InstallError, OSError, ValueError, sqlite3.Error) as exc:
        say("Update did not pass; restoring only the previous Solid Studio application", reason=str(exc))
        state.update(status="rolling_back", error=str(exc))
        recovery_record(transaction_path, state)
        try:
            if attempted_update:
                job_call("app.update", APP, {"custom_compose_config_string": json.dumps(previous)})
            if was_running:
                start_if_stopped()
                health(marker["port"], marker["bundle"], version=marker["version"])
            else:
                job_call("app.stop", APP)
        except (InstallError, OSError, ValueError) as rollback_error:
            recovery_record(marker_path, {**marker, "status": "rollback_failed", "updateState": str(transaction_path), "backup": str(backup)})
            recovery_record(transaction_path, {**state, "status": "rollback_failed", "rollbackError": str(rollback_error)})
            raise InstallError(f"The update failed and automatic rollback did not complete: {rollback_error}. All data, releases and the backup remain at {root}." + audit_note()) from exc
        # The previous application has now been restored/verified. Audit errors
        # must neither misreport that outcome nor trigger another app mutation.
        recovery_record(root / "compose.yaml", previous, mode=0o644)
        recovery_record(marker_path, {**marker, "lastUpdateError": str(exc), "lastUpdateBackup": str(backup)})
        recovery_record(transaction_path, {**state, "status": "rolled_back"})
        raise InstallError(f"The update failed; the previous Solid Studio application was restored. Saved projects were retained. Reason: {exc}" + audit_note()) from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--install", action="store_true", help="Install or update this owned app through TrueNAS Apps")
    action.add_argument("--prepare-only", action="store_true", help="Extract the release and write the config, without building or registering")
    action.add_argument("--dry-run", action="store_true", help="Verify the bundle and print the plan without writing files (default)")
    parser.add_argument("--root", type=Path, default=Path("/mnt/Apps_deploy/solid_studio"))
    parser.add_argument("--port", type=int, help="New installs: free web port. Updates retain the installed port.")
    parser.add_argument("--bundle", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    raw, digest = read_bundle(args.bundle)
    root = args.root.absolute()
    if len(root.parts) < 4 or root == Path("/"):
        raise InstallError("Use a dedicated app directory, such as /mnt/Apps_deploy/solid_studio.")
    for path in (root, *root.parents):
        if path.is_symlink():
            raise InstallError("The app path must not contain symbolic links.")
    marker_path = root / "install-state.json"
    marker = None
    if root.exists():
        safe_directory(root)
        if marker_path.is_symlink():
            raise InstallError("The installation state must not be a symbolic link.")
        if marker_path.exists():
            marker = json.loads(marker_path.read_text())
            if (not isinstance(marker, dict) or marker.get("app") != APP or marker.get("root") != str(root)
                    or not isinstance(marker.get("bundle"), str) or len(marker["bundle"]) != 64
                    or any(c not in "0123456789abcdef" for c in marker["bundle"])
                    or marker.get("version") not in ("1.0.0", "1.1.0", VERSION)):
                raise InstallError("The directory does not have a supported Solid Studio ownership marker. It was not overwritten.")
            if marker.get("status") in ("unresolved", "rollback_failed", "registering"):
                raise InstallError("The previous app operation needs review in TrueNAS Jobs. It was not repeated; see install-state.json and update-state.json.")
        elif any(root.iterdir()):
            raise InstallError("The app directory is not empty and has no Solid Studio ownership marker.")
    apps, existing, previous = [], None, None
    if shutil.which("midclt"):
        apps = app_inventory()
        existing = next((app for app in apps if app.get("id") == APP), None)
        if existing:
            if not marker or marker.get("status") != "healthy":
                raise InstallError("A solid-studio app already exists. It was not replaced; check its state in TrueNAS Apps.")
            previous = owned_config(midcall("app.config", APP), root, marker)
            if args.port is not None and args.port != marker["port"]:
                raise InstallError("Updates retain the installed port. Omit --port or use its current value.")
            if marker["bundle"] == digest:
                if args.install and existing.get("state") != "STOPPED":
                    health(marker["port"], digest, timeout=8)
                say("This exact Solid Studio release is already installed", port=marker["port"], state=existing.get("state"))
                return 0
            if existing.get("state") not in ("RUNNING", "STOPPED"):
                raise InstallError("Solid Studio is not in a stable running/stopped state. Check its current TrueNAS job before updating.")
    elif args.install:
        raise InstallError("TrueNAS midclt is unavailable. Use --prepare-only to inspect the package, or use Docker Compose on another host.")
    if not existing and marker and marker["bundle"] != digest:
        raise InstallError("A different Solid Studio release is recorded here, but its app is missing. Its data was retained; restore or inspect that installation first.")
    port = marker["port"] if existing else select_port(args.port or (marker or {}).get("port"), apps)
    image = "local/solid-studio:" + VERSION + "-" + digest[:12]
    say("Solid Studio bundle verified", version=VERSION, sha256=digest, files="bundled, including offline geometry engine")
    say("Installation plan", operation="update" if existing else "install", app=APP, root=str(root), port=port, image=image, other_apps="unchanged", saved_projects="retained")
    if not args.install and not args.prepare_only:
        say("Dry run complete. Run the same command with --install to deploy through TrueNAS Apps.")
        return 0
    safe_directory(root.parent)
    if args.install and os.geteuid() != 0:
        raise InstallError("Run --install as root to register the app and set its own data permissions.")
    if args.install and not shutil.which("docker"):
        raise InstallError("Docker is unavailable. This installer needs a Docker-based TrueNAS Apps release.")
    if args.install:
        run(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=30)
    safe_directory(root, create=True)
    lock_fd = os.open(root / ".install.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError("Another Solid Studio installer is already running.") from None
        # Recheck after taking the lock: a previous installer may have completed
        # between the read-only plan and lock acquisition.
        if marker_path.exists() and json.loads(marker_path.read_text()) != marker:
            raise InstallError("The installation changed while preparing this operation. Run the command again to inspect its current state.")
        if existing:
            if owned_config(midcall("app.config", APP), root, marker) != previous:
                raise InstallError("The app configuration changed while preparing the update. It was not replaced.")
        state = {"app": APP, "root": str(root), "version": VERSION, "bundle": digest, "port": port, "status": "preparing", "preparedAt": stamp()}
        if not existing:
            atomic_json(marker_path, state)
        safe_directory(root / "releases", create=True)
        created = safe_directory(root / "data", create=not existing, mode=0o750)
        if created and os.geteuid() == 0:
            os.chown(root / "data", UID, GID)
        release = root / "releases" / (VERSION + "-" + digest[:12] + "-" + stamp())
        extract_bundle(raw, release)
        config = next_config(previous, image, digest) if existing else compose_config(root, image, port, digest)
        atomic_json(release / "deployment.json", config)
        if not existing:
            atomic_json(root / "compose.yaml", config, mode=0o644)
        state.update(status="prepared", release=str(release), image=image)
        if not existing:
            atomic_json(marker_path, state)
        if args.prepare_only:
            say("Prepared successfully; no TrueNAS app was changed", compose=str(release / "deployment.json"), release=str(release))
            say("The local application image must still be built. Run this installer again with --install.")
            return 0
        verify_data_access(root)
        say("Building Solid Studio; the first build downloads the Python base image")
        run(["docker", "build", "--build-arg", f"APP_UID={UID}", "--build-arg", f"APP_GID={GID}", "--tag", image, str(release)], timeout=1200)
        if existing:
            if owned_config(midcall("app.config", APP), root, marker) != previous:
                raise InstallError("The app configuration changed during the build. The old app remains untouched; rerun when the change is complete.")
            current = next((app for app in app_inventory() if app.get("id") == APP), None)
            if not current or current.get("state") != existing.get("state"):
                raise InstallError("The app state changed during the build. No update was applied; rerun when its current operation is complete.")
            update_app(root, marker, previous, state, config, was_running=existing.get("state") == "RUNNING")
            say("Solid Studio update verified", version=VERSION, state="RUNNING" if existing.get("state") == "RUNNING" else "STOPPED")
            say(f"Open http://<your-NAS-address>:{port}" if existing.get("state") == "RUNNING" else "The app was stopped before updating and remains stopped. Start it in TrueNAS Apps when ready.")
            say("Persistent projects and settings", directory=str(root / "data"))
            return 0
        if not port_available(port, midcall("app.query")):
            raise InstallError("The selected port became occupied during the build. Rerun with --port and another free port.")
        state["status"] = "registering"
        atomic_json(marker_path, state)
        try:
            job_call("app.create", {"app_name": APP, "custom_app": True, "custom_compose_config_string": json.dumps(config)})
            start_if_stopped()
            state.update(status="healthy", health=health(port, digest), installedAt=stamp())
            atomic_json(marker_path, state)
        except UnresolvedJob:
            state["status"] = "unresolved"
            atomic_json(marker_path, state)
            raise
        except (InstallError, OSError, ValueError) as exc:
            state.update(status="failed", error=str(exc))
            atomic_json(marker_path, state)
            raise
        say("Solid Studio is installed and healthy")
        say(f"Open http://<your-NAS-address>:{port}")
        say("Persistent projects and settings", directory=str(root / "data"))
        return 0
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InstallError, OSError, ValueError, zipfile.BadZipFile) as exc:
        say("Installation stopped", reason=str(exc))
        say("No other app was changed. Solid Studio files and any saved projects were retained.")
        raise SystemExit(1)
