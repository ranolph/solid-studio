import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const target=resolve(root,'static/vendor');
await mkdir(target,{recursive:true});
for(const file of ['three.module.js','three.core.js']) await copyFile(resolve(root,'node_modules/three/build',file),resolve(target,file));
for(const file of ['OrbitControls','TransformControls']) {
  const source=await readFile(resolve(root,'node_modules/three/examples/jsm/controls',file+'.js'),'utf8');
  await writeFile(resolve(target,file+'.js'),source.replaceAll("from 'three'","from './three.module.js'"));
}
for(const file of ['manifold.js','manifold.wasm']) await copyFile(resolve(root,'node_modules/manifold-3d',file),resolve(target,file));
await mkdir(resolve(root,'licenses'),{recursive:true});
await copyFile(resolve(root,'node_modules/three/LICENSE'),resolve(root,'licenses/THREE-LICENSE.txt'));
await copyFile(resolve(root,'node_modules/manifold-3d/LICENSE'),resolve(root,'licenses/MANIFOLD-LICENSE.txt'));
await writeFile(resolve(target,'VERSIONS.json'),JSON.stringify({three:'0.187.0','manifold-3d':'3.5.5'},null,2)+'\n');
console.log('Pinned runtime assets vendored; no CDN needed.');
