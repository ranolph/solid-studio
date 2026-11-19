import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Vector3,Matrix3,Matrix4,Quaternion} from '../static/vendor/three.module.js';
import {makeNode,makeBoolean,blankProject,starterProject,clone,transformMatrix,matrixTransform,attachFaces,createArray,alignObjects,History,validateProject,nodeCount,PROJECT_LIMITS} from '../static/model.js';
import {createEngine,meshToSTL,GEOMETRY_LIMITS} from '../static/geometry.js';

const engine=await createEngine();
function near(a,b,tolerance=1e-7){assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);}
function nearVector(a,b,tolerance=1e-7){a.forEach((v,i)=>near(v,b[i],tolerance));}
function worldPoint(p,t){return new Vector3(...p).applyMatrix4(transformMatrix(t)).toArray();}
function worldNormal(n,t){return new Vector3(...n).applyNormalMatrix(new Matrix3().getNormalMatrix(transformMatrix(t))).toArray();}
function projectOf(...objects){return {...blankProject(),objects};}

test('attachment rotates a picked source normal opposite to target and keeps the anchor overlap exact',()=>{
  for(const scale of [[1,1,1],[1.5,.8,1.2],[-1.5,.8,1.2]]){
    const node=makeNode('box',{transform:{position:[12,20,30],rotation:[17,-26,48],scale}});
    const localPoint=[3,-2,15],localNormal=[0,0,1];
    const source={point:worldPoint(localPoint,node.transform),normal:worldNormal(localNormal,node.transform)};
    const target={point:[41,-19,15],normal:new Vector3(1,2,3).normalize().toArray()};
    const before=clone(node.transform),overlap=.23;
    const result=attachFaces(node,source,target,overlap);
    nearVector(worldNormal(localNormal,result),target.normal.map(x=>-x));
    nearVector(worldPoint(localPoint,result),target.point.map((x,i)=>x-target.normal[i]*overlap));
    assert.deepEqual(node.transform,before,'attachment is pure; caller owns undo/commit');
  }
});

test('face attachment handles parallel and antiparallel normals without singular transforms',()=>{
  const node=makeNode('box'),source={point:[0,0,30],normal:[0,0,1]};
  for(const normal of [[0,0,1],[0,0,-1]]){
    const result=attachFaces(node,source,{point:[3,4,5],normal},0);
    nearVector(worldPoint([0,0,15],result),[3,4,5]);
    nearVector(worldNormal([0,0,1],result),normal.map(x=>-x));
  }
  assert.throws(()=>attachFaces(node,source,{point:[1,2,3],normal:[0,0,0]}),/valid face/);
  assert.throws(()=>attachFaces(node,source,source,NaN),/overlap/);
});

test('transform decomposition roundtrips nonuniform and mirrored scale without shear',()=>{
  for(const scale of [[1,2,3],[-1,2,3],[1,-2,3]]){
    const t={position:[11,-7,9],rotation:[-20,41,135],scale};
    const matrix=transformMatrix(t);
    const restored=transformMatrix(matrixTransform(matrix));
    nearVector(restored.elements,matrix.elements);
  }
});

test('linear repeat spacing follows the selected world axis without moving the original',()=>{
  const original=makeNode('box',{name:'Spacer',transform:{position:[5,-2,9],rotation:[10,20,30]}}),snapshot=clone(original);
  const copies=createArray(original,{mode:'linear',count:4,axis:1,spacing:7});
  assert.equal(copies.length,3);
  assert.deepEqual(copies.map(n=>n.transform.position),[[5,5,9],[5,12,9],[5,19,9]]);
  copies.forEach(n=>assert.deepEqual(n.transform.rotation,[10,20,30]));
  assert.deepEqual(original,snapshot);
  assert.equal(new Set([original,...copies].map(n=>n.id)).size,4);
});

test('repeat gives nested boolean children new independent IDs and parameters',()=>{
  const original=makeBoolean('difference',[makeNode('box'),makeNode('cylinder')]);
  const copies=createArray(original,{count:3});
  const all=[original,...copies],ids=all.flatMap(n=>[n.id,...n.children.map(c=>c.id)]);
  assert.equal(new Set(ids).size,9);
  copies[0].children[0].params.width=100;
  assert.equal(original.children[0].params.width,30);
  assert.equal(copies[1].children[0].params.width,30);
});

test('full-circle radial repeat includes original once and rotates copies about world Z',()=>{
  const original=makeNode('box',{transform:{position:[50,0,5],rotation:[10,20,30]}});
  const copies=createArray(original,{mode:'radial',count:4,radius:50,arc:360,rotate:true});
  copies.forEach((n,i)=>nearVector(n.transform.position,[[0,50,5],[-50,0,5],[0,-50,5]][i]));
  const oldMatrix=transformMatrix({...original.transform,position:[0,0,0]});
  copies.forEach((n,i)=>{
    const rotated=new Matrix4().makeRotationZ((i+1)*Math.PI/2).multiply(oldMatrix);
    const actual=transformMatrix({...n.transform,position:[0,0,0]});
    nearVector(actual.elements,rotated.elements);
  });
});

test('partial radial arc reaches the endpoint and supports unrotated copies',()=>{
  const original=makeNode('box',{transform:{position:[50,0,5],rotation:[15,20,25]}});
  const copies=createArray(original,{mode:'radial',count:3,radius:50,arc:180,rotate:false});
  copies.forEach((n,i)=>nearVector(n.transform.position,[[0,50,5],[-50,0,5]][i]));
  copies.forEach(n=>assert.deepEqual(n.transform.rotation,original.transform.rotation));
  const shifted=createArray(original,{mode:'radial',count:3,radius:50,startAngle:90,arc:180,rotate:false});
  nearVector(shifted[0].transform.position,[0,-50,5]);
  nearVector(shifted[1].transform.position,[50,-100,5]);
});

test('repeat rejects invalid parameters and excessive nested-object count',()=>{
  assert.throws(()=>createArray(makeNode('box'),{count:NaN}),/Invalid repeat/);
  assert.throws(()=>createArray(makeNode('box'),{axis:9}),/Invalid repeat/);
  assert.throws(()=>createArray(makeNode('box'),{mode:'other'}),/Invalid repeat/);
  const group=makeBoolean('union',Array.from({length:5},()=>makeNode('box')));
  assert.throws(()=>createArray(group,{count:64}),/256-object limit/);
});

test('alignment anchors to first selected object, independent of document order',()=>{
  const a=makeNode('box',{transform:{position:[0,0,15]}}),b=makeNode('box',{transform:{position:[40,12,15]}}),locked=makeNode('box',{locked:true,transform:{position:[80,0,15]}});
  const bounds=new Map([
    [a.id,{min:[-15,-15,0],max:[15,15,30]}],
    [b.id,{min:[25,-3,0],max:[55,27,30]}],
    [locked.id,{min:[65,-15,0],max:[95,15,30]}],
  ]);
  alignObjects([a,b,locked],[b.id,a.id,locked.id],0,'center',id=>bounds.get(id));
  assert.equal(a.transform.position[0],40);
  assert.equal(b.transform.position[0],40);
  assert.equal(locked.transform.position[0],80);
  a.transform.position=[0,0,15];
  alignObjects([a,b],[b.id,a.id],1,'min',id=>bounds.get(id));
  assert.equal(a.transform.position[1],12);
});

test('history restores exact nested edits and branches clear redo',()=>{
  const history=new History(),first=starterProject('organiser');
  history.push(first);
  const second=clone(first);second.objects[1].children[0].params.height=70;
  history.push(second);
  const third=clone(second);third.name='A different name';
  const restoredSecond=history.undo(third);assert.deepEqual(restoredSecond,second);
  const restoredFirst=history.undo(restoredSecond);assert.deepEqual(restoredFirst,first);
  assert.deepEqual(history.redo(restoredFirst),second);
  assert.deepEqual(history.redo(second),third);
  assert.equal(history.redo(third),null);
  const branchStart=history.undo(third);history.push(branchStart);
  assert.equal(history.future.length,0);
  assert.equal(history.redo(branchStart),null);
  first.objects[0].params.width=999;
  assert.notEqual(history.undo(branchStart).objects[0].params.width,999,'saved snapshots are independent of mutation');
});

test('history respects retained-entry and memory limits without losing latest undo',()=>{
  const history=new History(3,400);
  for(let i=0;i<8;i++)history.push({index:i,text:'x'.repeat(60)});
  assert.ok(history.past.length<=3);
  assert.ok(history.past.reduce((total,s)=>total+s.length*2,0)<=400);
  assert.equal(history.undo({index:8}).index,7);
  history.clear();assert.equal(history.undo({}),null);assert.equal(history.redo({}),null);
});

test('project validation matches geometry complexity limits and accepts every starter',()=>{
  for(const key of ['nodes','depth','inputTriangles','dimension','coordinate'])assert.equal(PROJECT_LIMITS[key],GEOMETRY_LIMITS[key]);
  for(const key of ['blank','organiser','bracket','enclosure','stand'])assert.equal(validateProject(starterProject(key)).format,'solid-studio');
  const all=projectOf(...Array.from({length:256},()=>makeNode('box')));
  assert.equal(nodeCount(validateProject(all).objects),256);
  all.objects.push(makeNode('box'));
  assert.throws(()=>validateProject(all),/256-object limit/);
});

test('pathological depth and cycles fail validation before recursive stack overflow',()=>{
  const deep=blankProject();let node=makeNode('box');
  for(let i=0;i<10000;i++)node=makeBoolean('union',[node]);
  deep.objects=[node];
  assert.throws(()=>validateProject(deep),error=>!(error instanceof RangeError)&&/nested too deeply/.test(error.message));
  const cycle=makeBoolean('union',[makeNode('box')]);cycle.children=[cycle];
  assert.throws(()=>validateProject(projectOf(cycle)),/duplicate objects/);
  assert.throws(()=>nodeCount([cycle]),/circular/);
  const primitive=makeNode('box');primitive.children=[primitive];
  assert.throws(()=>validateProject(projectOf(primitive)),/Only combined solids/);
});

test('malicious primitive parameters and transforms fail early with useful errors',()=>{
  const cases=[
    ['box',{width:Infinity},/Object width/],['box',{width:'20'},/Object width/],
    ['box',{height:0},/Object height/],['roundedBox',{radius:NaN},/Corner radius/],
    ['tube',{wall:20},/Wall thickness/],['polygon',{sides:5.5},/whole number/],
    ['cone',{topRatio:2},/Top radius/],['torus',{tubeRatio:.7},/Ring thickness/],
    ['gear',{teeth:2},/Number of teeth/],
  ];
  for(const [type,params,error] of cases)assert.throws(()=>validateProject(projectOf(makeNode(type,{params}))),error);
  assert.throws(()=>validateProject(projectOf(makeNode('box',{transform:{scale:[1,0,1]}}))),/scale cannot be zero/);
  assert.throws(()=>validateProject(projectOf(makeNode('box',{transform:{scale:[1,1001,1]}}))),/supported range/);
  const bad=blankProject();bad.settings.gridSnap=1e-20;assert.throws(()=>validateProject(bad),/gridSnap/);
  const missingId=makeNode('box');missingId.id='';assert.throws(()=>validateProject(projectOf(missingId)),/invalid or duplicate/);
});

test('imported mesh project validation catches malformed buffers before the worker',()=>{
  const packet=engine.evaluateNode(makeNode('box'));
  const node=makeNode('mesh',{params:{positions:Array.from(packet.positions),indices:Array.from(packet.indices)}});
  assert.equal(validateProject(projectOf(node)).objects[0].type,'mesh');
  const invalid=clone(node);invalid.params.indices[0]=999999;
  assert.throws(()=>validateProject(projectOf(invalid)),/invalid vertex index/);
  invalid.params.indices[0]=0;invalid.params.positions[0]=NaN;
  assert.throws(()=>validateProject(projectOf(invalid)),/Mesh coordinate/);
  invalid.params.positions=[];assert.throws(()=>validateProject(projectOf(invalid)),/incomplete/);
  const unsupported=clone(node);unsupported.type='arbitrary';assert.throws(()=>validateProject(projectOf(unsupported)),/invalid or duplicate/);
});

function closedMesh(packet){
  const edges=new Map();let volume=0;
  for(let t=0;t<packet.indices.length;t+=3){
    const ids=Array.from(packet.indices.subarray(t,t+3));
    for(let j=0;j<3;j++){
      const a=ids[j],b=ids[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`,edge=edges.get(key)||[0,0];
      edge[0]++;edge[1]+=a<b?1:-1;edges.set(key,edge);
    }
    const [a,b,c]=ids.map(i=>new Vector3(...packet.positions.subarray(i*3,i*3+3)));
    volume+=a.dot(b.cross(c))/6;
  }
  for(const state of edges.values())assert.deepEqual(state,[2,0],'closed and consistently oriented topological edges');
  assert.ok(volume>0);near(volume,packet.volume,Math.abs(volume)*2e-5);
}

for(const key of ['organiser','bracket','enclosure','stand'])test(`${key} starter exports one connected, watertight solid with nonzero printable volume`,async()=>{
  const project=validateProject(starterProject(key));
  const result=engine.evaluateProject(project,{quality:'fine'});
  assert.equal(result.stats.components,1);
  assert.ok(result.stats.volume>1000);
  assert.ok(result.stats.bounds.min[2]>=-1e-5);
  assert.deepEqual(result.warnings,[]);
  closedMesh(result.result);
  const stl=meshToSTL(result.result),parsed=await engine.readSTL(stl);
  closedMesh(parsed);
  near(parsed.volume,result.stats.volume,result.stats.volume*2e-5);
});
