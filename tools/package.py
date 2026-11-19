#!/usr/bin/env python3
"""Create the redistributable source ZIP and self-contained TrueNAS installer."""
from __future__ import annotations
import argparse
import base64
import hashlib
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.2.0"
TOP_LEVEL = {"server.py", "Dockerfile", "compose.yaml", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "package.json", "package-lock.json", ".dockerignore", ".gitignore", ".env.example", "preview.py"}
FOLDERS = {"static", "tests", "tools", "docs", "licenses", ".github"}
EXCLUDE = {"__pycache__", "node_modules", "data", "dist", "release", ".git", ".DS_Store"}


def source_files():
    result = []
    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT)
        if not path.is_file() or path.is_symlink() or any(part in EXCLUDE for part in relative.parts):
            continue
        if relative.parts[0] not in FOLDERS and str(relative) not in TOP_LEVEL:
            continue
        if path.suffix in (".pyc", ".sqlite3", ".db", ".log") or path.name.endswith((".sqlite3-wal", ".sqlite3-shm")):
            continue
        result.append(path)
    return sorted(result)


def package(output):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / f"Solid_Studio_v{VERSION}.zip"
    files = source_files()
    required = ["server.py", "static/index.html", "static/app.js", "static/geometry.js", "static/geometry-worker.js", "static/viewport.js", "static/vendor/manifold.js", "static/vendor/manifold.wasm", "Dockerfile", "LICENSE"]
    names = {str(path.relative_to(ROOT)) for path in files}
    missing = set(required) - names
    if missing:
        raise SystemExit("Cannot package an incomplete app: " + ", ".join(sorted(missing)))
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            entry = zipfile.ZipInfo(str(path.relative_to(ROOT)), date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes())
    raw = archive_path.read_bytes()
    checksum = hashlib.sha256(raw).hexdigest()
    template = (ROOT / "tools" / "install_template.py").read_text()
    for token in ("__SOLID_BUNDLE_SHA256__", "__SOLID_BUNDLE_BASE64__"):
        if template.count(token) != 1:
            raise SystemExit("Installer template token is not unique: " + token)
    installer = template.replace("__SOLID_BUNDLE_SHA256__", checksum).replace("__SOLID_BUNDLE_BASE64__", base64.b64encode(raw).decode())
    installer_path = output / "install_solid_studio.py"
    installer_path.write_text(installer)
    compile(installer, str(installer_path), "exec")
    quickstart = output / "Solid_Studio_Quickstart.txt"
    quickstart.write_text(f"""SOLID STUDIO {VERSION} — SELF-HOSTED 3D MODELLING

TRUENAS
1. Place install_solid_studio.py in your usual Airlock/share folder.
2. In the TrueNAS shell run:
   /usr/bin/python3 -I -B -u /path/to/install_solid_studio.py --install
3. Open http://<your-NAS-address>:<port-printed-by-installer>

The installer creates or updates the separate solid-studio app. A new install
selects a free port starting at 8788. An update retains the installed port,
projects and settings, stages the new image while the old app runs, then briefly
restarts only Solid Studio after backing up its database and app definition.
Its own data lives in /mnt/Apps_deploy/solid_studio/data.
No other app is stopped or changed. The previous app is restored if update
health checks fail. An unresolved TrueNAS job is left for inspection rather
than starting a competing rollback.
A Python container base image is downloaded on the first build. Modelling,
editing and STL export then work locally without external services.

Before installation, omit --install (or use --dry-run) for a read-only check.
Use --root /mnt/YOUR_DATASET/solid_studio and --port 8790 for custom locations.
The default root's parent dataset must exist and allow the app UID/GID 568
access. The installer tests its own data-directory write access before deploy.

OTHER HOSTS
Extract Solid_Studio_v{VERSION}.zip. With Docker Engine and Compose installed, run
  docker compose up -d --build
Open http://<host-address>:8788. A named volume persists your saved projects.
Alternatively run Python 3.10+ directly:
  python3 server.py --port 8788 --data ./data
No pip or npm install is required to run the packaged app.

MODELLING
Fit to hole can resize and centre a shape in an opening. Set clearance to 0
for matching dimensions, or choose a positive clearance for a removable insert.
The selected part retains its editable geometry. Cut below plane seals a flat
base at Z = 0, and capsule end curvature remains independently adjustable.
Use shapes, millimetre dimensions and move/rotate/scale controls. Solid boolean
operations and negative objects are evaluated before export. Keep the editable
project JSON as well as the printable STL: an STL stores triangles, not editing
history or colours. Final slicing and printer settings belong in your slicer.

LAYER LIBRARY
Optional: enter its direct LAN address in Solid Studio Settings. The default
is empty. Use Send to Layer Library or select Layer Library during export.
STL transfers go into the Solid Studio collection. Save/download
the editable project separately, especially for imported meshes or large files.

GITHUB
The source ZIP is ready for a new public repository. Extract it and upload its
contents at the repository root, including .github, .gitignore and .env.example.
Do not upload your data directory, .env or personal models. The included MIT
licence permits other people to use and modify the app. See docs/PUBLISHING.md
for browser and Git upload steps; the package does not publish anything itself.

See README.md in the ZIP for controls, supported scope and deployment details.
""")
    sums = output / "SHA256SUMS_Solid_Studio.txt"
    sums.write_text("".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n" for path in (archive_path, installer_path, quickstart)))
    print(f"Packaged {len(files)} files; ZIP {len(raw):,} bytes; SHA256 {checksum}")
    for path in (archive_path, installer_path, quickstart, sums):
        print(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release")
    package(parser.parse_args().output)
