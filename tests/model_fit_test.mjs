import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Vector3,Matrix4} from '../static/vendor/three.module.js';
import {makeNode,makeBoolean,blankProject,identity,clone,transformMatrix,collectFitTargets,fitNodeToTarget,applyFittedNode,cutBelowBuildPlane,propagateClipPlanes,validateProject} from '../static/model.js';

function near(a,b,tolerance=1e-7){assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);}
function nearVector(a,b,tolerance=1e-7){a.forEach((v,i)=>near(v,b[i],tolerance));}
function bounds(node){const p=node.params;return {min:[-p.width/2,-p.depth/2,-p.height/2],max:[p.width/2,p.depth/2,p.height/2]};}
function world(point,transform){return new Vector3(...point).applyMatrix4(transformMatrix(transform)).toArray();}
function signed(plane,point){return new Vector3(...plane.normal).normalize().dot(new Vector3(...point))-plane.offset;}
function project(...objects){return {...blankProject(),objects};}

test('target discovery recognises saved holes, nested cutters and tube bores without treating a cutter bore as an opening',()=>{
  const source=makeNode('box'),hole=makeNode('cylinder',{role:'hole',visible:false});
  const tube=makeNode('tube',{params:{width:32,depth:24,height:40,wall:3}});
  const donutCut=makeNode('tube',{role:'solid'}),body=makeBoolean('difference',[makeNode('box'),donutCut]);
  const targets=collectFitTargets([source,hole,tube,body],{excludeIds:[source.id]});
  assert.deepEqual(targets.map(t=>t.kind),['hole','bore','cutout']);
  assert.equal(targets[0].hidden,true);
  assert.equal(targets[1].ownerId,tube.id);
  assert.deepEqual(targets[1].node.params,{width:26,depth:18,height:40});
  assert.equal(targets[2].ownerId,body.id);
  targets.forEach(t=>assert.deepEqual(t.node.transform,identity()));
  assert.equal(hole.visible,false,'discovery must not mutate the project');
  assert.equal(collectFitTargets([body],{excludeIds:[body.id]}).length,0);
  const ancestorHole=makeBoolean('difference',[makeNode('box'),source]);ancestorHole.role='hole';
  assert.equal(collectFitTargets([ancestorHole],{excludeIds:[source.id]}).length,0,'a candidate cannot contain the selected source');
});

test('target discovery honours the currently edited operation rather than ignored child material roles',()=>{
  const base=makeNode('box',{role:'hole'}),cut=makeNode('cylinder',{role:'solid'});
  const local=collectFitTargets([base,cut],{combineOperation:'difference'});
  assert.equal(local.length,1);assert.equal(local[0].sourceId,cut.id);assert.equal(local[0].kind,'cutout');
  assert.equal(collectFitTargets([base,cut],{combineOperation:'union'}).length,0);
});

test('nested opening fit uses physical dimensions and orientation after parent scaling and rotation',()=>{
  const source=makeNode('box',{params:{width:10,depth:8,height:6},transform:{position:[100,20,3],scale:[1,2,1]}});
  const cut=makeNode('box',{params:{width:30,depth:20,height:16},transform:{position:[4,7,11],rotation:[0,0,25]}});
  const body=makeBoolean('difference',[makeNode('box'),cut]);body.transform={position:[21,-14,9],rotation:[10,15,40],scale:[2,2,2]};
  const target=collectFitTargets([body])[0],original=clone(source);
  const fitted=fitNodeToTarget(source,bounds(source),target,bounds(cut),{clearance:.3,axes:'xyz'});
  nearVector(fitted.dimensions,[59.4,39.4,31.4]);
  const targetMatrix=new Matrix4().fromArray(target.matrix),fitMatrix=transformMatrix(fitted.transform);
  nearVector(world([0,0,0],fitted.transform),new Vector3(0,0,0).applyMatrix4(targetMatrix).toArray());
  for(let axis=0;axis<3;axis++){
    const a=new Vector3().setFromMatrixColumn(targetMatrix,axis).normalize();
    const b=new Vector3().setFromMatrixColumn(fitMatrix,axis).normalize();
    near(a.dot(b),1);
  }
  assert.deepEqual(source,original);assert.equal(fitted.node.id,source.id);assert.deepEqual(fitted.node.params,source.params);
});

test('XY sizing keeps height while uniform sizing preserves the selected profile proportions',()=>{
  const source=makeNode('box',{params:{width:10,depth:20,height:7},transform:{scale:[2,1,3]}});
  const hole=makeNode('box',{role:'hole',params:{width:40,depth:70,height:50}}),target=collectFitTargets([hole])[0];
  const stretch=fitNodeToTarget(source,bounds(source),target,bounds(hole),{clearance:.5,axes:'xy'});
  nearVector(stretch.dimensions,[39,69,21]);
  const uniform=fitNodeToTarget(source,bounds(source),target,bounds(hole),{clearance:.5,axes:'xy',mode:'uniform'});
  nearVector(uniform.dimensions,[39,39,21]);
  assert.throws(()=>fitNodeToTarget(source,bounds(source),target,bounds(hole),{clearance:20}),/too large/);
  assert.throws(()=>fitNodeToTarget(source,bounds(source),target,bounds(hole),{clearance:-.1}),/Clearance/);
});

test('fitting a rectangle in a round hole keeps its corners inside the clearance ellipse',()=>{
  const box=makeNode('box',{params:{width:20,depth:30,height:8}}),hole=makeNode('cylinder',{role:'hole',params:{width:40,depth:60,height:30}});
  const target=collectFitTargets([hole])[0],fit=fitNodeToTarget(box,bounds(box),target,bounds(hole),{clearance:.2});
  const [w,d]=fit.dimensions;near((w/39.6)**2+(d/59.6)**2,1);
  assert.match(fit.profileWarning,/rectangular outline/);
  const cylinder=makeNode('cylinder',{params:{width:20,depth:30,height:8}});
  const roundFit=fitNodeToTarget(cylinder,bounds(cylinder),target,bounds(hole),{clearance:.2});
  nearVector(roundFit.dimensions,[39.6,59.6,8]);
  assert.equal(roundFit.profileWarning,'');
});

test('fitting keeps mirrored source geometry and centres non-origin meshes on the target geometry',()=>{
  const source=makeNode('box',{transform:{scale:[-2,1,1]}}),hole=makeNode('box',{role:'hole',transform:{position:[20,30,40],rotation:[20,-30,40],scale:[-2,3,4]}});
  const target=collectFitTargets([hole])[0],sourceBounds={min:[1,2,3],max:[11,22,33]},targetBounds={min:[-10,0,2],max:[10,20,22]};
  const result=fitNodeToTarget(source,sourceBounds,target,targetBounds,{axes:'xyz',clearance:0});
  nearVector(world([6,12,18],result.transform),world([0,10,12],hole.transform));
  nearVector(result.dimensions,[40,60,80]);
  assert.ok(transformMatrix(result.transform).determinant()>0,'two mirrors retain their combined parity');
  assert.equal(source.transform.scale[0],-2);
});

test('fit rejects non-uniform parent scale combined with a child rotation that produces shear',()=>{
  const cut=makeNode('box',{transform:{rotation:[0,0,45]}}),body=makeBoolean('difference',[makeNode('box'),cut]);
  body.transform.scale=[2,1,1];
  const target=collectFitTargets([body])[0],source=makeNode('box');
  assert.throws(()=>fitNodeToTarget(source,bounds(source),target,bounds(cut)),/sheared/);
});

test('target local geometry inherits parent clipping planes with normalized-distance semantics',()=>{
  const cut=makeNode('box',{transform:{position:[0,0,1],scale:[1,1,2]}}),body=makeBoolean('difference',[makeNode('box'),cut]);
  body.clipPlanes=[{normal:[0,0,3],offset:2}];
  const target=collectFitTargets([body])[0];
  assert.deepEqual(target.node.clipPlanes,[{normal:[0,0,1],offset:.5}]);
  assert.equal(cut.clipPlanes,undefined);
});

test('build-plane cutting preserves the exact world halfspace under rotation, translation and mirrored nonuniform scale',()=>{
  const cases=[identity(),{position:[13,-20,7],rotation:[20,-35,13],scale:[-2,3,.5]},{position:[1,2,-4],rotation:[90,0,60],scale:[1,2,-3]}];
  for(const transform of cases){
    const source=makeNode('box',{visible:false,locked:true,transform}),snapshot=clone(source);
    const cut=cutBelowBuildPlane([source])[0],plane=cut.clipPlanes[0];
    for(const point of [[1,2,3],[-5,7,11],[0,0,0],[5,-4,-10]]){
      const z=world(point,transform)[2],distance=signed(plane,point);
      assert.ok(z*distance>=-1e-8,'the retained side matches world Z >= 0');
      if(Math.abs(z)>1e-8)assert.equal(Math.sign(distance),Math.sign(z));
    }
    assert.deepEqual(source,snapshot);assert.equal(cut.visible,false);assert.equal(cut.locked,true);
    assert.equal(cutBelowBuildPlane([cut])[0].clipPlanes.length,1,'repeating the same plane is idempotent');
    validateProject(project(cut));
  }
});

test('ungroup propagation keeps clipping planes in the correct child coordinates',()=>{
  const child=makeNode('box',{transform:{position:[1,2,3],rotation:[20,30,40],scale:[2,1,-3]}}),parent=makeBoolean('union',[child]);
  parent.clipPlanes=[{normal:[0,0,2],offset:1},{normal:[1,-2,1],offset:-4}];
  child.clipPlanes=[{normal:[1,0,0],offset:-5}];
  const propagated=propagateClipPlanes(parent,child);
  assert.equal(propagated.clipPlanes.length,3);
  for(let i=0;i<parent.clipPlanes.length;i++)for(const p of [[1,2,3],[-5,7,11],[0,0,0],[5,-4,-10]]){
    const before=signed(parent.clipPlanes[i],world(p,child.transform)),after=signed(propagated.clipPlanes[i+1],p);
    if(Math.abs(before)>1e-8)assert.equal(Math.sign(before),Math.sign(after));
  }
  assert.equal(child.clipPlanes.length,1,'ungroup preparation does not mutate its sources');
});

test('capsule curvature and clipping-plane validation reject malformed feature data',()=>{
  const old=makeNode('capsule');delete old.params.topRoundness;delete old.params.bottomRoundness;
  validateProject(project(old));
  for(const params of [{topRoundness:-.1},{bottomRoundness:2.1},{topRoundness:null},{bottomRoundness:'1'}])assert.throws(()=>validateProject(project(makeNode('capsule',{params}))),/end curvature/);
  for(const clipPlanes of [null,Array.from({length:33},()=>({normal:[0,0,1],offset:0})),[{normal:[0,0,0],offset:0}],[{normal:[0,1,0],offset:Infinity}],[{normal:[0,1],offset:0}]])assert.throws(()=>validateProject(project(makeNode('box',{clipPlanes}))),/cutting plane|Cutting plane/);
});

test('centred placement scopes a loose hole while preserving all source objects, hidden hosts and locks',()=>{
  const source=makeNode('cylinder',{name:'Insert',params:{width:3,depth:3,height:8},transform:{position:[50,20,4]}});
  const host=makeNode('box',{name:'Body',locked:true}),hiddenHost=makeNode('box',{visible:false,transform:{position:[0,0,50]}});
  const hole=makeNode('cylinder',{name:'Bore',role:'hole',params:{width:10,depth:10,height:40}}),otherHole=makeNode('box',{role:'hole'});
  const objects=[source,host,otherHole,hole,hiddenHost],before=clone(objects);
  const target=collectFitTargets(objects,{excludeIds:[source.id]}).find(t=>t.sourceId===hole.id);
  const fitted=fitNodeToTarget(source,bounds(source),target,bounds(hole),{clearance:0,axes:'xyz'});
  const placement=applyFittedNode(objects,source.id,target,fitted);
  assert.equal(placement.placement,'centred');assert.equal(placement.holeAction,'scoped');
  assert.equal(placement.selectedId,source.id);
  assert.deepEqual(objects,before,'placement is a pure proposal and does not alter its inputs');
  const moved=placement.objects.find(n=>n.id===source.id),group=placement.objects.find(n=>n.type==='boolean');
  assert.deepEqual(moved.params,source.params);nearVector(moved.transform.position,hole.transform.position);
  assert.equal(group.operation,'difference');assert.equal(group.locked,true);
  assert.equal(group.children[0].operation,'union');
  assert.deepEqual(group.children[0].children,[host,hiddenHost]);assert.deepEqual(group.children[1],hole);
  assert.deepEqual(placement.objects.find(n=>n.id===otherHole.id),otherHole);
  validateProject(project(...placement.objects));
});

test('separate placement retains source position and leaves every cutter and host untouched',()=>{
  const source=makeNode('box',{transform:{position:[-50,9,8]}}),host=makeNode('box'),hole=makeNode('box',{role:'hole',transform:{position:[8,4,2],rotation:[0,0,30]}});
  const objects=[source,host,hole],target=collectFitTargets(objects,{excludeIds:[source.id]})[0];
  const fitted=fitNodeToTarget(source,bounds(source),target,bounds(hole),{clearance:.2});
  const placement=applyFittedNode(objects,source.id,target,fitted,{placeInside:false});
  assert.equal(placement.holeAction,'none');assert.equal(placement.placement,'separate');
  assert.deepEqual(placement.objects[0].transform.position,source.transform.position);
  assert.deepEqual(placement.objects[0].transform.rotation,fitted.transform.rotation);
  assert.deepEqual(placement.objects.slice(1),[host,hole]);
});

test('an unhosted hole is retained as a hidden reference when centring a positive part',()=>{
  const source=makeNode('box'),hole=makeNode('box',{role:'hole',transform:{position:[20,30,15]}}),objects=[source,hole];
  const target=collectFitTargets(objects,{excludeIds:[source.id]})[0],fitted=fitNodeToTarget(source,bounds(source),target,bounds(hole),{clearance:0});
  const placement=applyFittedNode(objects,source.id,target,fitted);
  assert.equal(placement.holeAction,'hidden');assert.equal(placement.objects[1].visible,false);
  assert.deepEqual({...placement.objects[1],visible:true},hole);assert.equal(hole.visible,true);
  hole.locked=true;
  assert.throws(()=>applyFittedNode(objects,source.id,target,fitted),/Unlock this Hole/);
  hole.visible=false;
  assert.equal(applyFittedNode(objects,source.id,target,fitted).holeAction,'none','an already hidden locked reference remains unchanged');
});

test('centred placement rejects destructive edit contexts and respects project complexity limits',()=>{
  const source=makeNode('box'),hole=makeNode('box',{role:'hole'}),target=collectFitTargets([source,hole],{excludeIds:[source.id]})[0];
  const fitted=fitNodeToTarget(source,bounds(source),target,bounds(hole));
  for(const combineOperation of ['difference','intersection'])assert.throws(()=>applyFittedNode([source,hole],source.id,target,fitted,{combineOperation}),/whole design/);
  const lots=[source,hole,...Array.from({length:254},()=>makeNode('box'))];
  assert.throws(()=>applyFittedNode(lots,source.id,target,fitted),/256-object limit/);
  assert.equal(lots.length,256);assert.equal(hole.visible,true);
  assert.throws(()=>applyFittedNode([source],source.id,target,fitted),/no longer available/);
});
