import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { TransformControls } from './vendor/TransformControls.js';

const DEG = Math.PI / 180;
const PALETTE = ['#ee8967', '#b6a0ed', '#70bdbb', '#e8b764', '#e58da8'];

/** Node rotations apply X, then Y, then Z, in world coordinates. */
export function nodeMatrix(node) {
  const t = node.transform || {};
  const rotation = t.rotation || [0, 0, 0];
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(t.position || [0, 0, 0]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, 'ZYX'
    )),
    new THREE.Vector3().fromArray(t.scale || [1, 1, 1])
  );
}

/** Build normals with a crease angle: round surfaces stay smooth and edges stay sharp. */
export function worldPacketToGeometry(packet, matrix = new THREE.Matrix4()) {
  const sourcePositions = packet.positions;
  const sourceIndices = packet.indices;
  if (!sourcePositions?.length || !sourceIndices?.length) return new THREE.BufferGeometry();
  const inverse = matrix.clone().invert();
  const mirrored = matrix.determinant() < 0;
  const point = new THREE.Vector3();
  const positions = new Float32Array(sourcePositions.length);
  for (let i = 0; i < sourcePositions.length; i += 3) {
    point.fromArray(sourcePositions, i).applyMatrix4(inverse).toArray(positions, i);
  }
  const indices = new Uint32Array(sourceIndices);
  if (mirrored) {
    // A negative node scale reverses winding when moving the world mesh back to
    // local space. Restore local outward winding; Three handles the mirrored draw.
    for (let i = 0; i < indices.length; i += 3) {
      [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // Averaging only incident faces under the crease angle prevents the rounded
  // corners which normal averaging otherwise introduces on boxes and cut faces.
  const triangleCount = indices.length / 3;
  const incident = Array.from({ length: positions.length / 3 }, () => []);
  const normals = new Float32Array(indices.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let face = 0; face < triangleCount; face++) {
    const offset = face * 3;
    a.fromArray(positions, indices[offset] * 3);
    b.fromArray(positions, indices[offset + 1] * 3);
    c.fromArray(positions, indices[offset + 2] * 3);
    normal.crossVectors(b.sub(a), c.sub(a)).normalize().toArray(normals, offset);
    for (let corner = 0; corner < 3; corner++) incident[indices[offset + corner]].push(face);
  }
  const expandedPositions = new Float32Array(indices.length * 3);
  const expandedNormals = new Float32Array(indices.length * 3);
  const crease = Math.cos(38 * DEG);
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const faceOffset = Math.floor(i / 3) * 3;
    a.fromArray(normals, faceOffset);
    normal.set(0, 0, 0);
    for (const neighbor of incident[index]) {
      b.fromArray(normals, neighbor * 3);
      if (a.dot(b) > crease) normal.add(b);
    }
    if (normal.lengthSq() < 1e-14) normal.copy(a);
    normal.normalize().toArray(expandedNormals, i * 3);
    expandedPositions.set(positions.subarray(index * 3, index * 3 + 3), i * 3);
  }
  geometry.dispose();
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.BufferAttribute(expandedPositions, 3));
  result.setAttribute('normal', new THREE.BufferAttribute(expandedNormals, 3));
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

function disposeTree(object) {
  object.traverse(child => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      material.map?.dispose();
      material.dispose();
    }
  });
  object.removeFromParent();
}

function copyTransform(object) {
  const rotation = new THREE.Euler().setFromQuaternion(object.quaternion, 'ZYX');
  const clean = value => Math.abs(value) < 1e-8 ? 0 : Number(value.toFixed(7));
  return {
    position: object.position.toArray().map(clean),
    rotation: [rotation.x / DEG, rotation.y / DEG, rotation.z / DEG].map(clean),
    scale: object.scale.toArray().map(value => clean(Math.sign(value || 1) * Math.max(.001, Math.abs(value))))
  };
}


export class Viewport {
  constructor(host, callbacks = {}) {
    if (!host) throw new Error('The 3D workspace element is missing.');
    this.host = host;
    this.callbacks = callbacks;
    this.meshes = new Map();
    this.nodes = new Map();
    this.selectedIds = [];
    this.displayMode = 'solid';
    this.resultEnabled = false;
    this.gridSize = 256;
    this.needsRender = true;
    this._disposed = false;
    this._didInitialFit = false;
    this._transformInProgress = false;
    this._faceSnap = null;
    this._width = 1;
    this._height = 1;
    this._view = 'iso';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      throw new Error('This browser could not start the 3D workspace. Enable WebGL / hardware acceleration or open Solid Studio in another modern browser.');
    }
    this.renderer.setPixelRatio(Math.min(2.5, Math.max(2, window.devicePixelRatio || 1)));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor('#f0ede7', 0);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'solid-viewport-canvas';
    this.canvas.setAttribute('aria-label', '3D modelling workspace. Drag to orbit, scroll to zoom, right-drag to pan. Click a shape to select it.');
    this.canvas.setAttribute('tabindex', '0');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });
    host.prepend(this.canvas);
    this.scene = new THREE.Scene();
    this.objectsGroup = new THREE.Group();
    this.resultGroup = new THREE.Group();
    this.scene.add(this.objectsGroup, this.resultGroup);
    this.resultGroup.visible = false;

    this.perspective = new THREE.PerspectiveCamera(38, 1, .1, 20000);
    this.orthographic = new THREE.OrthographicCamera(-150, 150, 150, -150, .1, 20000);
    this.perspective.up.set(0, 0, 1);
    this.orthographic.up.set(0, 0, 1);
    this.perspective.position.set(210, -280, 230);
    this.orthographic.position.copy(this.perspective.position);
    this.camera = this.perspective;
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 0, 22);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .12;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 12000;
    this.controls.minZoom = .02;
    this.controls.maxZoom = 100;
    this.controls.maxPolarAngle = Math.PI * .975;
    this.controls.rotateSpeed = .7;
    this.controls.zoomSpeed = .85;
    this.controls.panSpeed = .8;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSize(.85);
    this.transform.setSpace('world');
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('mouseDown', () => {
      const object = this.transform.object;
      if (!object) return;
      this._transformInProgress = true;
      this._pointerDownGizmo = true;
      this.controls.enabled = false;
      this.callbacks.onTransformStart?.(object.userData.nodeId);
    });
    this.transform.addEventListener('objectChange', () => {
      if (!this._transformInProgress || !this.transform.object) return;
      const object = this.transform.object;
      for (const axis of ['x', 'y', 'z']) {
        const value = object.scale[axis];
        if (Math.abs(value) < .001) object.scale[axis] = (Math.sign(value) || 1) * .001;
      }
      object.updateMatrixWorld(true);
      this._updateSelectionSummary();
      this.callbacks.onTransform?.(object.userData.nodeId, copyTransform(object), false);
      this.requestRender();
    });
    this.transform.addEventListener('mouseUp', () => {
      const object = this.transform.object;
      const wasTransforming = this._transformInProgress;
      this._transformInProgress = false;
      this.controls.enabled = true;
      if (wasTransforming && object) this.callbacks.onTransform?.(object.userData.nodeId, copyTransform(object), true);
      this.requestRender();
    });
    this.transform.addEventListener('change', () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight('#fffaf2', '#abb3cd', 2.25));
    this.scene.add(new THREE.AmbientLight('#ffffff', .48));
    this.keyLight = new THREE.DirectionalLight('#fff3e7', 3.25);
    this.keyLight.position.set(-100, -140, 270);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 1200;
    this.keyLight.shadow.normalBias = .08;
    this.keyLight.shadow.bias = -.00015;
    this.keyLight.shadow.radius = 2.5;
    this.scene.add(this.keyLight, this.keyLight.target);
    const fill = new THREE.DirectionalLight('#dfe4ff', 1.6);
    fill.position.set(140, 30, 140);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight('#fff9fb', 1.2);
    rim.position.set(30, 150, 200);
    this.scene.add(rim);
    this.bedGroup = new THREE.Group();
    this.scene.add(this.bedGroup);
    this._makeBed(256);

    this.selectionBox = new THREE.Box3();
    this.selectionHelper = new THREE.Box3Helper(this.selectionBox, '#d37452');
    this.selectionHelper.material.transparent = true;
    this.selectionHelper.material.opacity = .6;
    this.selectionHelper.material.depthTest = false;
    this.selectionHelper.renderOrder = 6;
    this.selectionHelper.visible = false;
    this.scene.add(this.selectionHelper);
    this._makeOverlay();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._onPointerDown = event => {
      this._pointerStart = { x: event.clientX, y: event.clientY, button: event.button };
      this._pointerDownGizmo = !!this.transform.axis || this._transformInProgress;
    };
    this._onPointerUp = event => {
      const start = this._pointerStart;
      this._pointerStart = null;
      if (!start || start.button !== 0 || this._pointerDownGizmo || this._transformInProgress) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      if (this.resultEnabled) return;
      const hit = this._pick(event);
      if (this._faceSnap) return this._faceSnapClick(hit);
      this.callbacks.onSelect?.(hit?.object.userData.nodeId || null, event.shiftKey || event.metaKey || event.ctrlKey);
    };
    this._onDoubleClick = event => {
      if (this._faceSnap || this.transform.axis) return;
      const hit = this._pick(event);
      if (hit) {
        this.callbacks.onSelect?.(hit.object.userData.nodeId, false);
        this.fit(true);
      }
    };
    this._onKeyDown = event => {
      if (event.key === 'Escape' && this._faceSnap) this.cancelFaceSnap();
    };
    this._onContextLost = event => {
      event.preventDefault();
      this.callbacks.onStatus?.('The browser paused 3D rendering. Your editable project is unchanged. Reload the page to resume.');
    };
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('dblclick', this._onDoubleClick);
    this.canvas.addEventListener('webglcontextlost', this._onContextLost);
    window.addEventListener('keydown', this._onKeyDown);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.controls.update();
    this.renderer.setAnimationLoop(() => {
      if (this._disposed) return;
      this.controls.update();
      if (!this.needsRender) return;
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
      this._drawAxis();
    });
  }

  requestRender() { this.needsRender = true; }

  resize() {
    const rect = this.host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    this._width = rect.width;
    this._height = rect.height;
    this.renderer.setSize(rect.width, rect.height, false);
    const aspect = rect.width / rect.height;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    const halfHeight = (this.orthographic.top - this.orthographic.bottom) / 2 || 150;
    this.orthographic.left = -halfHeight * aspect;
    this.orthographic.right = halfHeight * aspect;
    this.orthographic.updateProjectionMatrix();
    this.requestRender();
  }

  _makeBed(size) {
    for (const child of [...this.bedGroup.children]) disposeTree(child);
    const half = size / 2;
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 1, metalness: 0, side: THREE.DoubleSide })
    );
    bed.position.z = -.12;
    bed.receiveShadow = true;
    this.bedGroup.add(bed);
    const minor = [], major = [];
    const step = size <= 350 ? 10 : size <= 1200 ? 25 : 100;
    for (let value = Math.ceil(-half / step) * step; value <= half; value += step) {
      const positions = Math.abs(value) < .001 ? major : minor;
      positions.push(value, -half, -.08, value, half, -.08, -half, value, -.08, half, value, -.08);
    }
    for (const [points, color, opacity] of [[minor, '#c9c8c5', .42], [major, '#b5b8b8', .75]]) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      this.bedGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
    }
    const border = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-half, -half, -.07), new THREE.Vector3(half, -half, -.07),
      new THREE.Vector3(half, half, -.07), new THREE.Vector3(-half, half, -.07)
    ]);
    this.bedGroup.add(new THREE.LineLoop(border, new THREE.LineBasicMaterial({ color: '#b9bab7', transparent: true, opacity: .6 })));
    this._bedLabel = this._textSprite(`${size} × ${size} mm`, '#8a8f8b', 11);
    this._bedLabel.position.set(0, -half - 8, .1);
    this.bedGroup.add(this._bedLabel);
    this._setShadowBounds(size);
  }

  _setShadowBounds(size) {
    const extent = Math.max(160, size * .7);
    const camera = this.keyLight.shadow.camera;
    camera.left = camera.bottom = -extent;
    camera.right = camera.top = extent;
    camera.far = Math.max(1200, size * 5);
    camera.updateProjectionMatrix();
  }

  _textSprite(text, color, height) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.font = '500 40px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = color;
    context.fillText(text, 256, 48);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    sprite.scale.set(height * canvas.width / canvas.height, height, 1);
    return sprite;
  }

  _makeOverlay() {
    this.axisCanvas = document.createElement('canvas');
    this.axisCanvas.width = 180;
    this.axisCanvas.height = 180;
    this.axisCanvas.className = 'solid-orientation-axis';
    this.axisCanvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.axisCanvas.style, { position: 'absolute', width: '82px', height: '82px', right: '8px', bottom: '44px', pointerEvents: 'none', zIndex: '1' });
    this.host.append(this.axisCanvas);
    this.measureLabel = document.createElement('div');
    this.measureLabel.className = 'solid-selection-measure';
    Object.assign(this.measureLabel.style, { position: 'absolute', bottom: '58px', left: '16px', color: '#737b78', font: '500 12px system-ui,sans-serif', pointerEvents: 'none', zIndex: '1', padding: '5px 8px', borderRadius: '7px', background: 'rgba(250,249,246,.85)', display: 'none' });
    this.host.append(this.measureLabel);
  }

  _drawAxis() {
    const context = this.axisCanvas.getContext('2d');
    context.clearRect(0, 0, 180, 180);
    const q = this.camera.quaternion.clone().invert();
    const axes = [
      { vector: new THREE.Vector3(1, 0, 0), label: 'X', color: '#d87565' },
      { vector: new THREE.Vector3(0, 1, 0), label: 'Y', color: '#71a598' },
      { vector: new THREE.Vector3(0, 0, 1), label: 'Z', color: '#8d8bc9' }
    ].map(axis => ({ ...axis, direction: axis.vector.applyQuaternion(q) })).sort((a, b) => a.direction.z - b.direction.z);
    for (const axis of axes) {
      const x = 90 + axis.direction.x * 51, y = 90 - axis.direction.y * 51;
      context.strokeStyle = axis.color;
      context.lineWidth = 3;
      context.globalAlpha = axis.direction.z < -.1 ? .45 : .95;
      context.beginPath(); context.moveTo(90, 90); context.lineTo(x, y); context.stroke();
      context.fillStyle = '#f8f7f3';
      context.beginPath(); context.arc(x, y, 14, 0, 2 * Math.PI); context.fill();
      context.fillStyle = axis.color;
      context.font = '600 19px system-ui,sans-serif';
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(axis.label, x, y + 1);
    }
    context.globalAlpha = 1;
    context.fillStyle = '#9fa7a3';
    context.beginPath(); context.arc(90, 90, 4, 0, Math.PI * 2); context.fill();
  }

  setScene(packets = [], objects = [], selectedIds = this.selectedIds) {
    this.transform.detach();
    for (const mesh of this.meshes.values()) disposeTree(mesh);
    this.meshes.clear();
    this.nodes = new Map(objects.map(node => [node.id, node]));
    packets.forEach((packet, index) => {
      const node = this.nodes.get(packet.id);
      if (!node || node.visible === false || !packet.positions?.length || !packet.indices?.length) return;
      const matrix = nodeMatrix(node);
      const geometry = worldPacketToGeometry(packet, matrix);
      const hole = node.role === 'hole';
      const material = new THREE.MeshStandardMaterial({
        color: hole ? '#9c8db7' : node.color || PALETTE[index % PALETTE.length],
        roughness: .4, metalness: .035,
        transparent: hole, opacity: hole ? .27 : 1,
        depthWrite: !hole, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
      });
      const mesh = new THREE.Mesh(geometry, material);
      const transform = node.transform || {};
      mesh.position.fromArray(transform.position || [0, 0, 0]);
      const rotation = transform.rotation || [0, 0, 0];
      mesh.rotation.set(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, 'ZYX');
      mesh.scale.fromArray(transform.scale || [1, 1, 1]);
      mesh.castShadow = !hole;
      mesh.receiveShadow = !hole;
      mesh.userData.nodeId = node.id;
      mesh.userData.hole = hole;
      mesh.userData.baseColor = material.color.clone();
      mesh.userData.locked = !!node.locked;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 28), new THREE.LineBasicMaterial({ color: hole ? '#8b75a8' : '#7d584a', transparent: true, opacity: hole ? .52 : .32, depthWrite: false }));
      edges.name = 'outline';
      edges.visible = hole;
      mesh.add(edges);
      mesh.updateMatrixWorld(true);
      this.objectsGroup.add(mesh);
      this.meshes.set(node.id, mesh);
    });
    this._applyDisplayMode();
    this.setSelection(selectedIds);
    if (this.meshes.size && !this._didInitialFit) {
      this._didInitialFit = true;
      this.fit();
    }
    this.requestRender();
  }

  setSelection(ids = []) {
    this.selectedIds = [...ids];
    const selected = new Set(ids);
    for (const [id, mesh] of this.meshes) {
      mesh.material.emissive.set(selected.has(id) ? '#6c2918' : '#000000');
      mesh.material.emissiveIntensity = selected.has(id) ? .08 : 0;
      const outline = mesh.getObjectByName('outline');
      if (outline) outline.visible = selected.has(id) || mesh.userData.hole || this.displayMode === 'wire';
    }
    const object = ids.length === 1 ? this.meshes.get(ids[0]) : null;
    if (object && !object.userData.locked && !this.resultEnabled && !this._faceSnap) this.transform.attach(object);
    else this.transform.detach();
    this._updateSelectionSummary();
    this.requestRender();
  }

  _updateSelectionSummary() {
    this.selectionBox.makeEmpty();
    for (const id of this.selectedIds) {
      const mesh = this.meshes.get(id);
      if (mesh) this.selectionBox.union(new THREE.Box3().setFromObject(mesh, true));
    }
    const visible = !this.selectionBox.isEmpty() && !this.resultEnabled;
    this.selectionHelper.visible = visible;
    this.measureLabel.style.display = visible ? 'block' : 'none';
    if (visible) {
      const dimensions = this.selectionBox.getSize(new THREE.Vector3());
      const format = n => Number(n.toFixed(2)).toLocaleString(undefined, { maximumFractionDigits: 2 });
      this.measureLabel.textContent = `${format(dimensions.x)} × ${format(dimensions.y)} × ${format(dimensions.z)} mm`;
    }
  }

  setMode(mode) {
    if (!['translate', 'rotate', 'scale'].includes(mode)) return;
    this.transform.setMode(mode);
    this.transform.setSpace(mode === 'scale' ? 'local' : 'world');
    this.requestRender();
  }

  setSnapping({ enabled = true, grid = 1, angle = 15 } = {}) {
    this.transform.setTranslationSnap(enabled && grid > 0 ? grid : null);
    this.transform.setRotationSnap(enabled && angle > 0 ? angle * DEG : null);
    this.transform.setScaleSnap(null);
  }

  setGrid(visible, size = this.gridSize) {
    const nextSize = Math.max(20, Math.min(10000, Number(size) || 256));
    if (nextSize !== this.gridSize) {
      this.gridSize = nextSize;
      this._makeBed(nextSize);
    }
    this.bedGroup.visible = !!visible;
    this.requestRender();
  }

  setProjection(projection) {
    const next = projection === 'orthographic' ? this.orthographic : this.perspective;
    if (next === this.camera) return;
    next.position.copy(this.camera.position);
    next.quaternion.copy(this.camera.quaternion);
    this.camera = next;
    this.controls.object = next;
    this.transform.camera = next;
    this.fit();
    this.controls.update();
    this.requestRender();
  }

  setView(view) {
    const direction = {
      iso: new THREE.Vector3(1, -1.32, 1),
      top: new THREE.Vector3(0, -.00001, 1),
      front: new THREE.Vector3(0, -1, .00001),
      right: new THREE.Vector3(1, 0, .00001)
    }[view];
    if (!direction) return;
    this._view = view;
    const next = view === 'iso' ? this.perspective : this.orthographic;
    this.camera = next;
    this.controls.object = next;
    this.transform.camera = next;
    this.camera.position.copy(this.controls.target).add(direction.normalize().multiplyScalar(300));
    this.camera.lookAt(this.controls.target);
    this.fit();
    this.controls.update();
    this.requestRender();
  }

  _bounds(selection = false) {
    if (this.resultEnabled && this.resultMesh) return new THREE.Box3().setFromObject(this.resultMesh, true);
    const result = new THREE.Box3();
    for (const [id, mesh] of this.meshes) {
      if (!selection || this.selectedIds.includes(id)) result.union(new THREE.Box3().setFromObject(mesh, true));
    }
    if (result.isEmpty() && selection) return this._bounds(false);
    return result;
  }

  fit(selection = false) {
    const bounds = this._bounds(selection);
    const size = bounds.isEmpty() ? new THREE.Vector3(120, 120, 60) : bounds.getSize(new THREE.Vector3());
    const center = bounds.isEmpty() ? new THREE.Vector3(0, 0, 20) : bounds.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (direction.lengthSq() < .01) direction.set(1, -1.32, 1).normalize();
    const aspect = this._width / Math.max(1, this._height);
    const radius = Math.max(10, size.length() * .5);
    const verticalFov = this.perspective.fov * DEG;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.25;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(direction.multiplyScalar(distance));
    this.camera.lookAt(center);
    this.camera.near = Math.max(.01, radius / 1000);
    this.camera.far = Math.max(20000, distance * 10);
    if (this.camera.isOrthographicCamera) {
      // Project all corners to the view plane so front/top views fit elongated
      // designs without shrinking them to the diagonal of their 3D bounds.
      const inverse = this.camera.quaternion.clone().invert();
      let halfWidth = 0, halfHeight = 0;
      if (!bounds.isEmpty()) for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse);
        halfWidth = Math.max(halfWidth, Math.abs(corner.x));
        halfHeight = Math.max(halfHeight, Math.abs(corner.y));
      }
      const half = Math.max(15, halfHeight, halfWidth / aspect) * 1.5;
      this.camera.left = -half * aspect;
      this.camera.right = half * aspect;
      this.camera.top = half;
      this.camera.bottom = -half;
      this.camera.zoom = 1;
    }
    this.camera.updateProjectionMatrix();
    this.keyLight.target.position.copy(center);
    this.keyLight.position.copy(center).add(new THREE.Vector3(-100, -140, 270).multiplyScalar(Math.max(1, radius / 160)));
    this._setShadowBounds(Math.max(this.gridSize, radius * 2));
    this.controls.update();
    this.requestRender();
  }

  setDisplayMode(mode) {
    if (!['solid', 'wire', 'xray'].includes(mode)) return;
    this.displayMode = mode;
    this._applyDisplayMode();
    this.requestRender();
  }

  _applyDisplayMode() {
    for (const [id, mesh] of this.meshes) {
      const hole = mesh.userData.hole;
      mesh.material.wireframe = this.displayMode === 'wire';
      mesh.material.transparent = hole || this.displayMode === 'xray';
      mesh.material.opacity = hole ? .25 : this.displayMode === 'xray' ? .3 : 1;
      mesh.material.depthWrite = !mesh.material.transparent;
      const outline = mesh.getObjectByName('outline');
      if (outline) outline.visible = hole || this.selectedIds.includes(id) || this.displayMode === 'wire';
    }
    if (this.resultMesh) {
      this.resultMesh.material.wireframe = this.displayMode === 'wire';
      this.resultMesh.material.transparent = this.displayMode === 'xray';
      this.resultMesh.material.opacity = this.displayMode === 'xray' ? .3 : 1;
      this.resultMesh.material.depthWrite = this.displayMode !== 'xray';
    }
  }

  setResult(packet, enabled = false) {
    if (this.resultMesh) {
      disposeTree(this.resultMesh);
      this.resultMesh = null;
    }
    if (packet?.positions?.length && packet?.indices?.length) {
      const firstSolid = [...this.nodes.values()].find(node => node.role !== 'hole' && node.visible !== false);
      this.resultMesh = new THREE.Mesh(worldPacketToGeometry(packet), new THREE.MeshStandardMaterial({ color: firstSolid?.color || '#ee8967', roughness: .4, metalness: .035, side: THREE.DoubleSide }));
      this.resultMesh.castShadow = true;
      this.resultMesh.receiveShadow = true;
      this.resultGroup.add(this.resultMesh);
    }
    this.resultEnabled = !!enabled;
    this.resultGroup.visible = this.resultEnabled;
    this.objectsGroup.visible = !this.resultEnabled;
    if (this.resultEnabled) this.cancelFaceSnap(false);
    this._applyDisplayMode();
    this.setSelection(this.selectedIds);
    this.requestRender();
  }

  getBounds(id) {
    const mesh = this.meshes.get(id);
    if (!mesh) return null;
    mesh.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(mesh, true);
    return bounds.isEmpty() ? null : { min: bounds.min.toArray(), max: bounds.max.toArray() };
  }

  _pick(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects([...this.meshes.values()], false)[0] || null;
  }

  /** Select a source face, then a target face; no modelling changes happen here. */
  beginFaceSnap(callback) {
    if (this.selectedIds.length !== 1 || !this.meshes.has(this.selectedIds[0])) {
      this.callbacks.onStatus?.('Select one shape to attach first.');
      return false;
    }
    if (this.nodes.get(this.selectedIds[0])?.locked) {
      this.callbacks.onStatus?.('Unlock this shape before attaching it.');
      return false;
    }
    if (this.resultEnabled) {
      this.callbacks.onStatus?.('Switch back to the editable objects to attach faces.');
      return false;
    }
    this._faceSnap = { sourceId: this.selectedIds[0], source: null, callback };
    this.transform.detach();
    this.canvas.style.cursor = 'crosshair';
    this.callbacks.onStatus?.('Click the face of the selected shape you want to attach.');
    this.requestRender();
    return true;
  }

  _faceSnapClick(hit) {
    const snap = this._faceSnap;
    if (!snap || !hit?.face) return;
    const id = hit.object.userData.nodeId;
    if (!snap.source && id !== snap.sourceId) {
      this.callbacks.onStatus?.('First click a face on the selected shape.');
      return;
    }
    if (snap.source && id === snap.sourceId) {
      this.callbacks.onStatus?.('Now click a face on a different shape.');
      return;
    }
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    // worldPacketToGeometry restores local outward winding for mirrored nodes,
    // so the inverse-transpose normal matrix also handles negative scales.
    const face = {
      id,
      point: hit.point.toArray(),
      normal: hit.face.normal.clone().applyMatrix3(normalMatrix).normalize().toArray()
    };
    if (!snap.source) {
      snap.source = face;
      this._showFaceMarker(face);
      this.callbacks.onStatus?.('Click the target face on another shape. Escape cancels.');
    } else {
      const callback = snap.callback;
      const source = snap.source;
      this.cancelFaceSnap(false);
      callback?.({ source, target: face });
    }
  }

  _showFaceMarker(face) {
    if (this.faceMarker) disposeTree(this.faceMarker);
    const group = new THREE.Group();
    const point = new THREE.Vector3().fromArray(face.point);
    const normal = new THREE.Vector3().fromArray(face.normal);
    const radius = Math.max(.8, this._bounds().getSize(new THREE.Vector3()).length() / 120);
    const disk = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 10), new THREE.MeshBasicMaterial({ color: '#f49b40', depthTest: false }));
    disk.position.copy(point);
    disk.renderOrder = 20;
    const line = new THREE.BufferGeometry().setFromPoints([point, point.clone().addScaledVector(normal, radius * 5)]);
    group.add(disk, new THREE.Line(line, new THREE.LineBasicMaterial({ color: '#de8a35', depthTest: false })));
    this.scene.add(group);
    this.faceMarker = group;
    this.requestRender();
  }

  cancelFaceSnap(announce = true) {
    const active = !!this._faceSnap;
    this._faceSnap = null;
    this.canvas.style.cursor = '';
    if (this.faceMarker) { disposeTree(this.faceMarker); this.faceMarker = null; }
    this.setSelection(this.selectedIds);
    if (active && announce) this.callbacks.onStatus?.('Face attachment cancelled.');
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.resizeObserver.disconnect();
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.transform.dispose();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('dblclick', this._onDoubleClick);
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    window.removeEventListener('keydown', this._onKeyDown);
    for (const child of [...this.scene.children]) disposeTree(child);
    this.renderer.dispose();
    this.canvas.remove();
    this.axisCanvas.remove();
    this.measureLabel.remove();
    this.meshes.clear();
  }
}
