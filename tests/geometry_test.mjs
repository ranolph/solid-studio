import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, meshToSTL, readSTL, GEOMETRY_LIMITS } from '../static/geometry.js';

const engine = await createEngine();
let sequence = 0;
function shape(type = 'box', params = {}, transform = {}, extra = {}) {
  return { id: `part-${++sequence}`, name: type, type, role: 'solid', visible: true,
    params: { width: 10, depth: 10, height: 10, ...params },
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1], ...transform }, ...extra };
}
function group(operation, children, transform = {}) {
  return shape('boolean', {}, { position: [0, 0, 0], ...transform }, { operation, children });
}
function approximate(actual, expected, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
}
function watertight(mesh) {
  assert.ok(mesh && mesh.positions.length && mesh.indices.length, 'nonempty indexed mesh');
  const edges = new Map();
  let volume = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = Array.from(mesh.indices.subarray(i, i + 3));
    assert.equal(new Set(ids).size, 3, 'triangle has three distinct vertices');
    const p = ids.map(v => Array.from(mesh.positions.subarray(v * 3, v * 3 + 3)));
    for (const vertex of p) assert.ok(vertex.every(Number.isFinite), 'finite vertex');
    const [a, b, c] = p;
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    for (let k = 0; k < 3; ++k) {
      const u = ids[k], v = ids[(k + 1) % 3];
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      const state = edges.get(key) ?? { count: 0, orientation: 0 };
      state.count++; state.orientation += u < v ? 1 : -1;
      edges.set(key, state);
    }
  }
  for (const edge of edges.values()) {
    assert.equal(edge.count, 2, 'exactly two faces at each topological edge');
    assert.equal(edge.orientation, 0, 'adjacent faces have opposite edge direction');
  }
  assert.ok(volume > 0, 'outward winding encloses positive signed volume');
  approximate(volume, mesh.volume, Math.max(0.005, Math.abs(mesh.volume) * 2e-5));
}

test('all built-in primitives are finite, closed, oriented and exactly dimensioned', () => {
  for (const type of ['box', 'roundedBox', 'cylinder', 'cone', 'sphere', 'torus', 'tube', 'wedge', 'pyramid', 'polygon', 'capsule', 'gear']) {
    const mesh = engine.evaluateNode(shape(type, { width: 30, depth: 24, height: 42 }, { position: [0, 0, 21] }));
    watertight(mesh);
    mesh.bounds.min.forEach((v, i) => approximate(v, [-15, -12, 0][i]));
    mesh.bounds.max.forEach((v, i) => approximate(v, [15, 12, 42][i]));
  }
});

test('polyhedral primitives have independently known volumes', () => {
  approximate(engine.evaluateNode(shape()).volume, 1000);
  approximate(engine.evaluateNode(shape('wedge')).volume, 500);
  approximate(engine.evaluateNode(shape('pyramid')).volume, 1000 / 3);
});

test('fine sphere and cylinder approach analytical volume and retain manifold topology', () => {
  const sphere = engine.evaluateNode(shape('sphere', { width: 20, depth: 20, height: 20 }), 'fine');
  approximate(sphere.volume, 4 / 3 * Math.PI * 1000, 8);
  const cylinder = engine.evaluateNode(shape('cylinder', { width: 20, depth: 20, height: 20 }), 'fine');
  approximate(cylinder.volume, Math.PI * 100 * 20, 3);
  watertight(sphere); watertight(cylinder);
});

test('capsule defaults preserve existing geometry and each end can independently become flat', () => {
  const params = { width: 20, depth: 16, height: 40 };
  const legacy = engine.evaluateNode(shape('capsule', params, { position: [0, 0, 20] }));
  const explicit = engine.evaluateNode(shape('capsule', { ...params, topRoundness: 1, bottomRoundness: 1 }, { position: [0, 0, 20] }));
  assert.deepEqual(explicit.positions, legacy.positions);
  assert.deepEqual(explicit.indices, legacy.indices);
  const endRadius = (mesh, z) => {
    let radius = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (Math.abs(mesh.positions[i + 2] - z) < 1e-5) radius = Math.max(radius, Math.hypot(mesh.positions[i], mesh.positions[i + 1]));
    }
    return radius;
  };
  for (const [topRoundness, bottomRoundness] of [[0, 1], [1, 0], [0, 0]]) {
    const mesh = engine.evaluateNode(shape('capsule', { ...params, topRoundness, bottomRoundness }, { position: [0, 0, 20] }), 'fine');
    watertight(mesh);
    assert.deepEqual(mesh.bounds, { min: [-10, -8, 0], max: [10, 8, 40] });
    approximate(endRadius(mesh, 0), bottomRoundness === 0 ? 10 : 0);
    approximate(endRadius(mesh, 40), topRoundness === 0 ? 10 : 0);
    const analytical = Math.PI * 10 * 8 * (40 - 8 * (topRoundness + bottomRoundness) / 3);
    approximate(mesh.volume, analytical, analytical * 0.002);
  }
});

test('asymmetric capsule curves retain dimensions, volume and topology even when the caps fill its height', async () => {
  for (const [height, topRoundness, bottomRoundness] of [[48, 0.3, 1.7], [48, 2, 0.25], [10, 2, 0.5], [10, 2, 2]]) {
    const mesh = engine.evaluateNode(shape('capsule', { width: 24, depth: 16, height, topRoundness, bottomRoundness }, { position: [0, 0, height / 2] }), 'fine');
    watertight(mesh);
    mesh.bounds.min.forEach((value, axis) => approximate(value, [-12, -8, 0][axis]));
    mesh.bounds.max.forEach((value, axis) => approximate(value, [12, 8, height][axis]));
    const totalCapDepth = Math.min(height, 8 * (topRoundness + bottomRoundness));
    const analytical = Math.PI * 12 * 8 * (height - totalCapDepth / 3);
    approximate(mesh.volume, analytical, analytical * 0.002);
    const reversed = engine.evaluateNode(shape('capsule', { width: 24, depth: 16, height, topRoundness: bottomRoundness, bottomRoundness: topRoundness }, { position: [0, 0, height / 2] }), 'fine');
    approximate(reversed.volume, mesh.volume, 0.002);
  }
  const cutCapsule = engine.evaluateNode(shape('capsule', { width: 24, depth: 16, height: 48, topRoundness: 0, bottomRoundness: 1.6 }, { position: [0, 0, 24] }));
  const reimported = await engine.readSTL(meshToSTL(cutCapsule));
  watertight(reimported);
  approximate(reimported.volume, cutCapsule.volume, 0.01);
});

test('a build-plane cut removes material and seals the new floor instead of only hiding triangles', async () => {
  const node = shape('box', {}, { position: [0, 0, 0] }, { clipPlanes: [{ normal: [0, 0, 1], offset: 0 }] });
  const result = engine.evaluateProject({ objects: [node] });
  approximate(result.stats.volume, 500);
  assert.deepEqual(result.stats.bounds, { min: [-5, -5, 0], max: [5, 5, 5] });
  watertight(result.result);
  watertight(await engine.readSTL(meshToSTL(result.result)));
  assert.equal(result.meshes[0].volume, result.stats.volume, 'editable preview and final export both use the cut');
  assert.ok(!result.warnings.some(warning => /below the build/.test(warning)));
});

test('local cut planes preserve rotated, scaled and mirrored shapes and move with the resulting object', () => {
  const root13 = Math.sqrt(13);
  const node = shape('box', {}, { position: [0, 0, 0], rotation: [0, 45, 0], scale: [-2, 1, 3] }, {
    clipPlanes: [{ normal: [2 / root13, 0, 3 / root13], offset: 0 }],
  });
  const cut = engine.evaluateNode(node);
  approximate(cut.volume, 3000);
  approximate(cut.bounds.min[2], 0, 1e-6);
  watertight(cut);
  node.transform.position = [12, -8, 7];
  const moved = engine.evaluateNode(node);
  approximate(moved.volume, 3000);
  approximate(moved.bounds.min[2], 7, 1e-6);
  const parent = group('union', [node], { position: [0, 0, 11], scale: [1, 2, 1] });
  const nested = engine.evaluateNode(parent);
  approximate(nested.volume, 6000);
  approximate(nested.bounds.min[2], 18, 1e-6);
  watertight(nested);
});

test('cuts keep above-plane objects, remove fully below-plane objects and combine with holes', () => {
  const above = shape('box', {}, {}, { clipPlanes: [{ normal: [0, 0, 1], offset: -5 }] });
  approximate(engine.evaluateNode(above).volume, 1000);
  const below = shape('box', {}, { position: [0, 0, -10] }, { clipPlanes: [{ normal: [0, 0, 1], offset: 10 }] });
  assert.equal(engine.evaluateNode(below), null);
  assert.equal(engine.evaluateProject({ objects: [below] }).result, null);
  const slab = shape('box', {}, { position: [0, 0, 0] }, { clipPlanes: [{ normal: [0, 0, 1], offset: 0 }] });
  const hole = shape('box', { width: 4, depth: 4, height: 20 }, { position: [0, 0, 0] }, { role: 'hole', clipPlanes: [{ normal: [0, 0, 1], offset: 0 }] });
  const cutWithHole = engine.evaluateProject({ objects: [slab, hole] });
  approximate(cutWithHole.stats.volume, 420);
  watertight(cutWithHole.result);
  slab.clipPlanes.push({ normal: [-1, 0, 0], offset: 0 });
  approximate(engine.evaluateNode(slab).volume, 250);
});

test('malformed cut planes and invalid capsule curvature fail before allocation', () => {
  for (const clipPlanes of [null, {}, [{ normal: [0, 0, 0], offset: 0 }], [{ normal: [0, 0], offset: 0 }], [{ normal: [0, 0, Infinity], offset: 0 }], [{ normal: [0, 0, 1], offset: NaN }], Array.from({ length: 33 }, () => ({ normal: [0, 0, 1], offset: 0 }))]) {
    assert.throws(() => engine.evaluateNode(shape('box', {}, {}, { clipPlanes })), /cut plane|Cut-plane|cut planes/);
  }
  assert.throws(() => engine.evaluateNode(shape('capsule', { topRoundness: -0.01 })), /Top end curvature/);
  assert.throws(() => engine.evaluateNode(shape('capsule', { bottomRoundness: 2.01 })), /Bottom end curvature/);
});

test('union joins overlap without double counting the shared volume', () => {
  const result = engine.evaluateProject({ objects: [shape(), shape('box', {}, { position: [5, 0, 5] })] });
  approximate(result.stats.volume, 1500);
  assert.equal(result.stats.components, 1);
  watertight(result.result);
});

test('subtracting a through hole removes true material and is closed', () => {
  const result = engine.evaluateProject({ objects: [shape(), shape('box', { width: 4, depth: 4, height: 12 }, {}, { role: 'hole' })] });
  approximate(result.stats.volume, 840);
  assert.equal(result.stats.components, 1);
  watertight(result.result);
});

test('hole only affects intersecting material and never becomes positive export material', () => {
  const result = engine.evaluateProject({ objects: [shape(), shape('sphere', {}, { position: [100, 0, 5] }, { role: 'hole' })] });
  approximate(result.stats.volume, 1000);
  assert.equal(result.meshes.length, 2);
  watertight(result.result);
});

test('intersection and difference have known overlapping-box volumes', () => {
  const a = shape(), b = shape('box', {}, { position: [5, 0, 5] });
  for (const operation of ['intersection', 'difference']) {
    const mesh = engine.evaluateNode(group(operation, [a, b]));
    approximate(mesh.volume, 500);
    watertight(mesh);
  }
});

test('nested boolean children remain editable and parent transform applies afterwards', () => {
  const a = shape(), hole = shape('box', { width: 4, depth: 4, height: 12 });
  const inner = group('difference', [a, hole]);
  const outer = group('union', [inner, shape('box', { width: 5, depth: 5, height: 5 }, { position: [20, 0, 2.5] })], { position: [100, 0, 0], scale: [2, 1, 1] });
  const first = engine.evaluateNode(outer);
  approximate(first.volume, (840 + 125) * 2);
  approximate(first.bounds.min[0], 90);
  hole.params.width = 6;
  const second = engine.evaluateNode(outer);
  approximate(second.volume, (760 + 125) * 2);
  watertight(second);
});

test('world Euler order is X then Y then Z and negative scales preserve outward winding', () => {
  const mesh = engine.evaluateNode(shape('box', { width: 2, depth: 4, height: 6 }, { position: [10, 20, 30], rotation: [90, 90, 0], scale: [-2, 1, 1] }));
  // Width4, depth4, height6 => after Rx: 4,6,4; after Ry: 4,6,4.
  assert.deepEqual(mesh.bounds, { min: [8, 17, 28], max: [12, 23, 32] });
  approximate(mesh.volume, 96);
  watertight(mesh);
});

test('edit-context operation ignores hole roles and preserves exact ordered difference', () => {
  const a = shape('box', {}, {}, { role: 'hole' });
  const b = shape('box', {}, { position: [5, 0, 5] });
  const result = engine.evaluateProject({ objects: [a, b], combineOperation: 'difference' });
  approximate(result.stats.volume, 500);
  assert.equal(result.meshes.length, 2);
  approximate(result.stats.bounds.max[0], 0);
});

test('hiding the original difference base makes nested and edit-context results empty', () => {
  const base = shape('box', {}, {}, { visible: false });
  const cutter = shape('box', { width: 4, depth: 4, height: 12 });
  assert.equal(engine.evaluateNode(group('difference', [base, cutter])), null);
  const context = engine.evaluateProject({ objects: [base, cutter], combineOperation: 'difference' });
  assert.equal(context.result, null);
  assert.equal(context.meshes.length, 1, 'the visible cutter remains editable');
  assert.equal(context.meshes[0].id, cutter.id);
  assert.match(context.warnings[0], /no solid material/);
});

test('hiding a later difference operand disables only that cutter', () => {
  const base = shape(), hiddenCutter = shape('box', { width: 20, depth: 20, height: 20 }, {}, { visible: false });
  const cutter = shape('box', { width: 4, depth: 4, height: 12 });
  approximate(engine.evaluateNode(group('difference', [base, hiddenCutter, cutter])).volume, 840);
  const context = engine.evaluateProject({ objects: [base, hiddenCutter, cutter], combineOperation: 'difference' });
  approximate(context.stats.volume, 840);
  assert.equal(context.meshes.length, 2);
  watertight(context.result);
});

test('an empty nested base is never replaced by a cutter or ignored in an intersection', () => {
  const emptyBase = group('difference', [shape('box', {}, {}, { visible: false }), shape()]);
  const tool = shape();
  for (const operation of ['difference', 'intersection']) {
    assert.equal(engine.evaluateNode(group(operation, [emptyBase, tool])), null);
    const context = engine.evaluateProject({ objects: [emptyBase, tool], combineOperation: operation });
    assert.equal(context.result, null);
    assert.equal(context.meshes.length, 1);
  }
  // Empty cutters are harmless, and unions still include their other operands.
  approximate(engine.evaluateNode(group('difference', [tool, emptyBase])).volume, 1000);
  approximate(engine.evaluateNode(group('union', [emptyBase, tool])).volume, 1000);
});

test('hidden objects are excluded and disconnected solids are reported', () => {
  const hidden = shape('sphere', {}, {}, { visible: false });
  const result = engine.evaluateProject({ objects: [shape(), shape('box', {}, { position: [20, 0, 5] }), hidden] });
  approximate(result.stats.volume, 2000);
  assert.equal(result.stats.components, 2);
  assert.equal(result.meshes.length, 2);
  assert.match(result.warnings.join(' '), /separate solid pieces/);
});

test('an internal cavity counts as one solid component', () => {
  const result = engine.evaluateProject({ objects: [shape(), shape('box', { width: 4, depth: 4, height: 4 }, {}, { role: 'hole' })] });
  approximate(result.stats.volume, 936);
  assert.equal(result.stats.components, 1);
  watertight(result.result);
});

test('empty scenes, all-hole scenes and completely removed solids produce explicit empty result', () => {
  const empty = engine.evaluateProject({ objects: [] });
  assert.equal(empty.result, null);
  assert.equal(empty.stats.volume, 0);
  const holes = engine.evaluateProject({ objects: [shape('box', {}, {}, { role: 'hole' })] });
  assert.equal(holes.result, null);
  assert.match(holes.warnings[0], /Add a solid/);
  const removed = engine.evaluateProject({ objects: [shape(), shape('box', { width: 20, depth: 20, height: 20 }, {}, { role: 'hole' })] });
  assert.equal(removed.result, null);
  assert.match(removed.warnings[0], /no solid material/);
  assert.throws(() => meshToSTL(removed.result), /no solid material/);
});

test('binary STL preserves millimetres, topology and volume through roundtrip', async () => {
  const project = { objects: [group('difference', [shape('roundedBox', { width: 32, depth: 24, height: 8, radius: 1 }), shape('cylinder', { width: 6, depth: 6, height: 30 })])] };
  const { result } = engine.evaluateProject(project);
  const binary = meshToSTL(result);
  const parsed = await readSTL(binary);
  watertight(parsed);
  approximate(parsed.volume, result.volume, 0.002);
  parsed.bounds.min.forEach((v, i) => approximate(v, result.bounds.min[i]));
  parsed.bounds.max.forEach((v, i) => approximate(v, result.bounds.max[i]));
  assert.equal(new DataView(binary).getUint32(80, true), result.triangles);
  assert.equal(binary.byteLength, 84 + result.triangles * 50);
});

test('ASCII STL imports a closed solid and binary solid header is not mistaken for ASCII', async () => {
  const source = engine.evaluateNode(shape());
  let ascii = 'solid test\n';
  for (let i = 0; i < source.indices.length; i += 3) {
    ascii += 'facet normal 0 0 0\nouter loop\n';
    for (let j = 0; j < 3; ++j) ascii += `vertex ${Array.from(source.positions.subarray(source.indices[i + j] * 3, source.indices[i + j] * 3 + 3)).join(' ')}\n`;
    ascii += 'endloop\nendfacet\n';
  }
  ascii += 'endsolid test\n';
  const parsed = await engine.readSTL(new TextEncoder().encode(ascii));
  approximate(parsed.volume, 1000); watertight(parsed);
  const binary = meshToSTL(source);
  new Uint8Array(binary).set(new TextEncoder().encode('solid binary file'));
  approximate((await engine.readSTL(binary)).volume, 1000);
});

test('STL import rejects truncated, nonfinite, open, and inconsistent winding meshes', async () => {
  const source = engine.evaluateNode(shape());
  const binary = meshToSTL(source);
  await assert.rejects(engine.readSTL(binary.slice(0, -1)), /complete binary|truncated/);
  const nonfinite = binary.slice(0);
  new DataView(nonfinite).setFloat32(96, NaN, true);
  await assert.rejects(engine.readSTL(nonfinite), /finite number/);
  const missingTriangle = binary.slice(0, -50);
  new DataView(missingTriangle).setUint32(80, source.triangles - 1, true);
  await assert.rejects(engine.readSTL(missingTriangle), /closed, consistently oriented/);
  const reversed = { ...source, indices: source.indices.slice() };
  [reversed.indices[0], reversed.indices[1]] = [reversed.indices[1], reversed.indices[0]];
  await assert.rejects(engine.readSTL(meshToSTL(reversed)), /closed, consistently oriented/);
  const insideOut = { ...source, indices: source.indices.slice() };
  for (let i = 0; i < insideOut.indices.length; i += 3) [insideOut.indices[i], insideOut.indices[i + 1]] = [insideOut.indices[i + 1], insideOut.indices[i]];
  await assert.rejects(engine.readSTL(meshToSTL(insideOut)), /faces point inward/);
  await assert.rejects(engine.readSTL(new TextEncoder().encode('solid bad\nfacet normal 0 0 1\nendsolid bad')), /empty, malformed/);
});

test('invalid geometry is rejected without silently substituting or dropping a shape', () => {
  assert.throws(() => engine.evaluateNode(shape('unknown')), /Unsupported shape/);
  assert.throws(() => engine.evaluateNode(shape('box', { width: NaN })), /finite number/);
  assert.throws(() => engine.evaluateNode(shape('tube', { wall: 6 })), /Wall thickness/);
  assert.throws(() => engine.evaluateNode(shape('polygon', { sides: 5.5 })), /whole number/);
  assert.throws(() => engine.evaluateNode(shape('box', {}, { scale: [1, 0, 1] })), /Scale cannot be zero/);
  assert.throws(() => engine.evaluateProject({ objects: [shape(), shape('unknown')] }), /Unsupported shape/);
  assert.throws(() => engine.evaluateNode(shape(), 'unlimited'), /detail level/);
  const duplicate = shape();
  assert.throws(() => engine.evaluateProject({ objects: [duplicate, duplicate] }), /unique nonempty ID/);
});

test('complexity limits reject unreasonable documents before geometry allocation', () => {
  assert.throws(() => engine.evaluateProject({ objects: Array.from({ length: GEOMETRY_LIMITS.nodes + 1 }, () => shape()) }), /up to 256 objects/);
  let nested = shape();
  for (let i = 0; i <= GEOMETRY_LIMITS.depth; i++) nested = group('union', [nested]);
  assert.throws(() => engine.evaluateNode(nested), /too many nested/);
  assert.throws(() => engine.evaluateNode(shape('box', { height: 100000 })), /Height/);
});

test('a failed evaluation does not poison subsequent operations', () => {
  for (let i = 0; i < 5; i++) {
    assert.throws(() => engine.evaluateProject({ objects: [shape('roundedBox'), shape('tube', { wall: 90 })] }));
    approximate(engine.evaluateNode(shape()).volume, 1000);
  }
});
