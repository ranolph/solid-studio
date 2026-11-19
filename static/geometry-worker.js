import { createEngine, meshToSTL } from './geometry.js';

let enginePromise;
function engine() { enginePromise ??= createEngine(); return enginePromise; }

function transfers(value, collected = new Set()) {
  if (value instanceof ArrayBuffer) collected.add(value);
  else if (ArrayBuffer.isView(value)) collected.add(value.buffer);
  else if (value && typeof value === 'object') Object.values(value).forEach(child => transfers(child, collected));
  return collected;
}

// One job at a time. A slow operation never blocks camera controls or editing.
let queue = Promise.resolve();
self.addEventListener('message', event => {
  const request = event.data;
  queue = queue.then(async () => {
    const { id, action, project, quality = 'standard', buffer } = request;
    try {
      const geometry = await engine();
      let result;
      if (action === 'evaluate') result = geometry.evaluateProject(project, { quality });
      else if (action === 'export') {
        const evaluated = geometry.evaluateProject(project, { quality });
        result = { buffer: meshToSTL(evaluated.result), stats: evaluated.stats, warnings: evaluated.warnings };
      } else if (action === 'import') result = await geometry.readSTL(buffer);
      else throw new Error('Unknown geometry task.');
      self.postMessage({ id, ok: true, result }, [...transfers(result)]);
    } catch (error) {
      self.postMessage({ id, ok: false, error: error?.message || String(error) });
    }
  }).catch(error => {
    self.postMessage({ id: request?.id, ok: false, error: error?.message || String(error) });
  });
});
