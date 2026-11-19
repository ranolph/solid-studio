#!/usr/bin/env python3
"""Solid Studio: local projects and optional Layer Library transfer; geometry runs in the browser."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from http import cookies
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import logging
import math
import mimetypes
import os
from pathlib import Path
import re
import socket
import sqlite3
import ssl
import struct
import threading
from urllib.parse import unquote, urlsplit
import uuid

VERSION = "1.2.0"
MAX_PROJECT = 20 * 1024 * 1024
MAX_STL = 40 * 1024 * 1024
MAX_EXPORT = 76 * 1024 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
LOG = logging.getLogger("solid-studio")
LOCAL_NETWORKS = tuple(ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
    "127.0.0.0/8", "::1/128", "fc00::/7",
))
NODE_TYPES = {"box", "roundedBox", "cylinder", "cone", "sphere", "torus", "tube", "wedge", "pyramid", "polygon", "capsule", "gear", "mesh", "boolean"}


class APIError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def json_bytes(value, *, canonical=False):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=canonical, separators=(",", ":")).encode("utf-8")


def valid_id(value):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise APIError(400, "The project or request ID is invalid.") from None


def clean_name(value):
    if not isinstance(value, str):
        raise APIError(400, "Give the project a name.")
    value = "".join(c for c in value if c.isprintable()).strip()
    if not value or len(value) > 120:
        raise APIError(400, "Use a project name between 1 and 120 characters.")
    return value


def finite(value, limit=1e7):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(value) <= limit


def validate_project(project):
    if not isinstance(project, dict) or project.get("format") != "solid-studio" or type(project.get("version")) is not int or project.get("version") != 1:
        raise APIError(400, "Choose a Solid Studio version 1 project.")
    clean_name(project.get("name"))
    if not isinstance(project.get("objects"), list) or len(project["objects"]) > 256:
        raise APIError(400, "A project can contain at most 256 objects.")
    try:
        encoded = json_bytes(project)
    except (ValueError, TypeError, RecursionError):
        raise APIError(400, "Project values must be valid finite JSON.") from None
    if len(encoded) > MAX_PROJECT:
        raise APIError(413, "This project exceeds the 20 MiB project limit.")
    identifiers = set()
    count = 0
    imported_triangles = 0
    def node(item, depth=0):
        nonlocal count, imported_triangles
        count += 1
        if count > 256 or depth > 24:
            raise APIError(400, "The project has too many objects or nested operations.")
        if not isinstance(item, dict) or item.get("type") not in NODE_TYPES:
            raise APIError(400, "The project contains an unsupported object.")
        identifier = item.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier) or identifier in identifiers:
            raise APIError(400, "Each object must have a unique ID.")
        identifiers.add(identifier)
        if item.get("role", "solid") not in ("solid", "hole"):
            raise APIError(400, "An object must be a solid or a hole.")
        for key in ("visible", "locked"):
            if key in item and not isinstance(item[key], bool):
                raise APIError(400, "Object visibility and lock values must be true or false.")
        transform = item.get("transform", {})
        if not isinstance(transform, dict):
            raise APIError(400, "Object transforms are invalid.")
        for key in ("position", "rotation", "scale"):
            vector = transform.get(key, [1, 1, 1] if key == "scale" else [0, 0, 0])
            if not isinstance(vector, list) or len(vector) != 3 or not all(finite(v) for v in vector):
                raise APIError(400, "Object transforms must contain three finite numbers.")
            if key == "scale" and any(abs(v) < 1e-6 or abs(v) > 10000 for v in vector):
                raise APIError(400, "Object scale must be nonzero and within the supported range.")
        params = item.get("params", {})
        if not isinstance(params, dict):
            raise APIError(400, "Object parameters must be an object.")
        if "clipPlanes" in item:
            planes = item["clipPlanes"]
            if not isinstance(planes, list) or len(planes) > 32:
                raise APIError(400, "An object can contain at most 32 clipping planes.")
            for plane in planes:
                if not isinstance(plane, dict):
                    raise APIError(400, "Clipping planes must contain a normal and offset.")
                normal = plane.get("normal")
                if (not isinstance(normal, list) or len(normal) != 3 or not all(finite(v, 1000000) for v in normal)
                        or math.hypot(*normal) < 1e-9 or not finite(plane.get("offset"), 1000000)):
                    raise APIError(400, "A clipping plane needs a finite nonzero normal and a finite offset.")
        if item["type"] == "capsule":
            for end in ("topRoundness", "bottomRoundness"):
                if end in params and (not finite(params[end], 2) or params[end] < 0):
                    raise APIError(400, "Capsule end roundness must be from 0 to 2.")
        if item["type"] == "mesh":
            positions, indices = params.get("positions"), params.get("indices")
            if (not isinstance(positions, list) or not isinstance(indices, list) or len(positions) % 3 or len(indices) % 3
                    or not 12 <= len(positions) <= 2250000 or not 12 <= len(indices) <= 750000
                    or any(not finite(v, 1000000) for v in positions)
                    or any(type(v) is not int or v < 0 or v >= len(positions) // 3 for v in indices)):
                raise APIError(400, "The imported mesh contains invalid or excessive vertex data.")
            imported_triangles += len(indices) // 3
            if imported_triangles > 250000:
                raise APIError(400, "Imported geometry exceeds 250,000 triangles per project.")
        if item["type"] == "boolean":
            children = item.get("children")
            if item.get("operation") not in ("union", "difference", "intersection") or not isinstance(children, list) or not children:
                raise APIError(400, "A solid operation requires its source objects.")
            for child in children:
                node(child, depth + 1)
    for item in project["objects"]:
        node(item)
    return project


def parse_library_url(value, resolve=False):
    if not isinstance(value, str) or len(value) > 256:
        raise APIError(400, "Enter a Layer Library address.")
    value = value.strip().rstrip("/")
    if not value:
        return None
    try:
        parsed = urlsplit(value)
        if (any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value or parsed.scheme not in ("http", "https")
                or not parsed.hostname or parsed.username is not None or parsed.password is not None
                or parsed.path or parsed.query or parsed.fragment):
            raise ValueError()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if not 1 <= port <= 65535:
            raise ValueError()
    except ValueError:
        raise APIError(400, "Use a direct HTTP or HTTPS Layer Library address without a path.") from None
    try:
        addresses = [str(ipaddress.ip_address(parsed.hostname))]
    except ValueError:
        if not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", parsed.hostname):
            raise APIError(400, "The Layer Library hostname is invalid.")
        if not resolve:
            return value
        try:
            addresses = list(dict.fromkeys(info[4][0] for info in socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)))
        except OSError:
            raise APIError(502, "The server cannot resolve this Layer Library address.") from None
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if not any(ip.version == network.version and ip in network for network in LOCAL_NETWORKS):
            raise APIError(400, "Use the private LAN or Tailscale address of Layer Library.")
    return (parsed, addresses) if resolve else value


class Store:
    def __init__(self, directory, default_library=""):
        self.path = Path(directory).resolve()
        self.path.mkdir(parents=True, exist_ok=True)
        self.db_path = self.path / "solid-studio.sqlite3"
        self.export_slots = threading.BoundedSemaphore(1)
        default_library = parse_library_url(default_library) or ""
        with self.db() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS projects(
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, document TEXT NOT NULL,
                    revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    deleted_at TEXT, object_count INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS exports(
                    id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,response TEXT,updated_at TEXT NOT NULL
                );
            """)
            db.execute("INSERT OR IGNORE INTO settings VALUES('layerLibraryUrl',?)", (default_library,))
            db.execute("UPDATE exports SET state='uncertain',updated_at=? WHERE state='sending'", (now(),))

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def settings(self):
        with self.db() as db:
            value = db.execute("SELECT value FROM settings WHERE key='layerLibraryUrl'").fetchone()[0]
        return {"version": VERSION, "layerLibraryUrl": value}

    @staticmethod
    def record(row, document=True):
        result = {"id": row["id"], "name": row["name"], "revision": row["revision"],
                  "createdAt": row["created_at"], "updatedAt": row["updated_at"], "objectCount": row["object_count"]}
        if document:
            result["document"] = json.loads(row["document"])
        return result

    def list_projects(self):
        with self.db() as db:
            rows = db.execute("SELECT id,name,revision,created_at,updated_at,object_count FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC").fetchall()
        return [self.record(row, False) for row in rows]

    def get_project(self, identifier):
        with self.db() as db:
            row = db.execute("SELECT * FROM projects WHERE id=? AND deleted_at IS NULL", (valid_id(identifier),)).fetchone()
        if row is None:
            raise APIError(404, "Project not found.")
        return self.record(row)

    def save_project(self, payload, identifier=None):
        project = validate_project(payload.get("project"))
        identifier = valid_id(identifier) if identifier else str(uuid.uuid4())
        stamp = now()
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT * FROM projects WHERE id=?", (identifier,)).fetchone()
            if previous:
                if previous["deleted_at"]:
                    raise APIError(409, "This project was deleted. Save a new copy.")
                expected = payload.get("expectedRevision")
                if type(expected) is not int or expected != previous["revision"]:
                    raise APIError(409, "This project changed on another device. Reopen it or save a copy.", currentRevision=previous["revision"])
                db.execute("UPDATE projects SET name=?,document=?,revision=revision+1,updated_at=?,object_count=? WHERE id=?",
                           (clean_name(project["name"]), json_bytes(project).decode(), stamp, len(project["objects"]), identifier))
            else:
                if "expectedRevision" in payload:
                    raise APIError(404, "Project not found. Save a new copy.")
                db.execute("INSERT INTO projects VALUES(?,?,?,1,?,?,NULL,?)",
                           (identifier, clean_name(project["name"]), json_bytes(project).decode(), stamp, stamp, len(project["objects"])))
            row = db.execute("SELECT * FROM projects WHERE id=?", (identifier,)).fetchone()
        return self.record(row)  # Transaction commits before an HTTP success can be sent.

    def delete_project(self, identifier, expected):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT revision FROM projects WHERE id=? AND deleted_at IS NULL", (valid_id(identifier),)).fetchone()
            if row is None:
                raise APIError(404, "Project not found.")
            if type(expected) is not int or expected != row["revision"]:
                raise APIError(409, "This project changed on another device. Reopen the projects list first.")
            db.execute("UPDATE projects SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?", (now(), now(), identifier))
        return {"ok": True}

    def export_receipt(self, identifier, digest):
        with self.db() as db:
            row = db.execute("SELECT * FROM exports WHERE id=?", (identifier,)).fetchone()
        if row is None:
            return None
        if row["digest"] != digest:
            raise APIError(409, "This transfer ID belongs to a different model or Layer Library address.")
        if row["state"] == "complete":
            return json.loads(row["response"])
        raise APIError(409, "This transfer may already have reached Layer Library. Check its Solid Studio collection before starting a new transfer.", uncertain=True, requestId=identifier)

    def finish_export(self, identifier, state, response):
        with self.db() as db:
            db.execute("UPDATE exports SET state=?,response=?,updated_at=? WHERE id=?", (state, json_bytes(response).decode(), now(), identifier))


class LocalHTTP:
    """Private-address HTTP client with pinned DNS, no redirects and no proxy."""
    def __init__(self, base):
        self.base, self.cookie, self.csrf = base, "", ""

    def request(self, method, path, body=None, headers=None, timeout=12):
        parsed, addresses = parse_library_url(self.base, resolve=True)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        connection = http.client.HTTPConnection(parsed.hostname, port, timeout=timeout)
        sock = socket.create_connection((addresses[0], port), timeout=timeout)
        if parsed.scheme == "https":
            try:
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parsed.hostname)
            except Exception:
                sock.close()
                raise
        connection.sock = sock
        request_headers = {"Host": parsed.netloc, "Origin": self.base, "Accept": "application/json", "Connection": "close", "User-Agent": "Solid-Studio/" + VERSION}
        if self.cookie:
            request_headers["Cookie"] = self.cookie
        if self.csrf:
            request_headers["X-CSRF-Token"] = self.csrf
        request_headers.update(headers or {})
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE or 300 <= response.status < 400:
                raise APIError(502, "Layer Library returned an oversized response or redirect. Use its direct address.")
            for key, value in response.getheaders():
                if key.lower() == "set-cookie":
                    jar = cookies.SimpleCookie()
                    jar.load(value)
                    if "layer_library_session" in jar:
                        self.cookie = "layer_library_session=" + jar["layer_library_session"].value
            try:
                data = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise APIError(502, "The address did not return a Layer Library API response.") from None
            if response.status >= 400:
                detail = data.get("detail", data.get("error", "Request rejected")) if isinstance(data, dict) else "Request rejected"
                raise APIError(502, "Layer Library: " + str(detail)[:300])
            return data
        finally:
            connection.close()

    def prepare(self):
        result = self.request("GET", "/api/session")
        if (not isinstance(result, dict) or result.get("app_name") != "Layer Library" or result.get("authenticated") is not True
                or result.get("login_required") is not False or result.get("access_mode") != "trusted_lan" or not self.cookie):
            raise APIError(502, "This address is not a supported open-access Layer Library.")
        token = result.get("csrf_token")
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{20,128}", token):
            raise APIError(502, "Layer Library did not provide an upload session.")
        self.csrf = token
        return result


def validate_stl(data):
    if not 84 <= len(data) <= MAX_STL:
        raise APIError(400, "The STL is incomplete or exceeds 40 MiB.")
    count = struct.unpack_from("<I", data, 80)[0]
    if count < 4 or 84 + 50 * count != len(data):
        raise APIError(400, "Export a complete binary STL from Solid Studio.")
    for offset in range(84, len(data), 50):
        if not all(math.isfinite(v) and abs(v) <= 1000000 for v in struct.unpack_from("<12f", data, offset)):
            raise APIError(400, "The STL contains invalid coordinates.")


def export_to_library(store, payload):
    name, project = clean_name(payload.get("name")), validate_project(payload.get("project"))
    identifier = valid_id(payload.get("requestId") or str(uuid.uuid4()))
    base = store.settings()["layerLibraryUrl"]
    if "expectedLibraryUrl" in payload:
        expected = parse_library_url(payload["expectedLibraryUrl"]) or ""
        if expected != base:
            raise APIError(409, "The Layer Library address changed while preparing this export. Reopen Export and try again.")
    if not base:
        raise APIError(400, "Set your Layer Library address in Settings first.")
    encoded = payload.get("stlBase64")
    if not isinstance(encoded, str) or len(encoded) > ((MAX_STL + 2) // 3) * 4:
        raise APIError(413, "The exported STL exceeds the transfer limit.")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error):
        raise APIError(400, "The exported STL data is invalid.") from None
    validate_stl(data)
    hasher = hashlib.sha256(data)
    # A receipt confirms one destination as well as one model. Never return an
    # earlier library's success after the configured address has changed.
    hasher.update(json_bytes({"name": name, "project": project, "libraryUrl": base}, canonical=True))
    digest = hasher.hexdigest()
    previous = store.export_receipt(identifier, digest)
    if previous:
        return previous
    if not store.export_slots.acquire(blocking=False):
        raise APIError(429, "Another Layer Library transfer is still running.")
    try:
        previous = store.export_receipt(identifier, digest)
        if previous:
            return previous
        client = LocalHTTP(base)
        try:
            client.prepare()
        except (OSError, http.client.HTTPException):
            raise APIError(502, "Cannot reach Layer Library. Check its address and that the app is running.") from None
        known = None
        try:
            catalog = client.request("GET", "/api/library")
            if isinstance(catalog, dict) and isinstance(catalog.get("items"), list):
                known = {item["id"] for item in catalog["items"] if isinstance(item, dict) and isinstance(item.get("id"), str)}
        except (APIError, OSError, http.client.HTTPException):
            pass
        with store.db() as db:
            db.execute("INSERT INTO exports VALUES(?,?,?,NULL,?)", (identifier, digest, "sending", now()))
        slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip(".-")[:70] or "solid-studio-design"
        filename = slug + "--ss-" + uuid.UUID(identifier).hex + ".stl"
        boundary = "solidstudio" + uuid.uuid4().hex
        prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="collection"\r\n\r\nSolid Studio\r\n'
                  f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{filename}"\r\n'
                  'Content-Type: application/octet-stream\r\n\r\n').encode()
        suffix = f"\r\n--{boundary}--\r\n".encode()
        try:
            receipt = client.request("POST", "/api/models/upload", (prefix, data, suffix),
                                     {"Content-Type": "multipart/form-data; boundary=" + boundary,
                                      "Content-Length": str(len(prefix) + len(data) + len(suffix))}, timeout=120)
            if not isinstance(receipt, dict) or not isinstance(receipt.get("items"), list) or len(receipt["items"]) != 1:
                raise ValueError("No model receipt")
            item = receipt["items"][0]
            model_id = item.get("id") if isinstance(item, dict) else None
            if not isinstance(model_id, str) or not re.fullmatch(r"[a-f0-9-]{16,40}", model_id):
                raise ValueError("Invalid model receipt")
        except (APIError, ValueError, OSError, http.client.HTTPException):
            message = "The upload could not be confirmed. Check Layer Library before starting another transfer."
            store.finish_export(identifier, "uncertain", {"error": message, "requestId": identifier})
            raise APIError(502, message, uncertain=True, requestId=identifier) from None
        reused = (known is not None and model_id in known) or item.get("filename") != filename
        fresh = (known is not None and model_id not in known and item.get("filename") == filename
                 and item.get("collection") == "Solid Studio" and not item.get("notes") and not item.get("tags"))
        response = {"ok": True, "requestId": identifier, "modelId": model_id, "url": base + "/", "reused": reused,
                    "projectIncluded": False, "message": "This exact STL is already in Layer Library; existing details were preserved." if reused else "Saved to Layer Library."}
        store.finish_export(identifier, "complete", response)
        if fresh:
            notes = "Created with Solid Studio. Dimensions are in millimetres.\n\n" + json.dumps(project, ensure_ascii=False)
            fits = len(notes) <= 10000
            if not fits:
                notes = "Created with Solid Studio. Save or download the editable Solid Studio project separately; it exceeds the notes limit."
            try:
                client.request("PUT", "/api/models/" + model_id,
                               json_bytes({"title": name, "collection": "Solid Studio", "tags": ["solid-studio"], "notes": notes}), {"Content-Type": "application/json"})
                response["projectIncluded"] = fits
            except (APIError, OSError, http.client.HTTPException):
                response["warning"] = "The STL was saved, but the descriptive notes could not be updated. Keep the project JSON separately."
            if not fits:
                response["warning"] = "The STL was saved. Keep the project JSON separately because it exceeds Layer Library's notes limit."
        elif not reused:
            response["warning"] = "The STL was saved; existing metadata was left untouched because ownership could not be verified."
        store.finish_export(identifier, "complete", response)
        return response
    finally:
        store.export_slots.release()


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 24

    def __init__(self, address, store, static):
        self.store, self.static = store, Path(static).resolve()
        self.slots = threading.BoundedSemaphore(16)
        self.large_slots = threading.BoundedSemaphore(1)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "SolidStudio/" + VERSION
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def log_message(self, fmt, *args):
        LOG.info("%s %s", self.client_address[0], fmt % args)

    def send(self, status, payload, content_type="application/json; charset=utf-8"):
        if not isinstance(payload, bytes):
            payload = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        hashes = ""
        if content_type.startswith("text/html"):
            for match in re.finditer(rb'<script\b[^>]*type=[\"\']importmap[\"\'][^>]*>(.*?)</script>', payload, re.S | re.I):
                hashes += " 'sha256-" + base64.b64encode(hashlib.sha256(match[1]).digest()).decode() + "'"
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" + hashes + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def mutation_check(self):
        if self.headers.get("X-Solid-Studio") != "1":
            raise APIError(403, "Refresh Solid Studio before trying again.")
        if self.headers.get("Sec-Fetch-Site", "").lower() not in ("", "same-origin", "none"):
            raise APIError(403, "Cross-site requests are not allowed.")
        origin = self.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if (parsed.scheme not in ("http", "https") or parsed.netloc.lower() != self.headers.get("Host", "").lower()
                    or parsed.path or parsed.query or parsed.fragment or parsed.username is not None):
                raise APIError(403, "Cross-site requests are not allowed.")

    def json_body(self, limit=MAX_PROJECT + 4096):
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            raise APIError(415, "Send the project as JSON.")
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
            raise APIError(400, "Send one Content-Length header.")
        try:
            length = int(self.headers["Content-Length"])
        except ValueError:
            raise APIError(400, "The request length is invalid.") from None
        if not 0 <= length <= limit:
            raise APIError(413, "The request is too large.")
        data = self.rfile.read(length)
        if len(data) != length:
            raise APIError(400, "The request was interrupted.")
        try:
            result = json.loads(data, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise APIError(400, "The JSON project is invalid.") from None
        if not isinstance(result, dict):
            raise APIError(400, "Expected a JSON object.")
        return result

    def handle_api(self):
        route, store = urlsplit(self.path).path, self.server.store
        method = "GET" if self.command == "HEAD" else self.command
        if method not in ("GET", "OPTIONS"):
            self.mutation_check()
        if method == "GET" and route == "/api/health":
            return self.send(200, {"ok": True, "service": "solid-studio", "version": VERSION,
                                   "bundle": os.environ.get("SOLID_STUDIO_BUNDLE", "development")})
        if route == "/api/settings":
            if method == "GET":
                return self.send(200, store.settings())
            if method == "PUT":
                value = parse_library_url(self.json_body(4096).get("layerLibraryUrl")) or ""
                with store.db() as db:
                    db.execute("UPDATE settings SET value=? WHERE key='layerLibraryUrl'", (value,))
                return self.send(200, store.settings())
        if route == "/api/projects":
            if method == "GET":
                return self.send(200, {"projects": store.list_projects()})
            if method == "POST":
                return self.send(201, {"project": store.save_project(self.json_body())})
        match = re.fullmatch(r"/api/projects/([^/]+)", route)
        if match:
            identifier = valid_id(match[1])
            if method == "GET":
                return self.send(200, {"project": store.get_project(identifier)})
            if method == "PUT":
                store.get_project(identifier)
                return self.send(200, {"project": store.save_project(self.json_body(), identifier)})
            if method == "DELETE":
                return self.send(200, store.delete_project(identifier, self.json_body(4096).get("expectedRevision")))
        if route == "/api/library/test" and method == "POST":
            self.json_body(4096)
            base = store.settings()["layerLibraryUrl"]
            if not base:
                raise APIError(400, "Set your Layer Library address first.")
            try:
                result = LocalHTTP(base).prepare()
            except (OSError, http.client.HTTPException):
                raise APIError(502, "Cannot reach Layer Library at the saved address.") from None
            return self.send(200, {"ok": True, "message": "Connected to Layer Library.", "version": result.get("version", "")})
        if route == "/api/library/export" and method == "POST":
            if not self.server.large_slots.acquire(blocking=False):
                raise APIError(429, "The server is busy with another transfer. Try again shortly.")
            try:
                return self.send(200, export_to_library(store, self.json_body(MAX_EXPORT)))
            finally:
                self.server.large_slots.release()
        raise APIError(404, "API endpoint not found.")

    def dispatch(self):
        try:
            if urlsplit(self.path).path.startswith("/api/"):
                return self.handle_api()
            if self.command not in ("GET", "HEAD"):
                raise APIError(405, "Method not allowed.")
            path = unquote(urlsplit(self.path).path)
            if path == "/":
                path = "/index.html"
            target = (self.server.static / path.lstrip("/")).resolve()
            if not target.is_relative_to(self.server.static) or not target.is_file() or any(part.startswith(".") for part in Path(path).parts):
                raise APIError(404, "File not found.")
            mime = {".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm"}.get(target.suffix)
            return self.send(200, target.read_bytes(), mime or mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        except APIError as exc:
            self.close_connection = True
            self.send(exc.status, {"error": exc.message, **exc.extra})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except (ValueError, OSError, sqlite3.Error, RecursionError):
            self.close_connection = True
            LOG.exception("Request failed")
            self.send(500, {"error": "The server could not complete the request. Check its data directory and logs."})

    do_GET = dispatch
    do_HEAD = dispatch
    do_POST = dispatch
    do_PUT = dispatch
    do_DELETE = dispatch
    do_OPTIONS = dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    parser.add_argument("--data", default=os.environ.get("DATA_DIR", str(Path(__file__).parent / "data")))
    parser.add_argument("--static", default=str(Path(__file__).parent / "static"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    server = StudioServer((args.host, args.port), Store(args.data, os.environ.get("LAYER_LIBRARY_URL", "")), args.static)
    LOG.info("Solid Studio %s listening at http://%s:%s", VERSION, args.host, server.server_port)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
