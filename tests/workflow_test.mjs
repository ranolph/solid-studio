import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blankProject,makeNode,makeBoolean,combineSelection,validateProject,clone,History} from '../static/model.js';
import {createEngine,meshToSTL} from '../static/geometry.js';

const engine=await createEngine();
const doc=(...objects)=>({...blankProject(),objects});
const box=(params={},transform={},extra={})=>makeNode('box',{params:{width:20,depth:20,height:20,...params},transform,...extra});
const near=(a,b,tolerance=1e-4)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);

test('Join respects global negative roles, preserves selection geometry, and keeps source parts editable',()=>{
  const base=box(),hole=box({width:4,depth:8,height:30},{position:[0,0,10]},{role:'hole'});
  const original=doc(base,hole),before=engine.evaluateProject(original);
  const joined=combineSelection('union',[hole,base]);
  const project=validateProject(doc(joined));
  assert.equal(joined.operation,'difference');
  assert.equal(joined.role,'solid');
  const after=engine.evaluateProject(project);
  near(after.stats.volume,before.stats.volume);near(after.stats.volume,7360);
  assert.deepEqual(after.stats.bounds,before.stats.bounds);
  // Joining clones its operands so undo snapshots are not mutated by editing.
  joined.children[1].params.width=6;
  near(engine.evaluateProject(project).stats.volume,7040);
  near(engine.evaluateProject(original).stats.volume,7360);
  assert.equal(original.objects[1].params.width,4);
});

test('multiple solids and holes join as unions of positives and cutters',()=>{
  const a=box(),b=box({}, {position:[15,0,10]});
  const h1=box({width:4,depth:30,height:30},{position:[0,0,10]},{role:'hole'});
  const h2=box({width:4,depth:30,height:30},{position:[15,0,10]},{role:'hole'});
  const before=engine.evaluateProject(doc(a,b,h1,h2));
  const joined=combineSelection('union',[h2,b,h1,a]);
  assert.equal(joined.operation,'difference');
  assert.equal(joined.children[0].operation,'union');
  assert.equal(joined.children[1].operation,'union');
  near(engine.evaluateProject(validateProject(doc(joined))).stats.volume,before.stats.volume);
});

test('joining only holes stays a negative cutter, including when used with unselected solids',()=>{
  const a=box({width:4,depth:30,height:30},{position:[-4,0,10]},{role:'hole'});
  const b=box({width:4,depth:30,height:30},{position:[4,0,10]},{role:'hole'});
  const base=box(),before=engine.evaluateProject(doc(base,a,b));
  const joined=combineSelection('union',[a,b]);
  assert.equal(joined.role,'hole');
  const after=engine.evaluateProject(validateProject(doc(base,joined)));
  near(after.stats.volume,before.stats.volume);
  assert.equal(engine.evaluateProject(doc(joined)).result,null);
});

test('explicit subtraction uses selection order and rejects a negative root base',()=>{
  const big=box(),small=box({width:10,depth:20,height:20});
  near(engine.evaluateProject(doc(combineSelection('difference',[big,small]))).stats.volume,4000);
  assert.equal(engine.evaluateProject(doc(combineSelection('difference',[small,big]))).result,null);
  const hole=box({},{},{role:'hole'});
  assert.throws(()=>combineSelection('difference',[hole,big]),/solid first/);
  assert.throws(()=>combineSelection('intersection',[big,hole]),/requires solid/);
  assert.throws(()=>combineSelection('union',[big]),/two or more/);
});

test('inside a Boolean edit context the explicit operation ignores stored child roles',()=>{
  const a=box(),b=box({}, {position:[10,0,10]}, {role:'hole'});
  const result=combineSelection('union',[a,b],{respectRoles:false});
  assert.equal(result.operation,'union');
  near(engine.evaluateProject(doc(result)).stats.volume,12000);
});

test('STL import can be cut and exported again, with undo preserving the imported mesh',async()=>{
  const source=makeBoolean('difference',[box({width:30,depth:24,height:16}),box({width:8,depth:8,height:24},{position:[0,0,8]})]);
  const original=engine.evaluateProject(doc(source));
  const imported=await engine.readSTL(meshToSTL(original.result));
  const mesh=makeNode('mesh',{params:{positions:Array.from(imported.positions),indices:Array.from(imported.indices)},transform:{position:[0,0,0]}});
  const project=validateProject(doc(mesh)),history=new History();
  near(engine.evaluateProject(project).stats.volume,original.stats.volume);
  history.push(project);
  const changed=clone(project);
  changed.objects.push(box({width:6,depth:30,height:24},{position:[10,0,8]},{role:'hole'}));
  const cut=engine.evaluateProject(validateProject(changed));
  assert.ok(cut.stats.volume<original.stats.volume);
  const final=await engine.readSTL(meshToSTL(cut.result));near(final.volume,cut.stats.volume);
  const restored=history.undo(changed);
  near(engine.evaluateProject(restored).stats.volume,original.stats.volume);
  assert.equal(restored.objects[0].type,'mesh');
});

test('export re-evaluates edited geometry and cannot silently reuse an earlier successful solid',()=>{
  const project=doc(box()),before=engine.evaluateProject(project);
  assert.ok(meshToSTL(before.result).byteLength>84);
  project.objects[0].params.height=NaN;
  assert.throws(()=>meshToSTL(engine.evaluateProject(project).result),/finite number/);
  project.objects=[box({},{},{role:'hole'})];
  assert.throws(()=>meshToSTL(engine.evaluateProject(project).result),/no solid material/);
});
