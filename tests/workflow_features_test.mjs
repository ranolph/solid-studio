import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blankProject,makeNode,makeBoolean,validateProject,clone,identity,collectFitTargets,fitNodeToTarget,applyFittedNode,cutBelowBuildPlane,History} from '../static/model.js';
import {createEngine,meshToSTL} from '../static/geometry.js';

const engine=await createEngine();
const document=(...objects)=>({...blankProject(),objects});
const near=(actual,expected,tolerance=1e-4)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);

test('an asymmetric capsule can be cut at the build plane, saved, printed and undone with its curves intact',async()=>{
  const capsule=makeNode('capsule',{
    params:{width:20,depth:16,height:40,topRoundness:.35,bottomRoundness:1.6},
    transform:{position:[0,0,4]},
  });
  const original=validateProject(document(capsule)),history=new History();
  const before=engine.evaluateProject(original,{quality:'fine'});
  near(before.stats.bounds.min[2],-16);
  history.push(original);
  const cut=clone(original);
  cut.objects=cutBelowBuildPlane(cut.objects);
  const saved=validateProject(JSON.parse(JSON.stringify(cut)));
  const after=engine.evaluateProject(saved,{quality:'fine'});
  assert.deepEqual(after.stats.bounds,{min:[-10,-8,0],max:[10,8,24]});
  assert.equal(after.stats.components,1);
  assert.ok(after.stats.volume<before.stats.volume);
  const analyticalVolume=Math.PI*10*8*(24-2.8/3);
  near(after.stats.volume,analyticalVolume,analyticalVolume*.002);
  const printed=await engine.readSTL(meshToSTL(after.result));
  assert.deepEqual(printed.bounds,after.stats.bounds);
  near(printed.volume,after.stats.volume,.01);
  const undone=history.undo(saved);
  assert.deepEqual(undone.objects[0].params,capsule.params);
  assert.equal(undone.objects[0].clipPlanes,undefined);
  near(engine.evaluateProject(undone,{quality:'fine'}).stats.volume,before.stats.volume);
  const redone=history.redo(undone);
  near(engine.evaluateProject(redone,{quality:'fine'}).stats.volume,after.stats.volume);
});

test('fitting into a rotated nested plane-cut cavity keeps physical clearance, editable sources and undo history',async()=>{
  const base=makeNode('box',{params:{width:40,depth:30,height:24},transform:identity()});
  const cutter=makeNode('box',{name:'Insert opening',params:{width:20,depth:12,height:18},transform:identity()});
  const cavity=makeBoolean('difference',[base,cutter]);
  cavity.transform={position:[9,-4,3],rotation:[0,0,13],scale:[1,1,1]};
  cavity.clipPlanes=[{normal:[0,0,1],offset:0}];
  const host=makeBoolean('union',[cavity]);
  host.transform={position:[40,-10,25],rotation:[18,-24,37],scale:[1.5,1.5,1.5]};
  const insert=makeNode('box',{name:'Insert',params:{width:10,depth:8,height:10},transform:{position:[-60,0,5]}});
  const original=validateProject(document(host,insert)),history=new History();
  const target=collectFitTargets(original.objects,{excludeIds:[insert.id]}).find(candidate=>candidate.sourceId===cutter.id);
  assert.equal(target.kind,'cutout');
  assert.equal(target.node.clipPlanes.length,1,'the containing group cut constrains the available opening');
  const localSource=clone(insert);localSource.transform=identity();
  const sourceMesh=engine.evaluateNode(localSource,'fine'),targetMesh=engine.evaluateNode(target.node,'fine');
  const fitted=fitNodeToTarget(insert,sourceMesh.bounds,target,targetMesh.bounds,{clearance:.2,axes:'xyz',mode:'stretch'});
  fitted.dimensions.forEach((size,axis)=>near(size,[29.6,17.6,13.1][axis]));
  assert.equal(fitted.node.role,'solid');
  assert.equal(fitted.targetNode.role,'solid');
  assert.deepEqual(fitted.node.params,insert.params,'fit changes transform without baking away shape parameters');
  const outside=engine.evaluateNode(makeBoolean('difference',[fitted.node,fitted.targetNode]),'fine');
  assert.equal(outside,null,'the complete fitted part lies within the clipped opening');
  const contact=engine.evaluateNode(makeBoolean('intersection',[clone(host),clone(fitted.node)]),'fine');
  assert.equal(contact,null,'clearance keeps the insert separate from the host material');
  history.push(original);
  const changed=clone(original);changed.objects[1]=fitted.node;
  const result=engine.evaluateProject(validateProject(changed),{quality:'fine'});
  const hostVolume=engine.evaluateNode(host,'fine').volume;
  const insertMesh=engine.evaluateNode(fitted.node,'fine');
  near(result.stats.volume,hostVolume+insertMesh.volume,.02);
  const printableInsert=await engine.readSTL(meshToSTL(insertMesh));
  near(printableInsert.volume,29.6*17.6*13.1,.05);
  const restored=history.undo(changed);
  assert.deepEqual(restored,original);
  assert.deepEqual(restored.objects[1].transform.position,[-60,0,5]);
  assert.deepEqual(restored.objects[1].transform.scale,[1,1,1]);
});

test('a rectangular insert fitted to a tube bore has no protruding corners after STL export',async()=>{
  const tube=makeNode('tube',{params:{width:32,depth:24,height:30,wall:3},transform:{position:[15,7,15],rotation:[0,0,27]}});
  const insert=makeNode('box',{params:{width:12,depth:6,height:9},transform:{position:[-40,0,4.5]}});
  const target=collectFitTargets([tube,insert],{excludeIds:[insert.id]}).find(candidate=>candidate.kind==='bore');
  const localSource=clone(insert);localSource.transform=identity();
  const fitted=fitNodeToTarget(insert,engine.evaluateNode(localSource).bounds,target,engine.evaluateNode(target.node).bounds,{clearance:.2,axes:'xy',mode:'stretch'});
  near(fitted.dimensions[0],25.6/Math.SQRT2);
  near(fitted.dimensions[1],17.6/Math.SQRT2);
  near(fitted.dimensions[2],9);
  assert.match(fitted.profileWarning,/rectangular outline/);
  assert.equal(engine.evaluateNode(makeBoolean('difference',[fitted.node,fitted.targetNode]),'fine'),null);
  assert.equal(engine.evaluateNode(makeBoolean('intersection',[tube,clone(fitted.node)]),'fine'),null);
  const printed=await engine.readSTL(meshToSTL(engine.evaluateNode(fitted.node,'fine')));
  near(printed.volume,(25.6/Math.SQRT2)*(17.6/Math.SQRT2)*9,.02);
});

test('editing a capsule inside a plane-cut Boolean keeps the group floor sealed on export',async()=>{
  const body=makeNode('capsule',{
    params:{width:24,depth:20,height:44,topRoundness:1.6,bottomRoundness:.5},
    transform:{position:[0,0,10]},
  });
  const cutter=makeNode('cylinder',{
    params:{width:6,depth:6,height:60},transform:{position:[0,0,12]},
  });
  const group=makeBoolean('difference',[body,cutter]);
  group.clipPlanes=[{normal:[0,0,1],offset:0}];
  const project=validateProject(document(group));
  const original=engine.evaluateProject(project,{quality:'fine'});
  assert.equal(original.stats.components,1);
  near(original.stats.bounds.min[2],0);
  group.children[0].params.topRoundness=.3;
  group.children[1].params.width=8;
  const changed=engine.evaluateProject(validateProject(project),{quality:'fine'});
  assert.equal(changed.stats.components,1);
  near(changed.stats.bounds.min[2],0);
  assert.notEqual(changed.stats.volume,original.stats.volume);
  const printed=await engine.readSTL(meshToSTL(changed.result));
  near(printed.bounds.min[2],0);
  near(printed.volume,changed.stats.volume,.01);
  assert.equal(project.objects[0].children[0].params.height,44,'plane cut retains editable source dimensions');
});

test('centred zero-clearance fill survives a loose Hole and exports the fully filled body',async()=>{
  const body=makeNode('box',{name:'Body',params:{width:30,depth:24,height:20},transform:{position:[10,-4,10]}});
  const hole=makeNode('cylinder',{name:'Opening',role:'hole',params:{width:10,depth:10,height:20},transform:{position:[10,-4,10]}});
  const source=makeNode('cylinder',{name:'Filler',params:{width:3,depth:3,height:5},transform:{position:[60,0,2.5]}});
  const original=validateProject(document(body,hole,source)),history=new History();
  const cutVolume=engine.evaluateProject(document(body,hole),{quality:'fine'}).stats.volume;
  const target=collectFitTargets(original.objects,{excludeIds:[source.id]})[0],localSource=clone(source);localSource.transform=identity();
  const fitted=fitNodeToTarget(source,engine.evaluateNode(localSource,'fine').bounds,target,engine.evaluateNode(target.node,'fine').bounds,{axes:'xyz',clearance:0});
  const proposed=applyFittedNode(original.objects,source.id,target,fitted),changed=document(...proposed.objects);
  assert.deepEqual(proposed.objects.find(n=>n.id===source.id).transform.position,[10,-4,10]);
  assert.equal(proposed.holeAction,'scoped');
  const cutBody=proposed.objects.find(n=>n.type==='boolean');
  near(engine.evaluateNode(cutBody,'fine').volume,cutVolume);
  history.push(original);
  const result=engine.evaluateProject(validateProject(changed),{quality:'fine'});
  near(result.stats.volume,30*24*20,.01);
  assert.equal(result.stats.components,1,'the centred zero-clearance insert fills the hole instead of being subtracted');
  assert.deepEqual(result.stats.bounds,{min:[-5,-16,0],max:[25,8,20]});
  const printed=await engine.readSTL(meshToSTL(result.result));
  near(printed.volume,30*24*20,.01);
  assert.deepEqual(history.undo(changed),original,'one Undo restores the separate source and original loose Hole');
});

test('centred fitting preserves multiple host bodies and other global negative solids',()=>{
  const a=makeNode('box',{params:{width:20,depth:20,height:10},transform:{position:[0,0,5]}});
  const b=makeNode('box',{params:{width:20,depth:20,height:10},transform:{position:[0,0,15]}});
  const selectedHole=makeNode('cylinder',{role:'hole',params:{width:10,depth:10,height:20},transform:{position:[0,0,10]}});
  const otherHole=makeNode('cylinder',{role:'hole',params:{width:2,depth:2,height:20},transform:{position:[0,0,10]}});
  const source=makeNode('cylinder',{params:{width:4,depth:4,height:5},transform:{position:[50,0,2.5]}}),objects=[a,selectedHole,b,source,otherHole];
  const target=collectFitTargets(objects,{excludeIds:[source.id]}).find(t=>t.sourceId===selectedHole.id);
  const localSource=clone(source);localSource.transform=identity();
  const fitted=fitNodeToTarget(source,engine.evaluateNode(localSource,'fine').bounds,target,engine.evaluateNode(target.node,'fine').bounds,{axes:'xyz',clearance:0});
  const placement=applyFittedNode(objects,source.id,target,fitted);
  const result=engine.evaluateProject(document(...placement.objects),{quality:'fine'});
  const expected=engine.evaluateProject(document(a,b,otherHole),{quality:'fine'});
  near(result.stats.volume,expected.stats.volume,.01);
  assert.deepEqual(placement.objects.find(n=>n.id===otherHole.id),otherHole);
  const hosted=placement.objects.find(n=>n.type==='boolean');
  near(engine.evaluateNode(hosted,'fine').volume,engine.evaluateProject(document(a,b,selectedHole),{quality:'fine'}).stats.volume,.01);
});

test('a centred part with no host remains printable while the loose Hole is retained as reference',()=>{
  const source=makeNode('box',{params:{width:4,depth:5,height:6},transform:{position:[-40,0,3]}});
  const hole=makeNode('box',{role:'hole',params:{width:18,depth:12,height:10},transform:{position:[22,11,5],rotation:[0,0,35],scale:[-1,1,1]}});
  const objects=[source,hole],target=collectFitTargets(objects,{excludeIds:[source.id]})[0];
  const localSource=clone(source);localSource.transform=identity();
  const fitted=fitNodeToTarget(source,engine.evaluateNode(localSource).bounds,target,engine.evaluateNode(target.node).bounds,{axes:'xyz',clearance:0});
  const placement=applyFittedNode(objects,source.id,target,fitted),result=engine.evaluateProject(document(...placement.objects),{quality:'fine'});
  near(result.stats.volume,18*12*10,.01);assert.equal(result.stats.components,1);
  const fittedNode=placement.objects.find(n=>n.id===source.id);
  assert.deepEqual(fittedNode.params,source.params);
  assert.equal(engine.evaluateNode(makeBoolean('difference',[clone(fittedNode),fitted.targetNode]),'fine'),null);
  assert.equal(placement.objects.find(n=>n.id===hole.id).visible,false);
});
