import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../static/vendor/three.module.js';
import { nodeMatrix, worldPacketToGeometry } from '../static/viewport.js';

function close(actual, expected, tolerance = 1e-4) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < tolerance, `${actual} differs from ${expected}`));
}

function worldBox(node) {
  const source = new THREE.BoxGeometry(10, 20, 30);
  const matrix = nodeMatrix(node);
  source.applyMatrix4(matrix);
  const indices = Uint32Array.from(source.index.array);
  // Geometry engine output is outward wound in world coordinates.
  if (matrix.determinant() < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  const packet = { positions: Float32Array.from(source.attributes.position.array), indices };
  source.dispose();
  return packet;
}

test('viewport uses world X then Y then Z rotations and preserves millimetres', () => {
  const matrix = nodeMatrix({ transform: { position: [10, 20, 30], rotation: [90, 90, 90], scale: [1, 1, 1] } });
  close(new THREE.Vector3(1, 2, 3).applyMatrix4(matrix).toArray(), [13, 22, 29]);
});

test('world mesh is restored to node-local space without changing world vertices', () => {
  const node = { transform: { position: [14, -9, 33], rotation: [25, 40, -12], scale: [1.5, 2, .5] } };
  const packet = worldBox(node);
  const matrix = nodeMatrix(node);
  const geometry = worldPacketToGeometry(packet, matrix);
  const point = new THREE.Vector3();
  for (let i = 0; i < packet.indices.length; i++) {
    point.fromBufferAttribute(geometry.attributes.position, i).applyMatrix4(matrix);
    close(point.toArray(), [...packet.positions.slice(packet.indices[i] * 3, packet.indices[i] * 3 + 3)]);
  }
  geometry.dispose();
});

test('mirrored non-uniformly-scaled objects keep outward face normals for attachment', () => {
  const node = { transform: { position: [14, -9, 33], rotation: [25, 40, -12], scale: [-1.5, 2, .5] } };
  const matrix = nodeMatrix(node);
  const geometry = worldPacketToGeometry(worldBox(node), matrix);
  const center = new THREE.Vector3().fromArray(node.transform.position);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const point = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    point.fromBufferAttribute(geometry.attributes.position, i).applyMatrix4(matrix).sub(center);
    normal.fromBufferAttribute(geometry.attributes.normal, i).applyMatrix3(normalMatrix).normalize();
    assert.ok(normal.dot(point) > 4.9, 'a mirrored face normal points into the solid');
  }
  geometry.dispose();
});

test('box shading keeps its 90-degree edges sharp instead of rounding every corner', () => {
  const node = { transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } };
  const geometry = worldPacketToGeometry(worldBox(node), nodeMatrix(node));
  for (let i = 0; i < geometry.attributes.normal.count; i++) {
    const normal = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, i);
    close([normal.length()], [1]);
    assert.equal([normal.x, normal.y, normal.z].filter(value => Math.abs(value) > .99).length, 1);
  }
  geometry.dispose();
});
