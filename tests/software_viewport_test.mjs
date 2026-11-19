import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../static/vendor/three.module.js';
import { nodeMatrix } from '../static/viewport.js';
import { SoftwareViewport } from '../static/software-viewport.js';

function fixture(scale = [1, 1, 1]) {
  const node = { id: 'box', color: '#ee8765', transform: { position: [0, 0, 20], rotation: [0, 0, 0], scale } };
  const source = new THREE.BoxGeometry(20, 20, 20).applyMatrix4(nodeMatrix(node));
  const indices = Uint32Array.from(source.index.array);
  if (scale[0] * scale[1] * scale[2] < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  const packet = { positions: Float32Array.from(source.attributes.position.array), indices };
  const view = Object.create(SoftwareViewport.prototype);
  view._width = 400; view._height = 300; view.selectedIds = []; view.displayMode = 'solid'; view.resultEnabled = false;
  view.camera = new THREE.PerspectiveCamera(38, 400 / 300, .1, 2000); view.camera.up.set(0, 0, 1);
  view.camera.position.set(90, -100, 90); view.camera.lookAt(0, 0, 20); view.camera.updateMatrixWorld(true);
  view.raycaster = new THREE.Raycaster(); view.canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) };
  const mesh = view._makeMesh(packet, node); view.meshes = new Map([[node.id, mesh]]);
  source.dispose();
  return { view, mesh };
}

test('software renderer projects and lights only the three visible cube sides', () => {
  const { view, mesh } = fixture();
  const faces = view._faces(mesh);
  assert.equal(faces.length, 6);
  assert.ok(faces.every(face => face.depth > 0 && Number.isFinite(face.x1 + face.y1 + face.x2 + face.y2 + face.x3 + face.y3)));
  assert.ok(new Set(faces.map(face => face.color)).size >= 3);
  view._disposeMesh(mesh);
});

test('software picking uses real projected triangles and returns an outward normal', () => {
  const { view, mesh } = fixture();
  const hit = view._pick({ clientX: 200, clientY: 150 });
  assert.equal(hit.object.userData.nodeId, 'box');
  assert.ok(hit.face.normal.length() > .99);
  const normal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
  assert.ok(normal.dot(view.camera.position.clone().sub(hit.point)) > 0);
  view._disposeMesh(mesh);
});

test('mirrored software meshes retain outward surfaces and exact bounds', () => {
  const { view, mesh } = fixture([-2, 1, .5]);
  assert.equal(view._faces(mesh).length, 6);
  assert.deepEqual(view.getBounds('box'), { min: [-20, -10, 15], max: [20, 10, 25] });
  const hit = view._pick({ clientX: 200, clientY: 150 });
  assert.ok(hit);
  const normal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
  assert.ok(normal.dot(view.camera.position.clone().sub(hit.point)) > 0);
  view._disposeMesh(mesh);
});
