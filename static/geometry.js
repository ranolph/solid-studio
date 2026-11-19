/* Solid Studio geometry kernel. Millimetres, Z up, centred local shapes.
 * All constructive solid operations use Manifold, not concatenated triangles.
 * The WASM objects created during a job are disposed even when a job fails.
 */
import Module from './vendor/manifold.js';

export const GEOMETRY_LIMITS = Object.freeze({
  nodes: 256, depth: 24, inputTriangles: 250_000,
  outputTriangles: 750_000, fileBytes: 40 * 1024 * 1024,
  dimension: 10_000, coordinate: 1_000_000, clipPlanes: 32,
});

let sharedEngine;

function number(value, fallback, label, min = -Infinity, max = Infinity) {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  }
  return n;
}

function vector(value, fallback, label, max = GEOMETRY_LIMITS.coordinate) {
  const v = value === undefined ? fallback : value;
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${label} must contain X, Y and Z.`);
  return v.map((n, i) => number(n, undefined, `${label} ${'XYZ'[i]}`, -max, max));
}

function emptyStats() { return { volume: 0, triangles: 0, bounds: null, components: 0 }; }

function clippingPlanes(node) {
  if (node.clipPlanes === undefined) return [];
  if (!Array.isArray(node.clipPlanes) || node.clipPlanes.length > GEOMETRY_LIMITS.clipPlanes) {
    throw new Error(`An object can contain up to ${GEOMETRY_LIMITS.clipPlanes} cut planes.`);
  }
  return node.clipPlanes.map(plane => {
    if (!plane || typeof plane !== 'object' || Array.isArray(plane)) throw new Error('Invalid cut plane.');
    const normal = vector(plane.normal, undefined, 'Cut-plane normal');
    const length = Math.hypot(...normal);
    if (length < 1e-9) throw new Error('Cut-plane normal must not be zero.');
    const offset = number(plane.offset, undefined, 'Cut-plane offset', -GEOMETRY_LIMITS.coordinate, GEOMETRY_LIMITS.coordinate);
    return { normal: normal.map(value => value / length), offset };
  });
}

function validateGraph(objects) {
  if (!Array.isArray(objects)) throw new Error('The design must contain an objects list.');
  let count = 0, inputTriangles = 0;
  const ids = new Set();
  const active = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid object in design.');
    if (++count > GEOMETRY_LIMITS.nodes) throw new Error(`A design can contain up to ${GEOMETRY_LIMITS.nodes} objects, including nested parts.`);
    if (depth > GEOMETRY_LIMITS.depth || active.has(node)) throw new Error('The design has too many nested groups or a circular reference.');
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) throw new Error('Every object must have a unique nonempty ID.');
    ids.add(node.id);
    if (node.role !== undefined && node.role !== 'solid' && node.role !== 'hole') throw new Error('Object role must be solid or hole.');
    clippingPlanes(node);
    if (node.type === 'mesh') {
      inputTriangles += Math.floor((node.params?.indices?.length ?? 0) / 3);
      if (inputTriangles > GEOMETRY_LIMITS.inputTriangles) throw new Error(`Imported geometry exceeds the ${GEOMETRY_LIMITS.inputTriangles.toLocaleString()} triangle limit per design.`);
    }
    if (node.type === 'boolean') {
      if (!Array.isArray(node.children) || !node.children.length) throw new Error('A combined object needs at least one child.');
      if (!['union', 'difference', 'intersection'].includes(node.operation)) throw new Error('Unknown solid operation.');
      active.add(node);
      node.children.forEach(child => visit(child, depth + 1));
      active.delete(node);
    }
  };
  objects.forEach(node => visit(node, 0));
}

function normalisedPolygon(points, width, depth) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return points.map(([x, y]) => [
    (x - (minX + maxX) / 2) * width / (maxX - minX),
    (y - (minY + maxY) / 2) * depth / (maxY - minY),
  ]);
}

function plainError(error, prefix = '') {
  const message = typeof error?.message === 'string' ? error.message : String(error);
  if (/not.?manifold|non.?manifold|NotManifold|NotFinite|invalid.*mesh/i.test(message)) {
    return new Error(`${prefix}The mesh is not a closed, consistently oriented solid. Repair open edges or reversed faces in your source model, then import it again.`);
  }
  return new Error(prefix + message);
}

export async function createEngine(options = {}) {
  if (!Object.keys(options).length) {
    sharedEngine ??= initialise(options).catch(error => { sharedEngine = undefined; throw error; });
    return sharedEngine;
  }
  return initialise(options);
}

async function initialise(options) {
  const wasm = await Module(options);
  wasm.setup();
  const { Manifold, CrossSection, Mesh } = wasm;

  // Emscripten wrapper objects do not have JavaScript garbage collection.
  function job(run) {
    const owned = [];
    const own = object => { owned.push(object); return object; };
    try { return run(own); }
    finally { for (let i = owned.length - 1; i >= 0; --i) owned[i].delete(); }
  }

  function assertValid(solid) {
    const status = solid.status();
    if (status !== 'NoError') throw new Error(`The solid operation failed: ${status}.`);
    if (solid.numTri() > GEOMETRY_LIMITS.outputTriangles) throw new Error('This result is too complex. Reduce detail or the number of copies before trying again.');
    return solid;
  }

  function fromMesh(params, own) {
    const p = params.positions, idx = params.indices;
    if ((!Array.isArray(p) && !ArrayBuffer.isView(p)) || (!Array.isArray(idx) && !ArrayBuffer.isView(idx))) {
      throw new Error('Imported geometry needs vertex and triangle arrays.');
    }
    if (p.length < 12 || p.length % 3 || idx.length < 12 || idx.length % 3) throw new Error('The imported mesh has incomplete triangles or vertices.');
    if (idx.length / 3 > GEOMETRY_LIMITS.inputTriangles || p.length / 3 > GEOMETRY_LIMITS.inputTriangles * 3) throw new Error('The imported mesh exceeds the geometry limit.');
    for (const value of p) number(value, undefined, 'Mesh coordinate', -GEOMETRY_LIMITS.coordinate, GEOMETRY_LIMITS.coordinate);
    for (const value of idx) {
      if (!Number.isInteger(value) || value < 0 || value >= p.length / 3) throw new Error('The imported mesh contains an invalid vertex index.');
    }
    const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(p), triVerts: Uint32Array.from(idx) });
    // Merge only compatible open boundaries within the kernel's scale-derived
    // tolerance; do not round every coordinate onto an arbitrary coarse grid.
    mesh.merge();
    try {
      const solid = assertValid(own(new Manifold(mesh)));
      if (solid.isEmpty() || solid.volume() === 0) throw new Error('The STL contains no solid volume.');
      if (solid.volume() < 0) throw new Error('The STL faces point inward. Reverse their orientation in the source model, then import it again.');
      return solid;
    }
    catch (error) { throw plainError(error, 'Cannot use this STL: '); }
  }

  function primitive(node, quality, own) {
    const p = node.params ?? {};
    if (node.type === 'mesh') return fromMesh(p, own);
    const w = number(p.width, 20, 'Width', 0.05, GEOMETRY_LIMITS.dimension);
    const d = number(p.depth, 20, 'Depth', 0.05, GEOMETRY_LIMITS.dimension);
    const h = number(p.height, 20, 'Height', 0.05, GEOMETRY_LIMITS.dimension);
    const segments = quality === 'fine' ? 128 : 64;
    const sphereSegments = quality === 'fine' ? 128 : 64;
    switch (node.type) {
      case 'box': return own(Manifold.cube([w, d, h], true));
      case 'roundedBox': {
        const requested = number(p.radius, Math.min(w, d, h) / 8, 'Corner radius', 0, GEOMETRY_LIMITS.dimension);
        const r = Math.min(requested, w / 2, d / 2, h / 2);
        if (r < 0.001) return own(Manifold.cube([w, d, h], true));
        const ball = own(Manifold.sphere(r, sphereSegments));
        const corners = [];
        for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
          corners.push(own(ball.translate([x * (w / 2 - r), y * (d / 2 - r), z * (h / 2 - r)])));
        }
        return own(Manifold.hull(corners));
      }
      case 'cylinder':
        return own(own(Manifold.cylinder(h, 1, 1, segments, true)).scale([w / 2, d / 2, 1]));
      case 'cone': {
        const ratio = number(p.topRatio, 0, 'Top radius ratio', 0, 1);
        return own(own(Manifold.cylinder(h, 1, ratio, segments, true)).scale([w / 2, d / 2, 1]));
      }
      case 'sphere': return own(own(Manifold.sphere(1, sphereSegments)).scale([w / 2, d / 2, h / 2]));
      case 'torus': {
        const ratio = number(p.tubeRatio, 0.27, 'Ring thickness ratio', 0.02, 0.49);
        const profile = own(own(CrossSection.circle(ratio, quality === 'fine' ? 48 : 24)).translate([1 - ratio, 0]));
        return own(own(profile.revolve(segments)).scale([w / 2, d / 2, h / (2 * ratio)]));
      }
      case 'tube': {
        const wall = number(p.wall, Math.min(2, Math.min(w, d) / 4), 'Wall thickness', 0.025, Math.min(w, d) / 2 - 0.01);
        const outer = own(own(Manifold.cylinder(h, 1, 1, segments, true)).scale([w / 2, d / 2, 1]));
        const inner = own(own(Manifold.cylinder(h + 0.1, 1, 1, segments, true)).scale([w / 2 - wall, d / 2 - wall, 1]));
        return own(outer.subtract(inner));
      }
      case 'wedge': return own(Manifold.hull([
        [-w / 2, -d / 2, -h / 2], [-w / 2, d / 2, -h / 2],
        [w / 2, -d / 2, -h / 2], [w / 2, d / 2, -h / 2],
        [w / 2, -d / 2, h / 2], [w / 2, d / 2, h / 2],
      ]));
      case 'pyramid': return own(Manifold.hull([
        [-w / 2, -d / 2, -h / 2], [-w / 2, d / 2, -h / 2],
        [w / 2, -d / 2, -h / 2], [w / 2, d / 2, -h / 2], [0, 0, h / 2],
      ]));
      case 'polygon': {
        const sides = number(p.sides, 6, 'Number of sides', 3, 64);
        if (!Number.isInteger(sides)) throw new Error('Number of sides must be a whole number.');
        const polygon = Array.from({ length: sides }, (_, i) => [Math.cos(i * 2 * Math.PI / sides), Math.sin(i * 2 * Math.PI / sides)]);
        const section = own(new CrossSection([normalisedPolygon(polygon, w, d)]));
        return own(section.extrude(h, 0, 0, [1, 1], true));
      }
      case 'capsule': {
        const top = number(p.topRoundness, 1, 'Top end curvature', 0, 2);
        const bottom = number(p.bottomRoundness, 1, 'Bottom end curvature', 0, 2);
        // Keep existing projects (and the default new capsule) exactly unchanged.
        if (top === 1 && bottom === 1) {
          const rz = Math.min(w / 2, d / 2, h / 2);
          const cap = own(own(Manifold.sphere(1, sphereSegments)).scale([w / 2, d / 2, rz]));
          const low = own(cap.translate([0, 0, -h / 2 + rz]));
          const high = own(cap.translate([0, 0, h / 2 - rz]));
          return own(Manifold.hull([low, high]));
        }
        const radius = Math.min(w, d) / 2;
        const requested = radius * (top + bottom);
        const reduction = requested > h ? h / requested : 1;
        const topDepth = radius * top * reduction;
        const bottomDepth = radius * bottom * reduction;
        const quarterSteps = segments / 4;
        const points = [[0, -h / 2]];
        const add = (r, z) => {
          const previous = points[points.length - 1];
          if (Math.abs(previous[0] - r) > 1e-12 || Math.abs(previous[1] - z) > 1e-12) points.push([r, z]);
        };
        if (bottomDepth > 0) {
          for (let i = 1; i <= quarterSteps; ++i) {
            const angle = i * Math.PI / (2 * quarterSteps);
            add(i === quarterSteps ? 1 : Math.sin(angle), -h / 2 + bottomDepth * (i === quarterSteps ? 1 : 1 - Math.cos(angle)));
          }
        } else add(1, -h / 2);
        add(1, h / 2 - topDepth);
        if (topDepth > 0) {
          for (let i = 1; i <= quarterSteps; ++i) {
            const angle = i * Math.PI / (2 * quarterSteps);
            add(i === quarterSteps ? 0 : Math.cos(angle), h / 2 - topDepth + topDepth * (i === quarterSteps ? 1 : Math.sin(angle)));
          }
        } else add(0, h / 2);
        const section = own(new CrossSection([points]));
        return own(own(section.revolve(segments)).scale([w / 2, d / 2, 1]));
      }
      case 'gear': {
        const teeth = number(p.teeth, 16, 'Number of teeth', 6, 64);
        if (!Number.isInteger(teeth)) throw new Error('Number of teeth must be a whole number.');
        const toothDepth = number(p.toothDepth, 0.18, 'Tooth depth ratio', 0.05, 0.4);
        const points = [];
        for (let i = 0; i < teeth; i++) {
          for (const [phase, radius] of [[0, 1 - toothDepth], [0.18, 1 - toothDepth], [0.3, 1], [0.7, 1], [0.82, 1 - toothDepth]]) {
            const a = 2 * Math.PI * (i + phase) / teeth;
            points.push([radius * Math.cos(a), radius * Math.sin(a)]);
          }
        }
        const section = own(new CrossSection([normalisedPolygon(points, w, d)]));
        return own(section.extrude(h, 0, 0, [1, 1], true));
      }
      default: throw new Error(`Unsupported shape: ${String(node.type)}.`);
    }
  }

  function combine(solids, operation, own) {
    if (!solids.length) return null;
    if (solids.length === 1) return solids[0];
    if (operation === 'union') return own(Manifold.union(solids));
    if (operation === 'intersection') return own(Manifold.intersection(solids));
    if (operation === 'difference') return own(Manifold.difference(solids));
    throw new Error('Unknown solid operation.');
  }

  function build(node, quality, own) {
    let solid;
    try {
      if (node.type === 'boolean') {
        // Difference has an identity-bearing first operand. Hiding that base
        // removes the result; it must never promote a cutting tool into a base.
        if (node.operation === 'difference' && node.children[0].visible === false) return null;
        // A visible base may itself evaluate to empty (for example a nested
        // intersection). That is still an empty difference, not a new base.
        if (node.operation === 'difference') {
          const base = build(node.children[0], quality, own);
          if (!base || base.isEmpty()) return null;
          const cutters = node.children.slice(1).filter(child => child.visible !== false).map(child => build(child, quality, own)).filter(Boolean);
          solid = combine([base, ...cutters], 'difference', own);
        } else {
          const children = node.children.filter(child => child.visible !== false).map(child => build(child, quality, own));
          if (node.operation === 'intersection' && children.some(child => !child || child.isEmpty())) return null;
          solid = combine(children.filter(Boolean), node.operation, own);
        }
      } else solid = primitive(node, quality, own);
      if (!solid) return null;
      // A cut belongs to the object's local geometry, so moving, mirroring or
      // grouping it afterwards carries the sealed cut face with the object.
      for (const plane of clippingPlanes(node)) {
        solid = own(solid.trimByPlane(plane.normal, plane.offset));
        assertValid(solid);
        if (solid.isEmpty()) return null;
      }
      const transform = node.transform ?? {};
      const scale = vector(transform.scale, [1, 1, 1], 'Scale', 1000);
      if (scale.some(v => Math.abs(v) < 0.00001)) throw new Error('Scale cannot be zero.');
      const rotation = vector(transform.rotation, [0, 0, 0], 'Rotation', 360000);
      const position = vector(transform.position, [0, 0, 0], 'Position');
      if (scale.some(v => v !== 1)) solid = own(solid.scale(scale));
      if (rotation.some(v => v !== 0)) solid = own(solid.rotate(rotation));
      if (position.some(v => v !== 0)) solid = own(solid.translate(position));
      assertValid(solid);
      return solid;
    } catch (error) { throw plainError(error, `${node.name || node.type}: `); }
  }

  function packet(solid) {
    if (!solid || solid.isEmpty()) return null;
    assertValid(solid);
    const mesh = solid.getMesh();
    // Preserve Manifold's topology when stripping material-run/property seams.
    const parents = new Uint32Array(mesh.numVert);
    for (let i = 0; i < parents.length; ++i) parents[i] = i;
    const root = i => {
      let p = i;
      while (parents[p] !== p) p = parents[p];
      while (parents[i] !== i) { const next = parents[i]; parents[i] = p; i = next; }
      return p;
    };
    for (let i = 0; i < mesh.mergeFromVert.length; ++i) parents[root(mesh.mergeFromVert[i])] = root(mesh.mergeToVert[i]);
    const remap = new Map(), verts = [], indices = new Uint32Array(mesh.triVerts.length);
    for (let i = 0; i < mesh.triVerts.length; ++i) {
      const index = root(mesh.triVerts[i]);
      let mapped = remap.get(index);
      if (mapped === undefined) {
        mapped = verts.length / 3; remap.set(index, mapped);
        verts.push(mesh.vertProperties[index * mesh.numProp], mesh.vertProperties[index * mesh.numProp + 1], mesh.vertProperties[index * mesh.numProp + 2]);
      }
      indices[i] = mapped;
    }
    const bounds = solid.boundingBox();
    return { positions: Float32Array.from(verts), indices, bounds: { min: [...bounds.min], max: [...bounds.max] }, volume: solid.volume(), triangles: indices.length / 3 };
  }

  function evaluateNode(node, quality = 'standard') {
    validateGraph([node]);
    if (!['standard', 'fine'].includes(quality)) throw new Error('Unknown mesh detail level.');
    return job(own => packet(build(node, quality, own)));
  }

  function evaluateProject(project, { quality = 'standard' } = {}) {
    validateGraph(project?.objects);
    if (!['standard', 'fine'].includes(quality)) throw new Error('Unknown mesh detail level.');
    if (project.combineOperation !== undefined && !['union', 'difference', 'intersection'].includes(project.combineOperation)) throw new Error('Unknown edit-context operation.');
    return job(own => {
      const meshes = [], solids = [], holes = [], operands = [], byId = new Map();
      for (const node of project.objects) {
        if (node.visible === false) continue;
        const solid = build(node, quality, own);
        byId.set(node.id, solid);
        if (!solid) continue;
        const data = packet(solid);
        if (data) meshes.push({ id: node.id, ...data });
        operands.push(solid);
        (node.role === 'hole' ? holes : solids).push(solid);
      }
      let final;
      if (project.combineOperation === 'difference') {
        const baseNode = project.objects[0];
        // All visible operands are still returned above for source-part editing.
        // Preserve the original base even if it is hidden or evaluates to empty.
        if (baseNode && baseNode.visible !== false) {
          const base = byId.get(baseNode.id);
          if (base && !base.isEmpty()) {
            const cutters = project.objects.slice(1).filter(node => node.visible !== false).map(node => byId.get(node.id)).filter(Boolean);
            final = combine([base, ...cutters], 'difference', own);
          }
        }
      }
      else if (project.combineOperation === 'intersection' && [...byId.values()].some(solid => !solid || solid.isEmpty())) final = null;
      else if (project.combineOperation) final = combine(operands, project.combineOperation, own);
      else {
        final = combine(solids, 'union', own);
        if (final && holes.length) final = own(final.subtract(combine(holes, 'union', own)));
      }
      const result = packet(final);
      const warnings = [];
      if (!result) {
        if (solids.length || project.combineOperation) warnings.push('The operation leaves no solid material. Move or resize the cutting parts.');
        else if (holes.length) warnings.push('Add a solid object; holes by themselves do not export.');
        return { meshes, result: null, stats: emptyStats(), warnings };
      }
      const parts = final.decompose().map(own);
      // Closed internal cavities have negative volume; count only solid pieces.
      const components = parts.filter(part => part.volume() > 0).length;
      if (components > 1) warnings.push(`${components} separate solid pieces. Overlap pieces before joining if you need one connected print.`);
      if (result.bounds.min[2] < -0.001) warnings.push('Some geometry is below the build plate. Use Drop to bed before exporting.');
      return { meshes, result, stats: { volume: result.volume, triangles: result.triangles, bounds: result.bounds, components }, warnings };
    });
  }

  function validateMesh(raw) {
    return job(own => packet(fromMesh(raw, own)));
  }

  return { evaluateNode, evaluateProject, validateMesh, readSTL: async buffer => validateMesh(parseSTL(buffer)), meshToSTL };
}

function asBytes(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new Error('Choose an STL file to import.');
}

function parseSTL(buffer) {
  const bytes = asBytes(buffer);
  if (bytes.byteLength > GEOMETRY_LIMITS.fileBytes) throw new Error('STL import is limited to 40 MiB. Reduce the mesh detail and try again.');
  if (bytes.byteLength < 15) throw new Error('This STL file is empty or truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength >= 84 ? view.getUint32(80, true) : 0;
  let vertices;
  if (count > 0 && 84 + count * 50 === bytes.byteLength) {
    if (count > GEOMETRY_LIMITS.inputTriangles) throw new Error('This STL exceeds the 250,000 triangle import limit.');
    vertices = new Float32Array(count * 9);
    for (let t = 0; t < count; ++t) for (let j = 0; j < 9; ++j) {
      vertices[t * 9 + j] = view.getFloat32(84 + t * 50 + 12 + j * 4, true);
    }
  } else {
    // Binary files can start with "solid". Exact binary length is checked first.
    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '').trim();
    if (!/^solid(?:\s|$)/i.test(text) || !/endsolid(?:\s|$)/i.test(text) || /[^\x09\x0a\x0d\x20-\x7e]/.test(text)) {
      throw new Error('This is not a complete binary or ASCII STL. Check that the file was fully downloaded.');
    }
    const float = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const vertex = `vertex\\s+(${float})\\s+(${float})\\s+(${float})`;
    const facet = new RegExp(`facet\\s+normal\\s+${float}\\s+${float}\\s+${float}\\s+outer\\s+loop\\s+${vertex}\\s+${vertex}\\s+${vertex}\\s+endloop\\s+endfacet`, 'gi');
    const values = [];
    const matches = [...text.matchAll(facet)];
    if (!matches.length || matches.length > GEOMETRY_LIMITS.inputTriangles) throw new Error('The STL is empty, malformed, or exceeds the triangle limit.');
    const remainder = text.replace(facet, '').replace(/^\s*(?:endsolid|solid)[^\r\n]*(?:\r?\n|$)/gim, '').trim();
    if (remainder) throw new Error('The ASCII STL has malformed or incomplete facets.');
    for (const match of matches) for (let j = 1; j <= 9; j++) values.push(Number(match[j]));
    vertices = Float32Array.from(values);
  }
  const indices = new Uint32Array(vertices.length / 3);
  for (let i = 0; i < indices.length; ++i) indices[i] = i;
  return { positions: vertices, indices };
}

export async function readSTL(buffer) { return (await createEngine()).readSTL(buffer); }

export function meshToSTL(packet) {
  if (!packet?.positions?.length || !packet?.indices?.length) throw new Error('There is no solid material to export.');
  const { positions: p, indices } = packet;
  if (p.length % 3 || indices.length % 3 || indices.length / 3 > GEOMETRY_LIMITS.outputTriangles) throw new Error('Cannot export an invalid or oversized mesh.');
  const count = indices.length / 3;
  const buffer = new ArrayBuffer(84 + count * 50);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode('Solid Studio | millimetres | manifold solid'));
  const view = new DataView(buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; ++t) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    if (![a, b, c].every(i => Number.isInteger(i) && i >= 0 && i + 2 < p.length)) throw new Error('The mesh contains an invalid triangle.');
    const ab = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const ac = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const len = Math.hypot(...n);
    const start = 84 + t * 50;
    for (let k = 0; k < 3; ++k) view.setFloat32(start + k * 4, len ? n[k] / len : 0, true);
    for (const [corner, index] of [a, b, c].entries()) for (let k = 0; k < 3; ++k) {
      const value = p[index + k];
      if (!Number.isFinite(value)) throw new Error('Cannot export non-finite geometry.');
      view.setFloat32(start + 12 + (corner * 3 + k) * 4, value, true);
    }
    view.setUint16(start + 48, 0, true);
  }
  return buffer;
}
