import {Matrix4, Vector3, Quaternion, Euler, MathUtils} from './vendor/three.module.js';

export const COLORS=['#ee8765','#bb9be8','#75b8bd','#f2bb65','#dd83a3','#91b484','#779ddd','#c0b3a5'];
export const PROJECT_LIMITS=Object.freeze({nodes:256,depth:24,inputTriangles:250000,dimension:10000,coordinate:1000000});
export const SHAPES=[
  {type:'box',name:'Box',hint:'A simple rectangular solid',params:{width:30,depth:30,height:30},color:0},
  {type:'cylinder',name:'Cylinder',hint:'Round posts, holes and pegs',params:{width:28,depth:28,height:30},color:1},
  {type:'sphere',name:'Sphere',hint:'A ball or ellipsoid',params:{width:30,depth:30,height:30},color:2},
  {type:'roundedBox',name:'Soft box',hint:'A box with rounded edges',params:{width:40,depth:30,height:24,radius:3},color:3},
  {type:'cone',name:'Cone',hint:'A cone or tapered cylinder',params:{width:30,depth:30,height:35,topRatio:0},color:4},
  {type:'tube',name:'Tube',hint:'A hollow tube with a precise wall',params:{width:32,depth:32,height:30,wall:3},color:2},
  {type:'torus',name:'Ring',hint:'A smooth doughnut-shaped ring',params:{width:40,depth:40,height:12,tubeRatio:0.3},color:1},
  {type:'wedge',name:'Wedge',hint:'Ramps and angled supports',params:{width:35,depth:30,height:25},color:0},
  {type:'polygon',name:'Polygon',hint:'Hexagonal or custom-sided prism',params:{width:30,depth:30,height:24,sides:6},color:5},
  {type:'pyramid',name:'Pyramid',hint:'A square-based pyramid',params:{width:30,depth:30,height:30},color:3},
  {type:'capsule',name:'Capsule',hint:'A pill-shaped solid with independently curved ends',params:{width:20,depth:20,height:40,topRoundness:1,bottomRoundness:1},color:4},
  {type:'gear',name:'Gear',hint:'A decorative gear blank; not an involute gear',params:{width:40,depth:40,height:10,teeth:16},color:6}
];
export const clone=value=>structuredClone(value);
export function uid(){return globalThis.crypto?.randomUUID?.()||'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3)|8).toString(16);});}
export const identity=()=>({position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]});
export function makeNode(type,overrides={}){
  const shape=SHAPES.find(s=>s.type===type);
  const params={...(shape?.params||{}),...overrides.params};
  return {id:uid(),name:shape?.name||'Solid',type,role:'solid',visible:true,locked:false,color:COLORS[shape?.color||0],...overrides,params,transform:{...identity(),position:[0,0,(params.height||0)/2],...overrides.transform}};
}
export function blankProject(name='Untitled design'){
  return {format:'solid-studio',version:1,name,objects:[],settings:{gridSize:256,gridSnap:1,angleSnap:15,snapEnabled:true,showGrid:true}};
}
export function makeBoolean(operation,children,name){
  return {...makeNode('boolean',{name:name||({union:'Joined solid',difference:'Cut solid',intersection:'Intersection'}[operation]),color:children[0]?.color||COLORS[0],transform:identity()}),operation,children};
}
export function combineSelection(operation,nodes,{respectRoles=true}={}){
  if(!['union','difference','intersection'].includes(operation))throw Error('Choose Join, Subtract or Intersect.');
  if(!Array.isArray(nodes)||nodes.length<2)throw Error('Select two or more objects first.');
  const children=clone(nodes);
  if(!respectRoles)return makeBoolean(operation,children);
  const solids=children.filter(n=>n.role!=='hole'),holes=children.filter(n=>n.role==='hole');
  if(operation==='intersection'&&holes.length)throw Error('Intersect requires solid objects. Change holes to Solid or use Join to keep their cuts.');
  if(operation==='difference'&&children[0].role==='hole')throw Error('Select a solid first as the subtraction base, then select the cutting objects.');
  if(operation!=='union')return makeBoolean(operation,children);
  if(!solids.length){const group=makeBoolean('union',children,'Joined holes');group.role='hole';return group;}
  if(!holes.length)return makeBoolean('union',children);
  const positives=solids.length===1?solids[0]:makeBoolean('union',solids,'Joined solids');
  const negatives=holes.length===1?holes[0]:makeBoolean('union',holes,'Joined cutting shapes');
  return makeBoolean('difference',[positives,negatives],'Joined solid with holes');
}
export function starterProject(key='organiser'){
  const p=blankProject();
  if(key==='blank')return p;
  if(key==='organiser'){
    p.name='Desktop organiser';
    const base=makeNode('roundedBox',{name:'Rounded base',params:{width:106,depth:66,height:7,radius:3},color:COLORS[1]});
    const cup=makeBoolean('difference',[
      makeNode('cylinder',{name:'Cup outside',params:{width:34,depth:34,height:50},transform:{position:[-31,8,28]}}),
      makeNode('cylinder',{name:'Cup opening',params:{width:28,depth:28,height:55},transform:{position:[-31,8,33]}})
    ],'Pencil cup');
    const tray=makeBoolean('difference',[
      makeNode('roundedBox',{name:'Tray outside',params:{width:54,depth:48,height:21,radius:5},transform:{position:[19,0,14]}}),
      makeNode('roundedBox',{name:'Tray opening',params:{width:47,depth:41,height:26,radius:4},transform:{position:[19,0,21]}})
    ],'Little things tray');
    cup.color=COLORS[0];tray.color=COLORS[4];p.objects=[base,cup,tray];
  }else if(key==='bracket'){
    p.name='Mounting bracket';
    const bracket=makeBoolean('union',[
      makeNode('box',{name:'Foot',params:{width:50,depth:45,height:6}}),
      makeNode('box',{name:'Upright',params:{width:50,depth:6,height:45},transform:{position:[0,19.5,22.5]}})
    ],'Bracket body');
    p.objects=[bracket,...[-15,15].map((x,i)=>makeNode('cylinder',{name:`Mounting hole ${i+1}`,role:'hole',params:{width:5.5,depth:5.5,height:16},transform:{position:[x,-7,4]}}))];
  }else if(key==='enclosure'){
    p.name='Project enclosure';
    const shell=makeBoolean('difference',[
      makeNode('roundedBox',{name:'Outer shell',params:{width:80,depth:54,height:30,radius:4}}),
      makeNode('roundedBox',{name:'Inner cavity',params:{width:75,depth:49,height:33,radius:2},transform:{position:[0,0,19]}})
    ],'Enclosure shell');
    shell.color=COLORS[2];
    p.objects=[shell,makeNode('box',{name:'Cable opening',role:'hole',params:{width:12,depth:12,height:7},transform:{position:[0,-26,12]}})];
  }else if(key==='stand'){
    p.name='Phone stand';
    const body=makeBoolean('union',[
      makeNode('roundedBox',{name:'Foot',params:{width:70,depth:65,height:7,radius:3}}),
      makeNode('box',{name:'Back support',params:{width:60,depth:6,height:70},transform:{position:[0,10,35],rotation:[-16,0,0]}}),
      makeNode('roundedBox',{name:'Front lip',params:{width:60,depth:9,height:14,radius:2},transform:{position:[0,-16,9]}})
    ],'Stand body');
    p.objects=[body,makeNode('box',{name:'Charging cable slot',role:'hole',params:{width:14,depth:40,height:20},transform:{position:[0,-20,13]}})];
  }
  return p;
}
export function findNode(objects,id){for(const n of objects){if(n.id===id)return n;const nested=n.children&&findNode(n.children,id);if(nested)return nested;}return null;}
export function nodeCount(objects){
  const pending=[...objects],seen=new Set();let count=0;
  while(pending.length){const n=pending.pop();if(!n||typeof n!=='object'||seen.has(n))throw Error('Invalid or circular object tree.');seen.add(n);count++;if(n.children){if(!Array.isArray(n.children))throw Error('Invalid child objects.');for(const child of n.children)pending.push(child);}}
  return count;
}
export function freshClone(node){const n=clone(node);n.id=uid();if(n.children)n.children=n.children.map(freshClone);return n;}
export function transformMatrix(t){
  const q=new Quaternion().setFromEuler(new Euler(...t.rotation.map(MathUtils.degToRad),'ZYX'));
  return new Matrix4().compose(new Vector3(...t.position),q,new Vector3(...t.scale));
}
export function matrixTransform(m){
  const p=new Vector3(),q=new Quaternion(),s=new Vector3();m.decompose(p,q,s);
  const r=new Euler().setFromQuaternion(q,'ZYX');
  return {position:p.toArray(),rotation:[r.x,r.y,r.z].map(MathUtils.radToDeg),scale:s.toArray()};
}
export function attachFaces(node,source,target,overlap=0.1){
  for(const face of [source,target])if(!face||!Array.isArray(face.point)||!Array.isArray(face.normal)||face.point.length!==3||face.normal.length!==3||[...face.point,...face.normal].some(x=>!Number.isFinite(x))||Math.hypot(...face.normal)<1e-10)throw Error('Pick a valid face on each object.');
  if(!Number.isFinite(overlap)||overlap<0||overlap>100)throw Error('Face overlap must be between 0 and 100 mm.');
  const before=transformMatrix(node.transform),origin=new Vector3(...node.transform.position);
  const delta=new Quaternion().setFromUnitVectors(new Vector3(...source.normal).normalize(),new Vector3(...target.normal).normalize().negate());
  const qMatrix=new Matrix4().makeRotationFromQuaternion(delta);
  const rotatedPoint=new Vector3(...source.point).sub(origin).applyQuaternion(delta).add(origin);
  const destination=new Vector3(...target.point).addScaledVector(new Vector3(...target.normal).normalize(),-overlap);
  const move=destination.sub(rotatedPoint);
  const result=new Matrix4().makeTranslation(...move.toArray()).multiply(new Matrix4().makeTranslation(...origin.toArray())).multiply(qMatrix).multiply(new Matrix4().makeTranslation(...origin.clone().negate().toArray())).multiply(before);
  return matrixTransform(result);
}
export function worldBounds(packet){return packet?.bounds;}
export function dimensions(bounds){return bounds?bounds.max.map((v,i)=>v-bounds.min[i]):[0,0,0];}

// Fit uses the opening's own axes, not its larger world-axis bounding box.
// Matrix values are plain arrays so target descriptors can cross worker boundaries.
function exactMatrixTransform(matrix){
  const result=matrixTransform(matrix),restored=transformMatrix(result),indices=[0,1,2,4,5,6,8,9,10];
  const magnitude=Math.max(1,...indices.map(i=>Math.abs(matrix.elements[i])));
  if(result.scale.some(v=>!Number.isFinite(v)||Math.abs(v)<0.00001)||indices.some(i=>Math.abs(restored.elements[i]-matrix.elements[i])>magnitude*1e-7))throw Error('This opening is sheared by a rotated, non-uniformly scaled group. Fit inside that group or remove its non-uniform scale first.');
  return result;
}
function localPlane(plane,matrix){
  const normal=new Vector3(...plane.normal).normalize(),e=matrix.elements;
  const mapped=[normal.x*e[0]+normal.y*e[1]+normal.z*e[2],normal.x*e[4]+normal.y*e[5]+normal.z*e[6],normal.x*e[8]+normal.y*e[9]+normal.z*e[10]];
  const length=Math.hypot(...mapped);
  if(!Number.isFinite(length)||length<1e-12)throw Error('The object transform cannot define a valid cutting plane.');
  return {normal:mapped.map(x=>x/length),offset:(plane.offset-normal.dot(new Vector3(e[12],e[13],e[14])))/length};
}
export function cutBelowBuildPlane(objects){
  if(!Array.isArray(objects))throw Error('Choose a project to cut.');
  return objects.map(original=>{
    const plane=localPlane({normal:[0,0,1],offset:0},transformMatrix(original.transform));
    const same=(original.clipPlanes||[]).some(p=>Math.abs(p.offset-plane.offset)<1e-7&&new Vector3(...p.normal).normalize().distanceTo(new Vector3(...plane.normal))<1e-7);
    if(same)return clone(original);
    if((original.clipPlanes?.length||0)>=32)throw Error('This object already has 32 cutting planes. Undo an earlier cut before adding another.');
    const node=clone(original);node.clipPlanes=[...(node.clipPlanes||[]),plane];return node;
  });
}
export function propagateClipPlanes(parent,child){
  const node=clone(child),matrix=transformMatrix(child.transform);
  node.clipPlanes=[...(node.clipPlanes||[]),...(parent.clipPlanes||[]).map(p=>localPlane(p,matrix))];
  if(node.clipPlanes.length>32)throw Error('Ungrouping would exceed the 32 cutting-plane limit. Edit the source parts inside the group instead.');
  if(!node.clipPlanes.length)delete node.clipPlanes;
  return node;
}
export function collectFitTargets(objects,{excludeIds=[],includeSolids=false,combineOperation}={}){
  if(!Array.isArray(objects))throw Error('Choose a project to find its openings.');
  if(combineOperation!==undefined&&!['union','difference','intersection'].includes(combineOperation))throw Error('The current solid operation is invalid.');
  const excluded=new Set(excludeIds),targets=[];
  const excludeBranch=node=>{excluded.add(node.id);for(const child of node.children||[])excludeBranch(child);};
  for(const id of excludeIds){const node=findNode(objects,id);if(node)excludeBranch(node);}
  const includesExcluded=node=>excluded.has(node.id)||(node.children||[]).some(includesExcluded);
  function add(node,matrix,path,kind,hidden,ancestors,ownerId=node.id){
    if(includesExcluded(node))return;
    const local=clone(node);local.transform=identity();local.visible=true;local.role='solid';
    if(kind==='bore'){
      const p=node.params,wall=p.wall??Math.min(2,Math.min(p.width,p.depth)/4);
      local.type='cylinder';local.name=node.name+' bore';local.params={width:p.width-2*wall,depth:p.depth-2*wall,height:p.height};delete local.children;delete local.operation;
    }
    const planes=[...(local.clipPlanes||[])];
    for(const ancestor of ancestors){
      const relative=ancestor.matrix.clone().invert().multiply(matrix);
      for(const plane of ancestor.planes)planes.push(localPlane(plane,relative));
    }
    if(planes.length)local.clipPlanes=planes;
    targets.push({key:kind+':'+node.id,sourceId:node.id,ownerId,label:path.join(' / ')+(kind==='bore'?' / Bore':''),kind,hidden,node:local,matrix:matrix.toArray()});
  }
  function visit(nodes,parent,path,sign=1,hidden=false,ancestors=[],root=true){
    for(let index=0;index<nodes.length;index++){
      const node=nodes[index];
      if(excluded.has(node.id))continue;
      const matrix=parent.clone().multiply(transformMatrix(node.transform)),nextPath=[...path,node.name||'Unnamed object'];
      const currentSign=root?(combineOperation?(combineOperation==='difference'&&index>0?-1:1):(node.role==='hole'?-1:1)):sign,currentHidden=hidden||node.visible===false;
      if(root&&currentSign<0)add(node,matrix,nextPath,combineOperation?'cutout':'hole',currentHidden,ancestors);
      else if(root&&includeSolids)add(node,matrix,nextPath,'reference',currentHidden,ancestors);
      if(node.type==='tube'&&currentSign>0)add(node,matrix,nextPath,'bore',currentHidden,ancestors);
      const nextAncestors=node.clipPlanes?.length?[...ancestors,{matrix,planes:node.clipPlanes}]:ancestors;
      for(let i=0;i<(node.children?.length||0);i++){
        const child=node.children[i],negative=node.operation==='difference'&&i>0,childSign=negative?-currentSign:currentSign;
        if(negative&&childSign<0&&!excluded.has(child.id))add(child,matrix.clone().multiply(transformMatrix(child.transform)),[...nextPath,child.name||'Unnamed cut'],'cutout',currentHidden||child.visible===false,nextAncestors,node.id);
        visit([child],matrix,nextPath,childSign,currentHidden,nextAncestors,false);
      }
    }
  }
  visit(objects,new Matrix4(),[]);return targets;
}
export function fitNodeToTarget(source,sourceBounds,target,targetBounds,{clearance=0.2,axes='xy',mode='stretch'}={}){
  if(!source||source.locked)throw Error('Unlock and select a shape before fitting it.');
  if(!target?.node||!Array.isArray(target.matrix)||target.matrix.length!==16||target.matrix.some(x=>!Number.isFinite(x)))throw Error('Choose a valid opening.');
  if(!['xy','xyz'].includes(axes)||!['stretch','uniform'].includes(mode))throw Error('Choose how to fit the shape.');
  if(!Number.isFinite(clearance)||clearance<0||clearance>100)throw Error('Clearance must be between 0 and 100 mm per side.');
  const validBounds=b=>b&&Array.isArray(b.min)&&Array.isArray(b.max)&&b.min.length===3&&b.max.length===3&&[...b.min,...b.max].every(Number.isFinite)&&dimensions(b).every(d=>d>1e-8);
  if(!validBounds(sourceBounds)||!validBounds(targetBounds))throw Error('The shape and opening must both contain solid geometry.');
  const matrix=new Matrix4().fromArray(target.matrix),frame=exactMatrixTransform(matrix),sourceSize=dimensions(sourceBounds),targetSize=dimensions(targetBounds);
  const targetDimensions=targetSize.map((d,i)=>d*Math.abs(frame.scale[i]));
  const before=sourceSize.map((d,i)=>d*Math.abs(source.transform.scale[i])),active=axes==='xy'?[0,1]:[0,1,2];
  const available=targetDimensions.map(d=>d-2*clearance),factors=[1,1,1];
  if(active.some(i=>available[i]<=0.00001))throw Error('The clearance is too large for this opening.');
  for(const i of active)factors[i]=available[i]/before[i];
  if(mode==='uniform'){const factor=Math.min(...active.map(i=>factors[i]));for(const i of active)factors[i]=factor;}
  let profileWarning='';
  const rectangular=['box','roundedBox','wedge','pyramid','boolean','mesh','gear','polygon'].includes(source.type);
  if(target.node.type==='cylinder'&&rectangular){
    // A box sized to a round hole's diameter does not fit: its corners protrude.
    // Conservatively inscribe its full XY bounding rectangle in the ellipse.
    const ratio=Math.hypot(before[0]*factors[0]/available[0],before[1]*factors[1]/available[1]);
    if(ratio>1){factors[0]/=ratio;factors[1]/=ratio;if(mode==='uniform'&&axes==='xyz')factors[2]/=ratio;}
    profileWarning='The shape is sized conservatively so its full rectangular outline fits inside the round opening.';
  }else if(!['box','cylinder'].includes(target.node.type))profileWarning='This opening has a curved or complex profile. Sizing follows its extents; inspect the fit before printing.';
  if(target.node.clipPlanes?.length)profileWarning+=(profileWarning?' ':'')+'This opening has been plane-cut; inspect its remaining profile before printing.';
  const scale=source.transform.scale.map((s,i)=>s*factors[i]*Math.sign(frame.scale[i]));
  const targetCentre=targetBounds.min.map((v,i)=>(v+targetBounds.max[i])/2),sourceCentre=sourceBounds.min.map((v,i)=>(v+sourceBounds.max[i])/2);
  const transform={position:[0,0,0],rotation:[...frame.rotation],scale};
  const centre=new Vector3(...targetCentre).applyMatrix4(matrix),offset=new Vector3(...sourceCentre).applyMatrix4(transformMatrix(transform));
  transform.position=centre.sub(offset).toArray();
  const node=clone(source);node.transform=transform;
  validateProject({...blankProject(),objects:[node]});
  const targetNode=clone(target.node);targetNode.transform=frame;targetNode.role='solid';targetNode.visible=true;
  if(target.hidden)profileWarning+=(profileWarning?' ':'')+'The saved opening is currently hidden.';
  return {transform,node,targetNode,dimensions:before.map((d,i)=>d*factors[i]),targetDimensions,clearance,profileWarning};
}
export function applyFittedNode(objects,sourceId,target,fitted,{placeInside=true,combineOperation}={}){
  if(!Array.isArray(objects))throw Error('Choose a design to fit the shape into.');
  const source=objects.find(n=>n.id===sourceId);
  if(!source||source.locked)throw Error('The selected shape is no longer editable.');
  if(!target?.sourceId||target.sourceId===sourceId||!findNode(objects,target.sourceId))throw Error('The opening is no longer available. Choose it again.');
  if(!fitted?.transform)throw Error('Measure the shape and opening before applying the fit.');
  if(combineOperation!==undefined&&!['union','difference','intersection'].includes(combineOperation))throw Error('The current solid operation is invalid.');
  if(placeInside&&['difference','intersection'].includes(combineOperation))throw Error('Return to the whole design to centre a separate part in this opening. Inside this group, the solid operation would cut or intersect the fitted part.');
  const result=clone(objects),part=result.find(n=>n.id===sourceId);
  part.transform=clone(fitted.transform);
  if(!placeInside)part.transform.position=[...source.transform.position];
  let holeAction='none',message=placeInside?'The shape will be resized, aligned and centred in the opening.':'The shape will be resized and aligned, keeping its current position for separate printing.';
  if(placeInside&&target.kind==='hole'&&combineOperation===undefined&&source.role==='solid'){
    const hole=result.find(n=>n.id===target.sourceId&&n.role==='hole');
    if(!hole)throw Error('This Hole has changed. Choose the opening again.');
    const hosts=result.filter(n=>n.id!==sourceId&&n.role==='solid');
    if(hosts.length){
      // A loose Hole normally subtracts from every positive root. Retain that
      // cut on the existing bodies, while allowing the new insert to fill it.
      // Hidden hosts remain in the group so showing them later keeps the cut.
      const group=combineSelection('union',[...hosts,hole]);
      group.name=hosts.length===1?(hosts[0].name+' with opening').slice(0,120):'Bodies with fitted opening';
      group.locked=hosts.some(n=>n.locked)||hole.locked;
      const groupedIds=new Set([...hosts.map(n=>n.id),hole.id]);
      const position=result.findIndex(n=>groupedIds.has(n.id));
      const remaining=result.filter(n=>!groupedIds.has(n.id));
      // Insert at the original first grouped location without reordering the
      // independent part or the other global cutting shapes.
      const insertion=result.slice(0,position).filter(n=>!groupedIds.has(n.id)).length;
      remaining.splice(insertion,0,group);
      result.splice(0,result.length,...remaining);
      holeAction='scoped';
      message='The shape will be centred in the opening. This Hole will stay attached to the existing bodies in an editable cut group, so it cannot cut away the fitted part.';
    }else if(hole.visible){
      if(hole.locked)throw Error('Unlock this Hole before centring the part. With no other body to cut, it needs to be hidden as a reference.');
      hole.visible=false;holeAction='hidden';
      message='The shape will be centred in the opening. With no other body to cut, this Hole will be kept as a hidden reference so the fitted part remains solid.';
    }else message='The shape will be centred in the opening. The hidden Hole will remain available as a reference.';
  }
  validateProject({...blankProject(),objects:result});
  return {objects:result,selectedId:sourceId,message,placement:placeInside?'centred':'separate',holeAction};
}
export function alignObjects(objects,selectedIds,axis,edge,boundsFor){
  const items=selectedIds.map(id=>objects.find(n=>n.id===id)).filter(Boolean);
  if(items.length<2)return;
  const anchor=boundsFor(items[0].id);if(!anchor)return;
  const target=edge==='center'?(anchor.min[axis]+anchor.max[axis])/2:anchor[edge][axis];
  for(const n of items.slice(1)){if(n.locked)continue;const b=boundsFor(n.id);if(!b)continue;const value=edge==='center'?(b.min[axis]+b.max[axis])/2:b[edge][axis];n.transform.position[axis]+=target-value;}
}
export function createArray(node,{mode='linear',count=4,axis=0,spacing=30,radius=50,startAngle=0,arc=360,rotate=true}={}){
  if(!['linear','radial'].includes(mode)||![count,spacing,radius,startAngle,arc].every(Number.isFinite)||![0,1,2].includes(axis)||radius<0)throw Error('Invalid repeat settings.');
  count=Math.min(64,Math.max(2,Math.round(count)));
  if(nodeCount([node])*count>PROJECT_LIMITS.nodes)throw Error('This repeat exceeds the 256-object limit, including nested parts.');
  const items=[];
  for(let i=1;i<count;i++){
    const n=freshClone(node);n.name=`${node.name} ${i+1}`;
    if(mode==='linear')n.transform.position[axis]+=spacing*i;
    else{
      const step=arc===360?arc/count:arc/(count-1),angle=MathUtils.degToRad(startAngle+step*i),initial=MathUtils.degToRad(startAngle);
      // Original is the first point on the circle. The centre lies radius away in -X.
      n.transform.position[0]+=radius*(Math.cos(angle)-Math.cos(initial));
      n.transform.position[1]+=radius*(Math.sin(angle)-Math.sin(initial));
      if(rotate){const q=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),MathUtils.degToRad(step*i));const old=new Quaternion().setFromEuler(new Euler(...node.transform.rotation.map(MathUtils.degToRad),'ZYX'));const r=new Euler().setFromQuaternion(q.multiply(old),'ZYX');n.transform.rotation=[r.x,r.y,r.z].map(MathUtils.radToDeg);}
    }
    items.push(n);
  }
  return items;
}
export function validateProject(value){
  if(!value||value.format!=='solid-studio'||value.version!==1||!Array.isArray(value.objects))throw Error('Choose a Solid Studio .solid.json project.');
  if(typeof value.name!=='string'||!value.name.trim()||value.name.length>120)throw Error('Project name must contain 1–120 characters.');
  const types=new Set([...SHAPES.map(s=>s.type),'boolean','mesh']),ids=new Set();let count=0,triangles=0;
  const numeric=(x,label,min,max)=>{if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max)throw Error(`${label} must be a finite number between ${min} and ${max}.`);};
  function visit(nodes,depth=0){if(depth>PROJECT_LIMITS.depth)throw Error('Project is nested too deeply.');for(const n of nodes){
    if(++count>PROJECT_LIMITS.nodes)throw Error('This project exceeds the 256-object limit, including nested parts.');
    if(!n||typeof n!=='object'||Array.isArray(n)||typeof n.id!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(n.id)||ids.has(n.id)||!types.has(n.type))throw Error('This project contains invalid or duplicate objects.');ids.add(n.id);
    if(!['solid','hole'].includes(n.role))throw Error('An object has an invalid material role.');
    if(typeof n.name!=='string'||n.name.length>120)throw Error('An object name is invalid.');
    if(!/^#[0-9a-f]{6}$/i.test(n.color||''))n.color=COLORS[0];
    if(!n.transform)throw Error('An object transform is missing.');
    for(const [key,max] of [['position',PROJECT_LIMITS.coordinate],['rotation',360000],['scale',1000]])if(!Array.isArray(n.transform[key])||n.transform[key].length!==3||n.transform[key].some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>max))throw Error('Object transforms must be finite numbers within the supported range.');
    if(n.transform.scale.some(x=>Math.abs(x)<0.00001))throw Error('Object scale cannot be zero.');
    if(n.clipPlanes!==undefined){
      if(!Array.isArray(n.clipPlanes)||n.clipPlanes.length>32)throw Error('An object may have at most 32 cutting planes.');
      for(const plane of n.clipPlanes){
        if(!plane||!Array.isArray(plane.normal)||plane.normal.length!==3||plane.normal.some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>PROJECT_LIMITS.coordinate)||Math.hypot(...plane.normal)<1e-9)throw Error('A cutting plane needs a finite, nonzero normal.');
        numeric(plane.offset,'Cutting plane offset',-PROJECT_LIMITS.coordinate,PROJECT_LIMITS.coordinate);
      }
    }
    if(!n.params||typeof n.params!=='object'||Array.isArray(n.params))throw Error('Object parameters are missing.');
    if(n.type==='boolean'){if(!['union','difference','intersection'].includes(n.operation)||!Array.isArray(n.children)||!n.children.length)throw Error('Invalid solid operation.');visit(n.children,depth+1);}
    else{
      if(n.children!==undefined)throw Error('Only combined solids may contain child objects.');
      const p=n.params;
      if(n.type==='mesh'){
        if(!Array.isArray(p.positions)||!Array.isArray(p.indices)||p.positions.length<12||p.positions.length%3||p.indices.length<12||p.indices.length%3)throw Error('Imported geometry has incomplete vertices or triangles.');
        triangles+=p.indices.length/3;
        if(triangles>PROJECT_LIMITS.inputTriangles||p.positions.length/3>PROJECT_LIMITS.inputTriangles*3)throw Error('Imported geometry exceeds the 250,000 triangle limit.');
        for(const x of p.positions)numeric(x,'Mesh coordinate',-PROJECT_LIMITS.coordinate,PROJECT_LIMITS.coordinate);
        for(const i of p.indices)if(!Number.isInteger(i)||i<0||i>=p.positions.length/3)throw Error('Imported geometry contains an invalid vertex index.');
      }else{
        for(const key of ['width','depth','height'])numeric(p[key],`Object ${key}`,0.05,PROJECT_LIMITS.dimension);
        if(n.type==='roundedBox'&&p.radius!==undefined)numeric(p.radius,'Corner radius',0,PROJECT_LIMITS.dimension);
        if(n.type==='cone'&&p.topRatio!==undefined)numeric(p.topRatio,'Top radius ratio',0,1);
        if(n.type==='capsule'){numeric(p.topRoundness===undefined?1:p.topRoundness,'Top end curvature',0,2);numeric(p.bottomRoundness===undefined?1:p.bottomRoundness,'Bottom end curvature',0,2);}
        if(n.type==='torus'&&p.tubeRatio!==undefined)numeric(p.tubeRatio,'Ring thickness ratio',0.02,0.49);
        if(n.type==='tube')numeric(p.wall??Math.min(2,Math.min(p.width,p.depth)/4),'Wall thickness',0.025,Math.min(p.width,p.depth)/2-0.01);
        if(n.type==='polygon'){numeric(p.sides??6,'Number of sides',3,64);if(!Number.isInteger(p.sides??6))throw Error('Number of sides must be a whole number.');}
        if(n.type==='gear'){numeric(p.teeth??16,'Number of teeth',6,64);if(!Number.isInteger(p.teeth??16))throw Error('Number of teeth must be a whole number.');if(p.toothDepth!==undefined)numeric(p.toothDepth,'Tooth depth ratio',0.05,0.4);}
      }
    }
    n.visible=n.visible!==false;n.locked=Boolean(n.locked);
  }}
  visit(value.objects);value.settings={...blankProject().settings,...value.settings};
  for(const [key,min,max] of [['gridSize',10,10000],['gridSnap',0.01,1000],['angleSnap',0.1,180]])numeric(value.settings[key],key,min,max);
  value.settings.snapEnabled=value.settings.snapEnabled!==false;value.settings.showGrid=value.settings.showGrid!==false;
  return value;
}
export class History{
  constructor(limit=45,byteLimit=48*1024*1024){this.limit=limit;this.byteLimit=byteLimit;this.past=[];this.future=[];}
  push(before){const s=typeof before==='string'?before:JSON.stringify(before);if(this.past.at(-1)===s)return;this.past.push(s);this.future=[];while(this.past.length>this.limit||this.past.length>1&&this.past.reduce((a,b)=>a+b.length*2,0)>this.byteLimit)this.past.shift();}
  undo(current){if(!this.past.length)return null;this.future.push(JSON.stringify(current));return JSON.parse(this.past.pop());}
  redo(current){if(!this.future.length)return null;this.past.push(JSON.stringify(current));return JSON.parse(this.future.pop());}
  clear(){this.past=[];this.future=[];}
}
