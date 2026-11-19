import base64
from contextlib import contextmanager
import copy
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server


def project(name="Test project"):
    return {"format": "solid-studio", "version": 1, "name": name, "settings": {"gridSize": 256}, "objects": [
        {"id": "box-1", "name": "Box", "type": "box", "role": "solid", "visible": True, "locked": False,
         "params": {"width": 20, "depth": 20, "height": 20}, "transform": {"position": [0, 0, 10], "rotation": [0, 0, 0], "scale": [1, 1, 1]}}
    ]}


def tetra_stl():
    faces = [((0,0,0),(0,1,0),(1,0,0)), ((0,0,0),(1,0,0),(0,0,1)),
             ((0,0,0),(0,0,1),(0,1,0)), ((1,0,0),(0,1,0),(0,0,1))]
    return bytes(80) + struct.pack("<I", 4) + b"".join(struct.pack("<12fH", 0,0,0, *a,*b,*c,0) for a,b,c in faces)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.static = self.directory / "static"
        self.static.mkdir()
        self.importmap = '{"imports":{"three":"./three.js"}}'
        (self.static / "index.html").write_text('<!doctype html><script type="importmap">' + self.importmap + '</script><h1>Solid Studio</h1>')
        (self.static / "test.wasm").write_bytes(b"\0asm\x01\0\0\0")
        (self.directory / "secret.txt").write_text("private")
        self.store = server.Store(self.directory / "data")
        self.http = server.StudioServer(("127.0.0.1", 0), self.store, self.static)
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=8)
        values = {"X-Solid-Studio": "1"}
        if body is not None:
            values["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        values.update(headers or {})
        connection.request(method, path, body, values)
        response = connection.getresponse()
        data, received_headers = response.read(), dict(response.getheaders())
        status = response.status
        connection.close()
        if received_headers.get("Content-Type", "").startswith("application/json") and data:
            data = json.loads(data)
        return status, data, received_headers

    def create(self, name="Test project"):
        status, data, _ = self.request("POST", "/api/projects", {"project": project(name)})
        self.assertEqual(status, 201, data)
        return data["project"]

    def test_empty_start_and_health(self):
        self.assertEqual(self.request("GET", "/api/projects")[1], {"projects": []})
        self.assertEqual(self.request("GET", "/api/settings")[1]["layerLibraryUrl"], "")
        self.assertEqual(self.request("GET", "/api/health")[1]["service"], "solid-studio")

    def test_capsule_curvature_and_cut_planes_roundtrip(self):
        document = project("Cut capsule")
        obj = document["objects"][0]
        obj["type"] = "capsule"
        obj["params"].update(topRoundness=0, bottomRoundness=1.75)
        obj["clipPlanes"] = [{"normal": [0, 0, 1], "offset": -4}]
        status, saved, _ = self.request("POST", "/api/projects", {"project": document})
        self.assertEqual(status, 201)
        self.assertEqual(self.request("GET", "/api/projects/" + saved["project"]["id"])[1]["project"]["document"], document)
        for invalid in (-0.1, 2.1, "1", True):
            bad = copy.deepcopy(document)
            bad["objects"][0]["params"]["topRoundness"] = invalid
            self.assertEqual(self.request("POST", "/api/projects", {"project": bad})[0], 400)
        for planes in ([{"normal": [0, 0, 0], "offset": 0}], [{"normal": [0, 0, 1], "offset": "0"}],
                       [{"normal": [0, 0, 1e7], "offset": 0}], [obj["clipPlanes"][0]] * 33, None):
            bad = copy.deepcopy(document)
            bad["objects"][0]["clipPlanes"] = planes
            self.assertEqual(self.request("POST", "/api/projects", {"project": bad})[0], 400)

    def test_create_update_conflict_delete_and_persistence(self):
        record = self.create()
        endpoint = "/api/projects/" + record["id"]
        self.assertEqual(self.request("GET", endpoint)[1]["project"]["document"], project())
        saved = self.request("PUT", endpoint, {"project": project("Changed"), "expectedRevision": 1})
        self.assertEqual(saved[0], 200, saved[1])
        self.assertEqual(saved[1]["project"]["revision"], 2)
        self.assertEqual(self.request("PUT", endpoint, {"project": project("Stale"), "expectedRevision": 1})[0], 409)
        self.assertEqual(self.request("PUT", endpoint, {"project": project("Missing revision")})[0], 409)
        reopened = server.Store(self.directory / "data")
        self.assertEqual(reopened.get_project(record["id"])["name"], "Changed")
        self.assertEqual(self.request("DELETE", endpoint, {"expectedRevision": 1})[0], 409)
        self.assertEqual(self.request("DELETE", endpoint, {"expectedRevision": 2})[0], 200)
        self.assertEqual(self.request("GET", "/api/projects")[1]["projects"], [])
        self.assertEqual(self.request("GET", endpoint)[0], 404)
        with sqlite3.connect(self.store.db_path) as db:
            self.assertIsNotNone(db.execute("SELECT deleted_at FROM projects WHERE id=?", (record["id"],)).fetchone()[0])

    def test_delete_is_committed_before_response(self):
        record = self.create()
        observed = []
        original = server.Handler.send
        def inspect(handler, status, payload, content_type="application/json; charset=utf-8"):
            if handler.command == "DELETE" and status == 200:
                # A separate SQLite connection at the exact response boundary.
                observed.append(self.store.list_projects())
            return original(handler, status, payload, content_type)
        with patch.object(server.Handler, "send", inspect):
            self.assertEqual(self.request("DELETE", "/api/projects/" + record["id"], {"expectedRevision": 1})[0], 200)
        self.assertEqual(observed, [[]])

    def test_static_wasm_head_csp_and_traversal(self):
        status, body, headers = self.request("GET", "/test.wasm")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/wasm")
        self.assertEqual(body, b"\0asm\x01\0\0\0")
        head = self.request("HEAD", "/test.wasm")
        self.assertEqual(head[1], b"")
        self.assertEqual(head[2]["Content-Length"], "8")
        policy = self.request("GET", "/")[2]["Content-Security-Policy"]
        self.assertIn("'wasm-unsafe-eval'", policy)
        self.assertIn("'sha256-" + base64.b64encode(hashlib.sha256(self.importmap.encode()).digest()).decode() + "'", policy)
        for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/.env", "/missing"):
            self.assertEqual(self.request("GET", path)[0], 404, path)

    def test_mutation_origin_and_header(self):
        body = {"project": project()}
        self.assertEqual(self.request("POST", "/api/projects", body, {"X-Solid-Studio": ""})[0], 403)
        self.assertEqual(self.request("POST", "/api/projects", body, {"Origin": "https://foreign.invalid"})[0], 403)
        self.assertEqual(self.request("POST", "/api/projects", body, {"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("POST", "/api/projects", body, {"Origin": "http://127.0.0.1:" + str(self.http.server_port)})[0], 201)

    def test_project_and_mesh_validation(self):
        for identifier in ('"><img src=x>', 'x' * 129):
            invalid = project()
            invalid["objects"][0]["id"] = identifier
            self.assertEqual(self.request("POST", "/api/projects", {"project": invalid})[0], 400)
        invalid = project()
        invalid["objects"].append(copy.deepcopy(invalid["objects"][0]))
        self.assertEqual(self.request("POST", "/api/projects", {"project": invalid})[0], 400)
        invalid = project()
        invalid["objects"][0]["transform"]["scale"][0] = 0
        self.assertEqual(self.request("POST", "/api/projects", {"project": invalid})[0], 400)
        invalid = project()
        invalid["objects"][0]["transform"]["position"][0] = float("nan")
        self.assertEqual(self.request("POST", "/api/projects", {"project": invalid})[0], 400)
        invalid = project()
        invalid["objects"][0]["type"] = "mesh"
        invalid["objects"][0]["params"] = {"positions": [0,0,0,1,0,0,0,1,0,0,0,1], "indices": [0,1,99] * 4}
        self.assertEqual(self.request("POST", "/api/projects", {"project": invalid})[0], 400)
        self.assertEqual(self.request("PUT", "/api/projects/" + str(uuid.uuid4()), {"project": project(), "expectedRevision": 1})[0], 404)
        self.assertEqual(self.request("GET", "/api/projects/not-an-id")[0], 400)

    def test_private_library_urls_only(self):
        for url in ("http://8.8.8.8:8777", "file:///tmp/x", "http://user:password@localhost:8777", "http://localhost:8777/path", "http://169.254.169.254"):
            self.assertEqual(self.request("PUT", "/api/settings", {"layerLibraryUrl": url})[0], 400, url)
        self.assertEqual(self.request("PUT", "/api/settings", {"layerLibraryUrl": "http://127.0.0.1:8777"})[0], 200)
        self.assertEqual(self.request("PUT", "/api/settings", {"layerLibraryUrl": ""})[1]["layerLibraryUrl"], "")
        self.assertEqual(self.request("POST", "/api/library/test", {})[0], 400)

    @contextmanager
    def library(self, *, existing=False, broken=False):
        state = {"uploads": 0, "edits": 0, "model_id": str(uuid.uuid4())}
        class LibraryHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def respond(self, data):
                raw = json.dumps(data).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                if self.path == "/api/session":
                    self.send_header("Set-Cookie", "layer_library_session=test; Path=/; HttpOnly")
                self.end_headers()
                self.wfile.write(raw)
            def do_GET(self):
                if self.path == "/api/session":
                    self.respond({"app_name": "Layer Library", "authenticated": True, "login_required": False,
                                  "access_mode": "trusted_lan", "csrf_token": "t" * 32})
                else:
                    self.respond({"items": [{"id": state["model_id"]}] if existing else []})
            def do_POST(self):
                state["uploads"] += 1
                content = self.rfile.read(int(self.headers["Content-Length"]))
                state["csrf"] = self.headers.get("X-CSRF-Token")
                state["cookie"] = self.headers.get("Cookie")
                filename = content.split(b'filename="', 1)[1].split(b'"', 1)[0].decode()
                self.respond({"items": []} if broken else {"items": [{"id": state["model_id"], "filename": "existing.stl" if existing else filename, "collection": "Existing" if existing else "Solid Studio"}]})
            def do_PUT(self):
                state["edits"] += 1
                state["metadata"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.respond({"ok": True})
        http = ThreadingHTTPServer(("127.0.0.1", 0), LibraryHandler)
        thread = threading.Thread(target=http.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        thread.start()
        self.request("PUT", "/api/settings", {"layerLibraryUrl": "http://127.0.0.1:" + str(http.server_port)})
        try:
            yield state
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def transfer(self):
        return {"name": "Solid model", "project": project(), "requestId": str(uuid.uuid4()), "stlBase64": base64.b64encode(tetra_stl()).decode()}

    def test_library_export_session_and_idempotent_receipt(self):
        with self.library() as state:
            payload = self.transfer()
            first = self.request("POST", "/api/library/export", payload)
            self.assertEqual(first[0], 200, first[1])
            self.assertTrue(first[1]["projectIncluded"])
            self.assertEqual(self.request("POST", "/api/library/export", payload)[1], first[1])
            self.assertEqual(state["uploads"], 1)
            self.assertEqual(state["edits"], 1)
            self.assertEqual(state["csrf"], "t" * 32)
            self.assertIn("layer_library_session=", state["cookie"])
            self.assertIn('"format": "solid-studio"', state["metadata"]["notes"])
            payload["name"] = "Different metadata"
            self.assertEqual(self.request("POST", "/api/library/export", payload)[0], 409)

    def test_library_duplicate_metadata_is_preserved(self):
        with self.library(existing=True) as state:
            result = self.request("POST", "/api/library/export", self.transfer())
            self.assertEqual(result[0], 200, result[1])
            self.assertTrue(result[1]["reused"])
            self.assertEqual(state["edits"], 0)

    def test_library_receipt_is_bound_to_its_destination(self):
        payload = self.transfer()
        with self.library() as first_library:
            first = self.request("POST", "/api/library/export", payload)
            self.assertEqual(first[0], 200, first[1])
            self.assertEqual(first_library["uploads"], 1)
        with self.library() as second_library:
            repeated = self.request("POST", "/api/library/export", payload)
            self.assertEqual(repeated[0], 409, repeated[1])
            self.assertIn("Layer Library address", repeated[1]["error"])
            self.assertEqual(second_library["uploads"], 0)
            payload["requestId"] = str(uuid.uuid4())
            second = self.request("POST", "/api/library/export", payload)
            self.assertEqual(second[0], 200, second[1])
            self.assertNotEqual(first[1]["url"], second[1]["url"])
            self.assertEqual(second_library["uploads"], 1)

    def test_library_destination_change_during_export_is_rejected_before_upload(self):
        with self.library() as state:
            payload = self.transfer()
            payload["expectedLibraryUrl"] = "http://127.0.0.1:1"
            result = self.request("POST", "/api/library/export", payload)
            self.assertEqual(result[0], 409, result[1])
            self.assertIn("changed", result[1]["error"])
            self.assertEqual(state["uploads"], 0)
            payload["expectedLibraryUrl"] = self.store.settings()["layerLibraryUrl"] + "/"
            result = self.request("POST", "/api/library/export", payload)
            self.assertEqual(result[0], 200, result[1])
            self.assertEqual(state["uploads"], 1)

    def test_library_uncertain_upload_is_not_retried(self):
        with self.library(broken=True) as state:
            payload = self.transfer()
            self.assertEqual(self.request("POST", "/api/library/export", payload)[0], 502)
            again = self.request("POST", "/api/library/export", payload)
            self.assertEqual(again[0], 409)
            self.assertTrue(again[1]["uncertain"])
            self.assertEqual(state["uploads"], 1)

    def test_library_invalid_stl_is_rejected_before_network(self):
        payload = self.transfer()
        payload["stlBase64"] = base64.b64encode(b"bad").decode()
        self.assertEqual(self.request("POST", "/api/library/export", payload)[0], 400)
        payload["stlBase64"] = "!notbase64!"
        self.assertEqual(self.request("POST", "/api/library/export", payload)[0], 400)


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("solid_installer", ROOT / "tools" / "install_template.py")
        cls.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.installer)

    def archive(self, extra=None):
        raw = io.BytesIO()
        names = ["server.py", "Dockerfile", "static/index.html", "static/app.js", "static/geometry.js", "static/geometry-worker.js", "static/viewport.js", "static/vendor/manifold.wasm"]
        with zipfile.ZipFile(raw, "w") as archive:
            for name in names:
                archive.writestr(name, b"placeholder")
            if extra:
                archive.writestr(extra, b"unsafe")
        return raw.getvalue()

    def test_bundle_paths_and_checksum(self):
        self.installer.validate_archive(self.archive())
        for name in ("../../escape", "/absolute", "static/../../escape", "server.py"):
            with self.assertRaises(self.installer.InstallError):
                self.installer.validate_archive(self.archive(name))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bundle.zip"
            path.write_bytes(self.archive())
            with patch.object(self.installer, "BUNDLE_SHA256", "0" * 64):
                with self.assertRaises(self.installer.InstallError):
                    self.installer.read_bundle(path)

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "apps" / "solid_studio"
            bundle = Path(directory) / "bundle.zip"
            bundle.write_bytes(self.archive())
            with patch.object(self.installer.shutil, "which", return_value=None), patch.object(self.installer, "select_port", return_value=8788):
                self.assertEqual(self.installer.main(["--bundle", str(bundle), "--root", str(root), "--dry-run"]), 0)
            self.assertFalse(root.exists())

    def test_occupied_port_and_no_other_apps_in_config(self):
        with socket_server() as port:
            self.assertFalse(self.installer.port_available(port, []))
        config = self.installer.compose_config(Path("/mnt/apps/solid_studio"), "local/test:1", 8788, "f" * 64)
        self.assertEqual(set(config["services"]), {"solid-studio"})
        self.assertEqual(config["services"]["solid-studio"]["pull_policy"], "never")
        self.assertEqual(config["services"]["solid-studio"]["volumes"][0]["source"], "/mnt/apps/solid_studio/data")


@contextmanager
def socket_server():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("0.0.0.0", 0))
        sock.listen()
        yield sock.getsockname()[1]


if __name__ == "__main__":
    unittest.main()
