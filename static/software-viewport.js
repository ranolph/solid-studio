import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { nodeMatrix } from './viewport.js';

const DEG = Math.PI / 180;
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const AXIS_COLORS = ['#c66858', '#629485', '#7978b6'];
const LIGHT = new THREE.Vector3(-.5, -.7, 1).normalize();
const FILL = new THREE.Vector3(.7, .2, .6).normalize();
const point = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();

function geometryFromPacket(packet, node = {}) {
  const inverse = nodeMatrix(node).invert();
  const positions = new Float32Array(packet.positions.length);
  for (let i = 0; i < positions.length; i += 3) point.fromArray(packet.positions, i).applyMatrix4(inverse).toArray(positions, i);
  const indices = Uint32Array.from(packet.indices);
  if (inverse.determinant() < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

function transformFor(object) {
  const rotation = new THREE.Euler().setFromQuaternion(object.quaternion, 'ZYX');
  const clean = n => Math.abs(n) < 1e-8 ? 0 : Number(n.toFixed(7));
  return { position: object.position.toArray().map(clean), rotation: [rotation.x / DEG, rotation.y / DEG, rotation.z / DEG].map(clean), scale: object.scale.toArray().map(clean) };
}

function distanceToSegment(p, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const t = Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - start.x - t * dx, p.y - start.y - t * dy);
}

/** Canvas2D renderer for browsers without WebGL. The modelling/export mesh stays intact. */
export class SoftwareViewport {
  constructor(host, callbacks = {}) {
    this.host = host; this.callbacks = callbacks; this.isSoftware = true;
    this.meshes = new Map(); this.nodes = new Map(); this.selectedIds = [];
    this.mode = 'translate'; this.displayMode = 'solid'; this.resultEnabled = false;
    this.gridSize = 256; this.gridVisible = true; this.snap = { enabled: true, grid: 1, angle: 15 };
    this.needsRender = true; this._didInitialFit = false; this._disposed = false; this._faceSnap = null;
    this.handles = []; this._width = this._height = 1;
    this.canvas = document.createElement('canvas'); this.canvas.className = 'solid-viewport-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Software 3D workspace. Drag empty space to orbit, scroll to zoom, right-drag to pan. Select an object to use its move, rotate or scale handles.');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });
    this.context = this.canvas.getContext('2d', { alpha: true });
    if (!this.context) throw new Error('This browser cannot create a 2D canvas for the software 3D workspace.');
    host.prepend(this.canvas);
    this.perspective = new THREE.PerspectiveCamera(38, 1, .1, 20000);
    this.orthographic = new THREE.OrthographicCamera(-150, 150, 150, -150, .1, 20000);
    this.perspective.up.set(0, 0, 1); this.orthographic.up.set(0, 0, 1);
    this.perspective.position.set(210, -280, 230); this.orthographic.position.copy(this.perspective.position);
    this.camera = this.perspective;
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 0, 22); this.controls.enableDamping = true; this.controls.dampingFactor = .14;
    this.controls.minDistance = 3; this.controls.maxDistance = 12000; this.controls.minZoom = .02; this.controls.maxZoom = 100;
    this.controls.maxPolarAngle = Math.PI * .975; this.controls.rotateSpeed = .7; this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.raycaster = new THREE.Raycaster();
    this._down = e => this._pointerDown(e); this._move = e => this._pointerMove(e); this._up = e => this._pointerUp(e);
    this._key = e => { if (e.key === 'Escape') this.cancelFaceSnap(); };
    this.canvas.addEventListener('pointerdown', this._down, true);
    this.canvas.addEventListener('pointermove', this._move, true);
    this.canvas.addEventListener('pointerup', this._up, true);
    this.canvas.addEventListener('pointercancel', this._up, true);
    window.addEventListener('keydown', this._key);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
    this.resize(); this.controls.update();
    const animate = () => {
      if (this._disposed) return;
      this.controls.update();
      if (this.needsRender) { this.needsRender = false; this.render(); }
      this.frame = requestAnimationFrame(animate);
    };
    this.frame = requestAnimationFrame(animate);
  }

  requestRender() { this.needsRender = true; }
  resize() {
    const rect = this.host.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return;
    this._width = rect.width; this._height = rect.height; this.dpr = Math.min(2.5, Math.max(2, devicePixelRatio || 1));
    this.canvas.width = Math.round(rect.width * this.dpr); this.canvas.height = Math.round(rect.height * this.dpr);
    this.perspective.aspect = rect.width / rect.height; this.perspective.updateProjectionMatrix();
    const half = this.orthographic.top || 150;
    this.orthographic.left = -half * rect.width / rect.height; this.orthographic.right = -this.orthographic.left;
    this.orthographic.updateProjectionMatrix(); this.requestRender();
  }

  _makeMesh(packet, node = {}) {
    const mesh = new THREE.Mesh(geometryFromPacket(packet, node), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const t = node.transform || {}, r = t.rotation || [0, 0, 0];
    mesh.position.fromArray(t.position || [0, 0, 0]); mesh.rotation.set(...r.map(n => n * DEG), 'ZYX'); mesh.scale.fromArray(t.scale || [1, 1, 1]);
    mesh.userData = { nodeId: node.id, hole: node.role === 'hole', color: /^#[\da-f]{6}$/i.test(node.color) ? node.color : '#ee8765', locked: !!node.locked };
    mesh.updateMatrixWorld(true); return mesh;
  }
  _disposeMesh(mesh) { mesh.geometry.dispose(); mesh.material.dispose(); }
  setScene(packets = [], objects = [], selectedIds = this.selectedIds) {
    for (const mesh of this.meshes.values()) this._disposeMesh(mesh);
    this.meshes.clear(); this.nodes = new Map(objects.map(n => [n.id, n]));
    for (const packet of packets) {
      const node = this.nodes.get(packet.id);
      if (node && node.visible !== false && packet.positions?.length && packet.indices?.length) this.meshes.set(node.id, this._makeMesh(packet, node));
    }
    this.setSelection(selectedIds);
    if (!this._didInitialFit && this.meshes.size) { this._didInitialFit = true; this.fit(); }
    this.requestRender();
  }
  setSelection(ids = []) { this.selectedIds = [...ids]; this.requestRender(); }
  setMode(mode) { if (['translate', 'rotate', 'scale'].includes(mode)) this.mode = mode; this.requestRender(); }
  setSnapping(snap) { this.snap = { ...this.snap, ...snap }; }
  setGrid(visible, size = this.gridSize) { this.gridVisible = !!visible; this.gridSize = Math.max(20, Math.min(10000, Number(size) || 256)); this.requestRender(); }
  setDisplayMode(mode) { if (['solid', 'wire', 'xray'].includes(mode)) this.displayMode = mode; this.requestRender(); }
  setResult(packet, enabled = false) {
    if (this.resultMesh) this._disposeMesh(this.resultMesh);
    const color = [...this.nodes.values()].find(n => n.role !== 'hole')?.color || '#ee8765';
    this.resultMesh = packet?.positions?.length && packet?.indices?.length ? this._makeMesh(packet, { color }) : null;
    this.resultEnabled = !!enabled; if (enabled) this.cancelFaceSnap(false); this.requestRender();
  }
  getBounds(id) {
    const mesh = this.meshes.get(id); if (!mesh) return null;
    mesh.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(mesh, true);
    return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
  }
  _bounds(selection = false) {
    const bounds = new THREE.Box3();
    if (this.resultEnabled && this.resultMesh) return bounds.setFromObject(this.resultMesh, true);
    for (const [id, mesh] of this.meshes) if (!selection || this.selectedIds.includes(id)) bounds.union(new THREE.Box3().setFromObject(mesh, true));
    return selection && bounds.isEmpty() ? this._bounds(false) : bounds;
  }
  fit(selection = false) {
    const bounds = this._bounds(selection), empty = bounds.isEmpty();
    const size = empty ? new THREE.Vector3(120, 120, 60) : bounds.getSize(new THREE.Vector3());
    const center = empty ? new THREE.Vector3(0, 0, 20) : bounds.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize(); if (direction.lengthSq() < .1) direction.set(1, -1.32, 1).normalize();
    const aspect = this._width / this._height, radius = Math.max(10, size.length() / 2), fov = this.perspective.fov * DEG;
    const distance = radius / Math.sin(Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect)) / 2) * 1.25;
    this.controls.target.copy(center); this.camera.position.copy(center).add(direction.multiplyScalar(distance)); this.camera.lookAt(center);
    this.camera.near = Math.max(.01, radius / 1000); this.camera.far = Math.max(20000, distance * 10);
    if (this.camera.isOrthographicCamera) {
      const inverse = this.camera.quaternion.clone().invert(); let width = 0, height = 0;
      if (!empty) for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const v = new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse); width = Math.max(width, Math.abs(v.x)); height = Math.max(height, Math.abs(v.y));
      }
      const half = Math.max(15, height, width / aspect) * 1.5;
      this.camera.top = half; this.camera.bottom = -half; this.camera.left = -half * aspect; this.camera.right = half * aspect; this.camera.zoom = 1;
    }
    this.camera.updateProjectionMatrix(); this.controls.update(); this.requestRender();
  }
  setView(view) {
    const direction = { iso: [1, -1.32, 1], top: [0, -.00001, 1], front: [0, -1, .00001], right: [1, 0, .00001] }[view]; if (!direction) return;
    this.camera = view === 'iso' ? this.perspective : this.orthographic; this.controls.object = this.camera;
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(...direction).normalize().multiplyScalar(300)); this.camera.lookAt(this.controls.target); this.fit();
  }
  setProjection(mode) {
    const next = mode === 'orthographic' ? this.orthographic : this.perspective; if (next === this.camera) return;
    next.position.copy(this.camera.position); next.quaternion.copy(this.camera.quaternion); this.camera = next; this.controls.object = next; this.fit();
  }

  _project(vector) { const v = vector.clone().project(this.camera); return { x: (v.x + 1) * this._width / 2, y: (1 - v.y) * this._height / 2, z: v.z }; }
  _path(points, fill, stroke, width = 1) {
    if (points.length < 2 || points.some(p => !Number.isFinite(p.x + p.y) || (p.z !== undefined && (p.z < -1 || p.z > 1)))) return;
    const ctx = this.context; ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (fill) { ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
  }
  _drawBed() {
    if (!this.gridVisible) return;
    const h = this.gridSize / 2, project = (x, y, z = -.12) => this._project(new THREE.Vector3(x, y, z));
    this._path([project(-h, -h), project(h, -h), project(h, h), project(-h, h)], '#ffffff', '#d2d2d2', 1);
    const step = this.gridSize <= 350 ? 10 : this.gridSize <= 1200 ? 25 : 100;
    for (let x = Math.ceil(-h / step) * step; x <= h; x += step) {
      const color = x === 0 ? '#c8c8c8' : '#e6e6e6';
      this._path([project(x, -h), project(x, h)], null, color, .65); this._path([project(-h, x), project(h, x)], null, color, .65);
    }
    const label = project(0, -h - 7);
    this.context.font = '12px system-ui,sans-serif'; this.context.textAlign = 'center'; this.context.fillStyle = '#858890';
    this.context.fillText(`${this.gridSize} × ${this.gridSize} mm`, label.x, label.y);
    const meshes = this.resultEnabled ? [this.resultMesh].filter(Boolean) : [...this.meshes.values()];
    for (const mesh of meshes) {
      if (mesh.userData.hole) continue;
      const bounds = new THREE.Box3().setFromObject(mesh, true), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
      const shadow = Array.from({ length: 32 }, (_, i) => { const angle = i * Math.PI / 16; return project(center.x + Math.cos(angle) * size.x * .52, center.y + Math.sin(angle) * size.y * .52); });
      this._path(shadow, 'rgba(48,50,55,.045)');
    }
  }
  _faces(mesh) {
    mesh.updateMatrixWorld(true);
    const pos = mesh.geometry.attributes.position.array, index = mesh.geometry.index.array;
    const world = new Float64Array(pos.length), projected = new Float64Array(pos.length), depth = new Float64Array(pos.length / 3);
    const worldMatrix = mesh.matrixWorld, view = this.camera.matrixWorldInverse;
    for (let i = 0; i < pos.length; i += 3) {
      point.fromArray(pos, i).applyMatrix4(worldMatrix); point.toArray(world, i);
      a.copy(point).applyMatrix4(view); depth[i / 3] = -a.z;
      point.project(this.camera); projected[i] = (point.x + 1) * this._width / 2; projected[i + 1] = (1 - point.y) * this._height / 2; projected[i + 2] = point.z;
    }
    const base = mesh.userData.hole ? '#9f91b5' : mesh.userData.color;
    const rgb = [1, 3, 5].map(i => parseInt(base.slice(i, i + 2), 16));
    const selected = this.selectedIds.includes(mesh.userData.nodeId) && !this.resultEnabled;
    const determinant = Math.sign(worldMatrix.determinant()) || 1;
    const faces = [], normal = new THREE.Vector3(), toCamera = new THREE.Vector3(), cameraDirection = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    for (let i = 0; i < index.length; i += 3) {
      const ia = index[i] * 3, ib = index[i + 1] * 3, ic = index[i + 2] * 3;
      if (projected[ia + 2] < -1 || projected[ib + 2] < -1 || projected[ic + 2] < -1 || projected[ia + 2] > 1 || projected[ib + 2] > 1 || projected[ic + 2] > 1) continue;
      a.fromArray(world, ia); b.fromArray(world, ib); c.fromArray(world, ic);
      normal.crossVectors(b.sub(a), c.sub(a)).normalize().multiplyScalar(determinant);
      if (this.camera.isOrthographicCamera) toCamera.copy(cameraDirection);
      else toCamera.copy(this.camera.position).sub(a);
      const front = normal.dot(toCamera) > 0;
      if (!front && !mesh.userData.hole && this.displayMode !== 'xray') continue;
      const shade = .75 + Math.max(0, normal.dot(LIGHT)) * .29 + Math.max(0, normal.dot(FILL)) * .12 + normal.z * .025;
      const color = `rgb(${rgb.map(v => Math.round(Math.min(255, v * shade + Math.max(0, shade - 1) * 42))).join(',')})`;
      faces.push({ x1: projected[ia], y1: projected[ia + 1], x2: projected[ib], y2: projected[ib + 1], x3: projected[ic], y3: projected[ic + 1], depth: (depth[ia / 3] + depth[ib / 3] + depth[ic / 3]) / 3, color, hole: mesh.userData.hole, selected });
    }
    return faces;
  }
  render() {
    const ctx = this.context; ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this._width, this._height);
    this.camera.updateMatrixWorld(true); this._drawBed();
    const visible = this.resultEnabled ? [this.resultMesh].filter(Boolean) : [...this.meshes.values()];
    const faces = visible.flatMap(mesh => this._faces(mesh)).sort((a, b) => b.depth - a.depth);
    ctx.lineJoin = 'round';
    for (const face of faces) {
      ctx.beginPath(); ctx.moveTo(face.x1, face.y1); ctx.lineTo(face.x2, face.y2); ctx.lineTo(face.x3, face.y3); ctx.closePath();
      ctx.globalAlpha = face.hole ? .15 : this.displayMode === 'xray' ? .28 : 1;
      ctx.fillStyle = face.color; ctx.strokeStyle = face.color; ctx.lineWidth = .45;
      if (this.displayMode !== 'wire') { ctx.fill(); if (!face.hole && this.displayMode !== 'xray') ctx.stroke(); }
      else { ctx.globalAlpha = face.hole ? .2 : .58; ctx.lineWidth = .55; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    if (!this.resultEnabled) this._drawSelection();
    this._drawGizmo(); this._drawAxes();
    if (this._faceSnap?.source) {
      const source = this._faceSnap.source, p = this._project(new THREE.Vector3(...source.point));
      const end = this._project(new THREE.Vector3(...source.point).addScaledVector(new THREE.Vector3(...source.normal), this._handleLength() * .25));
      this._path([p, end], null, '#c78939', 2); ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 2 * Math.PI); ctx.fillStyle = '#f3b555'; ctx.fill();
    }
    this.renderStats = { triangles: faces.length };
  }
  _drawSelection() {
    const ctx = this.context, bounds = new THREE.Box3();
    for (const id of this.selectedIds) { const mesh = this.meshes.get(id); if (mesh) bounds.union(new THREE.Box3().setFromObject(mesh, true)); }
    if (bounds.isEmpty()) return;
    const corners = []; for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) corners.push(this._project(new THREE.Vector3(x, y, z)));
    ctx.setLineDash([3, 3]);
    for (let i = 0; i < 8; i++) for (const axis of [1, 2, 4]) if (!(i & axis)) this._path([corners[i], corners[i | axis]], null, '#b7775fa6', .9);
    ctx.setLineDash([]);
    const size = bounds.getSize(new THREE.Vector3()); ctx.font = '500 12px system-ui,sans-serif'; ctx.fillStyle = '#686b73'; ctx.textAlign = 'left';
    ctx.fillText(size.toArray().map(n => Number(n.toFixed(2))).join(' × ') + ' mm', 18, this._height - 64);
  }
  _handleLength() {
    return this.camera.isOrthographicCamera ? (this.camera.top - this.camera.bottom) / this.camera.zoom * .12 : this.camera.position.distanceTo(this.controls.target) * Math.tan(this.perspective.fov * DEG / 2) * .23;
  }
  _drawGizmo() {
    this.handles = []; if (this.resultEnabled || this._faceSnap || this.selectedIds.length !== 1) return;
    const mesh = this.meshes.get(this.selectedIds[0]); if (!mesh || mesh.userData.locked) return;
    const center = mesh.position, p = this._project(center), length = this._handleLength(), ctx = this.context;
    if (this.mode === 'rotate') {
      for (let axis = 0; axis < 3; axis++) {
        const u = AXES[(axis + 1) % 3], v = AXES[(axis + 2) % 3];
        const ring = Array.from({ length: 65 }, (_, i) => this._project(center.clone().addScaledVector(u, Math.cos(i * Math.PI / 32) * length).addScaledVector(v, Math.sin(i * Math.PI / 32) * length)));
        this._path(ring, null, AXIS_COLORS[axis], 1.8); this.handles.push({ axis, points: ring, center: center.clone() });
      }
    } else {
      for (let axis = 0; axis < 3; axis++) {
        const direction = this.mode === 'scale' ? AXES[axis].clone().applyQuaternion(mesh.quaternion) : AXES[axis];
        const end = this._project(center.clone().addScaledVector(direction, length));
        if (Math.hypot(end.x - p.x, end.y - p.y) < 7) continue;
        this._path([p, end], null, AXIS_COLORS[axis], 2);
        ctx.fillStyle = AXIS_COLORS[axis]; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3;
        if (this.mode === 'scale') { ctx.fillRect(end.x - 4, end.y - 4, 8, 8); ctx.strokeRect(end.x - 4, end.y - 4, 8, 8); }
        else { ctx.beginPath(); ctx.arc(end.x, end.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
        ctx.font = '600 11px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillText('XYZ'[axis], end.x, end.y - 10);
        this.handles.push({ axis, points: [p, end], center: center.clone(), direction: direction.clone(), length });
      }
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#8a8d95'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (this.mode === 'scale') this.handles.push({ axis: -1, points: [p, p], center: center.clone(), length });
    }
  }
  _drawAxes() {
    const ctx = this.context, q = this.camera.quaternion.clone().invert(), x = this._width - 46, y = this._height - 83;
    const axes = AXES.map((axis, i) => ({ i, v: axis.clone().applyQuaternion(q) })).sort((a, b) => a.v.z - b.v.z);
    for (const { i, v } of axes) {
      const end = { x: x + v.x * 25, y: y - v.y * 25 }; ctx.globalAlpha = v.z < 0 ? .5 : 1;
      this._path([{ x, y }, end], null, AXIS_COLORS[i], 1.5); ctx.beginPath(); ctx.arc(end.x, end.y, 9, 0, 2 * Math.PI); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.fillStyle = AXIS_COLORS[i]; ctx.font = '600 11px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillText('XYZ'[i], end.x, end.y + 4);
    }
    ctx.globalAlpha = 1;
  }

  _eventPoint(event) { const rect = this.canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  _ray(event) { const p = this._eventPoint(event); this.camera.updateMatrixWorld(true); this.raycaster.setFromCamera(new THREE.Vector2(p.x / this._width * 2 - 1, 1 - p.y / this._height * 2), this.camera); return this.raycaster.ray; }
  _pick(event) { this._ray(event); return this.raycaster.intersectObjects([...this.meshes.values()], false)[0] || null; }
  _planePoint(event, center, normal) { return this._ray(event).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center), new THREE.Vector3()); }
  _pointerDown(event) {
    const p = this._eventPoint(event); this.pointerStart = { ...p, button: event.button };
    if (event.button !== 0 || this._faceSnap) return;
    let nearest = null, distance = 8;
    for (const handle of this.handles) for (let i = 1; i < handle.points.length; i++) { const d = distanceToSegment(p, handle.points[i - 1], handle.points[i]); if (d < distance) { nearest = handle; distance = d; } }
    const mesh = this.selectedIds.length === 1 ? this.meshes.get(this.selectedIds[0]) : null;
    if (!nearest || !mesh) return;
    const drag = { handle: nearest, mesh, point: p, position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone(), mode: this.mode };
    if (this.mode === 'rotate') { drag.startVector = this._planePoint(event, nearest.center, AXES[nearest.axis])?.sub(nearest.center).normalize(); if (!drag.startVector) return; }
    this.drag = drag; this.controls.enabled = false; this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopImmediatePropagation(); this.callbacks.onTransformStart?.(mesh.userData.nodeId);
  }
  _pointerMove(event) {
    if (!this.drag) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const drag = this.drag, h = drag.handle, p = this._eventPoint(event), dx = p.x - drag.point.x, dy = p.y - drag.point.y;
    if (drag.mode === 'rotate') {
      const v = this._planePoint(event, h.center, AXES[h.axis])?.sub(h.center).normalize(); if (!v) return;
      let angle = Math.atan2(AXES[h.axis].dot(new THREE.Vector3().crossVectors(drag.startVector, v)), drag.startVector.dot(v));
      if (this.snap.enabled && this.snap.angle > 0) angle = Math.round(angle / (this.snap.angle * DEG)) * this.snap.angle * DEG;
      drag.mesh.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(AXES[h.axis], angle).multiply(drag.quaternion));
    } else if (h.axis === -1) {
      const factor = Math.max(.01, 1 + (dx - dy) / 110); drag.mesh.scale.copy(drag.scale).multiplyScalar(factor);
    } else {
      const start = h.points[0], end = h.points[1], sx = end.x - start.x, sy = end.y - start.y;
      const amount = (dx * sx + dy * sy) / (sx * sx + sy * sy) * h.length;
      if (drag.mode === 'translate') {
        let value = drag.position.getComponent(h.axis) + amount;
        if (this.snap.enabled && this.snap.grid > 0) value = Math.round(value / this.snap.grid) * this.snap.grid;
        drag.mesh.position.copy(drag.position).setComponent(h.axis, value);
      } else {
        const factor = Math.max(.01, 1 + amount / h.length); drag.mesh.scale.copy(drag.scale).setComponent(h.axis, drag.scale.getComponent(h.axis) * factor);
      }
    }
    drag.mesh.updateMatrixWorld(true); this.callbacks.onTransform?.(drag.mesh.userData.nodeId, transformFor(drag.mesh), false); this.requestRender();
  }
  _pointerUp(event) {
    if (this.drag) {
      event.preventDefault(); event.stopImmediatePropagation(); const drag = this.drag; this.drag = null; this.pointerStart = null; this.controls.enabled = true;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.callbacks.onTransform?.(drag.mesh.userData.nodeId, transformFor(drag.mesh), true); this.requestRender(); return;
    }
    const start = this.pointerStart; this.pointerStart = null; if (!start || start.button !== 0 || this.resultEnabled) return;
    const p = this._eventPoint(event); if (Math.hypot(p.x - start.x, p.y - start.y) > 5) return;
    const hit = this._pick(event); if (this._faceSnap) return this._faceSnapClick(hit);
    this.callbacks.onSelect?.(hit?.object.userData.nodeId || null, event.shiftKey || event.ctrlKey || event.metaKey);
  }

  beginFaceSnap(callback) {
    const mesh = this.selectedIds.length === 1 ? this.meshes.get(this.selectedIds[0]) : null;
    if (!mesh || mesh.userData.locked || this.resultEnabled) { this.callbacks.onStatus?.('Select one unlocked shape in Objects view to attach.'); return false; }
    this._faceSnap = { sourceId: mesh.userData.nodeId, source: null, callback }; this.canvas.style.cursor = 'crosshair';
    this.callbacks.onStatus?.('Click the face of the selected shape you want to attach.'); this.requestRender(); return true;
  }
  _faceSnapClick(hit) {
    const snap = this._faceSnap; if (!hit?.face || !snap) return; const id = hit.object.userData.nodeId;
    if (!snap.source && id !== snap.sourceId) { this.callbacks.onStatus?.('First click a face on the selected shape.'); return; }
    if (snap.source && id === snap.sourceId) { this.callbacks.onStatus?.('Now click a face on a different shape.'); return; }
    const face = { id, point: hit.point.toArray(), normal: hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize().toArray() };
    if (!snap.source) { snap.source = face; this.callbacks.onStatus?.('Click the target face on another shape. Escape cancels.'); this.requestRender(); }
    else { const callback = snap.callback, source = snap.source; this.cancelFaceSnap(false); callback?.({ source, target: face }); }
  }
  cancelFaceSnap(announce = true) { const active = !!this._faceSnap; this._faceSnap = null; this.canvas.style.cursor = ''; if (active && announce) this.callbacks.onStatus?.('Face attachment cancelled.'); this.requestRender(); }
  dispose() {
    this._disposed = true; cancelAnimationFrame(this.frame); this.resizeObserver.disconnect(); this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this._down, true); this.canvas.removeEventListener('pointermove', this._move, true); this.canvas.removeEventListener('pointerup', this._up, true); this.canvas.removeEventListener('pointercancel', this._up, true); window.removeEventListener('keydown', this._key);
    for (const mesh of this.meshes.values()) this._disposeMesh(mesh); if (this.resultMesh) this._disposeMesh(this.resultMesh); this.meshes.clear(); this.canvas.remove();
  }
}
