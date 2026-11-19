import {Viewport} from './viewport.js';
import {SoftwareViewport} from './software-viewport.js';
import {SHAPES,COLORS,clone,uid,makeNode,makeBoolean,combineSelection,blankProject,starterProject,findNode,nodeCount,freshClone,identity,transformMatrix,matrixTransform,attachFaces,dimensions,alignObjects,createArray,collectFitTargets,fitNodeToTarget,applyFittedNode,cutBelowBuildPlane,propagateClipPlanes,validateProject,History} from './model.js';
import {shapeIcon} from './palette.js';

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const round=(x,n=2)=>Number(x.toFixed(n));
const fmt=x=>Number.isFinite(x)?round(x).toLocaleString(undefined,{maximumFractionDigits:2}):'—';
const bytesToBase64=buffer=>{const b=new Uint8Array(buffer);let s='';for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(s);};

let project=starterProject(),selectedIds=[],contextPath=[],serverId=null,serverRevision=null,dirty=false;
let viewport=null,lastEvaluation=null,history=new History(),previewMode='parts',displayMode='solid',mode='translate';
let buildSerial=0,evaluatedSerial=-1,rebuildTimer=null,draftTimer=null,fitNext=true,gestureBefore=null,libraryAttempt=null,hasDraft=false;
let documentGeneration=0,saveInFlight=false,rendererError=null;
let worker=null,rpcId=0;const pending=new Map();
let serverSettings={layerLibraryUrl:''},serverConnected=false,librarySaving=false;

function toast(message,error=false){const node=document.createElement('div');node.className='toast'+(error?' error':'');node.textContent=message;$('#toasts').append(node);setTimeout(()=>node.remove(),error?7500:4300);}
function showError(error){toast(error?.message||String(error),true);}
function status(message){$('#stage-message').textContent=message;$('#stage-message').hidden=!message;}
function currentGroup(){let nodes=project.objects,group=null;for(const id of contextPath){group=nodes.find(n=>n.id===id&&n.type==='boolean');if(!group){contextPath=[];return null;}nodes=group.children;}return group;}
function objects(){return currentGroup()?.children||project.objects;}
function selected(){const nodes=objects();return selectedIds.map(id=>nodes.find(n=>n.id===id)).filter(Boolean);}
function single(){return selected().length===1?selected()[0]:null;}
function currentDocument(){const group=currentGroup();const doc={...project,objects:clone(objects())};if(group){doc.combineOperation=group.operation;if(group.operation==='difference')doc.objects.forEach((n,i)=>n.role=i===0?'solid':'hole');else doc.objects.forEach(n=>n.role='solid');}return doc;}

function startWorker(){
  worker=new Worker(new URL('./geometry-worker.js',import.meta.url),{type:'module'});
  worker.onmessage=event=>{const p=pending.get(event.data.id);if(!p)return;pending.delete(event.data.id);clearTimeout(p.timer);event.data.ok?p.resolve(event.data.result):p.reject(Error(event.data.error));};
  worker.onerror=event=>{const error=Error(event.message||'The modelling engine stopped. Reload this page to restart it.');for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
}
function rpc(action,payload={}){
  if(!worker)startWorker();
  const id=++rpcId;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.terminate();worker=null;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('This model took too long to calculate. Undo the last change or reduce its detail or number of copies.'));}pending.clear();},90000);
    pending.set(id,{resolve,reject,timer});worker.postMessage({id,action,...payload});
  });
}
async function api(path,{method='GET',body}={}){
  const response=await fetch('/api/'+path,{method,headers:{'Content-Type':'application/json','X-Solid-Studio':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  let data;try{data=await response.json();}catch{throw Error('The server returned an unreadable response.');}
  if(!response.ok){const e=Error(data.error||'The request failed.');e.status=response.status;e.details=data;throw e;}return data;
}

let draftDBPromise;
function draftDB(){return draftDBPromise??=new Promise((resolve,reject)=>{const r=indexedDB.open('solid-studio',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function readDraft(){try{const db=await draftDB();return await new Promise((resolve,reject)=>{const r=db.transaction('drafts').objectStore('drafts').get('working');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}catch{return null;}}
async function persistDraft(){
  try{const db=await draftDB();const record={project:clone(project),serverId,serverRevision,dirty:dirty||Boolean(gestureBefore)};await new Promise((resolve,reject)=>{const t=db.transaction('drafts','readwrite');t.objectStore('drafts').put(record,'working');t.oncomplete=resolve;t.onerror=()=>reject(t.error);});hasDraft=true;renderSaveStatus();}
  catch{$('#save-status').textContent='Browser storage full · Save to server';}
}
function scheduleDraft(){clearTimeout(draftTimer);draftTimer=setTimeout(persistDraft,350);}
function renderSaveStatus(){$('#save-status').textContent=serverId&&!dirty?'Saved on your server':hasDraft?'Draft saved in this browser':'Unsaved design';}
function changed(before){
  if(before===JSON.stringify(project))return;
  history.push(before);dirty=true;hasDraft=false;scheduleDraft();renderAll();scheduleBuild();
}
function mutate(fn,{fit=false}={}){
  const before=JSON.stringify(project);
  try{fn();validateProject(project);}catch(error){project=JSON.parse(before);renderAll();throw error;}
  fitNext||=fit;changed(before);
}
function scheduleBuild(){buildSerial++;viewport?.cancelFaceSnap();viewport?.setSelection([]);renderActions();clearTimeout(rebuildTimer);rebuildTimer=setTimeout(()=>rebuild(buildSerial),65);}
function requireCurrentGeometry(){if(evaluatedSerial!==buildSerial||!lastEvaluation)throw Error('Wait for the current solid to finish updating, then try again.');}
async function rebuild(serial){
  const doc=currentDocument();
  const loader=setTimeout(()=>{$('#loading-state').hidden=false;$('#loading-state>span:last-child').textContent='Updating solid…';},220);
  try{
    const result=await rpc('evaluate',{project:doc,quality:'standard'});
    if(serial!==buildSerial)return;
    lastEvaluation=result;evaluatedSerial=serial;$('#geometry-error').hidden=!rendererError;if(rendererError)$('#geometry-error').textContent=rendererError;
    viewport?.setScene(result.meshes,doc.objects,selectedIds);
    viewport?.setResult(result.result,previewMode==='result');
    viewport?.setGrid(project.settings.showGrid,project.settings.gridSize);
    viewport?.setSnapping({enabled:project.settings.snapEnabled,grid:project.settings.gridSnap,angle:project.settings.angleSnap});
    if(fitNext){viewport?.fit();fitNext=false;}
    // Geometry completion must not replace an input the user is currently editing.
    renderStats();renderActions();
    $('#geometry-status').textContent=result.result?'Solid ready · '+(result.stats.components===1?'1 part':result.stats.components+' separate parts'):doc.objects.length?'No solid material':'Ready to build';
  }catch(error){
    if(serial!==buildSerial)return;
    $('#geometry-error').textContent=error.message;$('#geometry-error').hidden=false;$('#geometry-status').textContent='Design needs attention';
    lastEvaluation=null;evaluatedSerial=-1;viewport?.setScene([],doc.objects,[]);viewport?.setResult(null,previewMode==='result');renderStats();renderActions();
  }finally{clearTimeout(loader);if(serial===buildSerial)$('#loading-state').hidden=true;}
}
function setSelection(ids){const nodes=objects();selectedIds=[...new Set(ids)].filter(id=>nodes.some(n=>n.id===id));viewport?.setSelection(evaluatedSerial===buildSerial?selectedIds:[]);renderObjects();renderInspector();renderActions();}
function selectObject(id,additive=false){if(!id){if(!additive)setSelection([]);return;}setSelection(additive?(selectedIds.includes(id)?selectedIds.filter(x=>x!==id):[...selectedIds,id]):[id]);}
function setPreview(value){previewMode=value;viewport?.setResult(lastEvaluation?.result||null,value==='result');$$('[data-preview]').forEach(b=>{b.classList.toggle('active',b.dataset.preview===value);b.setAttribute('aria-pressed',String(b.dataset.preview===value));});}
function renderAll(){
  $('#project-name').value=project.name;
  const group=currentGroup();$('#edit-context').hidden=!group;$('#edit-context-name').textContent=group?.name||'';$('#context-label').textContent=group?'EDITING PARTS':'DESIGN WORKSPACE';$('#object-list-title').textContent=group?'Source parts':'Objects';
  $('#empty-state').hidden=objects().length>0;
  $('#grid-snap').value=String(project.settings.gridSnap);
  $('#snap-toggle').classList.toggle('active',project.settings.snapEnabled);$('#snap-toggle').setAttribute('aria-pressed',String(project.settings.snapEnabled));
  $('#grid-toggle').setAttribute('aria-pressed',String(project.settings.showGrid));
  selectedIds=selectedIds.filter(id=>objects().some(n=>n.id===id));
  renderSaveStatus();renderObjects();renderInspector();renderActions();
}
function renderPalette(){const q=$('#shape-search').value.trim().toLowerCase();$('#shape-grid').innerHTML=SHAPES.filter(s=>(s.name+' '+s.type+' '+s.hint).toLowerCase().includes(q)).map(s=>`<button class="shape-card" data-add="${s.type}" title="${esc(s.hint)}" aria-label="Add ${esc(s.name.toLowerCase())}">${shapeIcon(s.type,COLORS[s.color])}<span>${s.name}</span><span class="add-sign" aria-hidden="true">+</span></button>`).join('')||'<p class="empty-list">No shapes match.</p>';}
function renderObjects(){
  const nodes=objects(),group=currentGroup();$('#object-count').textContent=String(nodes.length);
  $('#object-list').innerHTML=nodes.map((n,i)=>`<div class="object-row ${selectedIds.includes(n.id)?'selected ':''}${n.visible?'':'invisible '}${n.role==='hole'||group?.operation==='difference'&&i>0?'hole ':''}${n.locked?'locked':''}" data-select="${esc(n.id)}" role="button" tabindex="0" aria-pressed="${selectedIds.includes(n.id)}" aria-label="Select ${esc(n.name)}"><span class="object-dot" style="background:${n.color}"></span><span class="object-name">${esc(n.name)}</span>${n.type==='boolean'?`<button class="tiny-button" data-enter="${esc(n.id)}" title="Edit source parts of ${esc(n.name)}" aria-label="Edit parts of ${esc(n.name)}">${icon('chevron')}</button>`:''}<button class="tiny-button" data-visible="${esc(n.id)}" title="${n.visible?'Hide':'Show'} ${esc(n.name)}" aria-label="${n.visible?'Hide':'Show'} ${esc(n.name)}">${icon(n.visible?'eye':'eye-off')}</button></div>`).join('')||'<p class="empty-list">Add a shape above.<br>Your objects will appear here.</p>';
}
function numberFields(labels,values,kind,keys,unit='mm',opts={}){return `<div class="field-grid">${values.map((v,i)=>`<label class="number-field ${kind!=='param'?'axis-'+['x','y','z'][i]:''}"><span>${labels[i]} <small>${unit}</small></span><input type="number" value="${round(v,3)}" data-${kind}="${keys[i]}" aria-label="${esc(opts.prefix||kind)} ${esc(labels[i])}" step="${opts.step||0.1}" ${opts.min!==undefined?`min="${opts.min}"`:''} ${opts.max!==undefined?`max="${opts.max}"`:''} ${opts.disabled?'disabled':''}></label>`).join('')}</div>`;}
function renderInspector(){
  const list=selected(),n=list[0],singleSelection=list.length===1;
  $('#selection-label').textContent=list.length?`${list.length} selected`:'No selection';
  if(!list.length){$('#inspector-content').innerHTML=`<div class="inspector-empty">${icon('cube')}<div>Select an object to shape it.</div><p class="section-help">Click a shape in the workspace or object list. Shift-click to select more than one.</p></div><div class="inspector-section"><h3>Workspace</h3><p class="section-help">Build with solids. Use a hole to remove material. Join parts when they are ready.</p><button class="button secondary full-width" data-action="new">Starting designs</button></div>`;return;}
  if(!singleSelection){$('#inspector-content').innerHTML=`<p class="multi-select-message">${list.length} objects selected.</p><p class="section-help">The first selected object is the base for subtraction and the reference for alignment: <strong>${esc(n.name)}</strong>.</p><div class="inspector-section"><h3>Combine shapes</h3><div class="inspector-tools"><button class="button" data-op="union">${icon('union')}Join</button><button class="button" data-op="difference">${icon('subtract')}Subtract</button><button class="button" data-op="intersection">${icon('intersect')}Intersect</button><button class="button" data-action="align">${icon('align')}Align</button></div></div><div class="inspector-section"><h3>Selection</h3><div class="inspector-tools"><button class="button" data-action="duplicate">${icon('copy')}Duplicate</button><button class="button" data-action="drop">${icon('drop')}Drop to bed</button><button class="button" data-action="delete">${icon('trash')}Delete</button></div></div>`;return;}
  const shape=SHAPES.find(s=>s.type===n.type),trans=n.transform,disabled=n.locked?'disabled':'';
  let content=`<div class="object-title-field"><input id="object-name" value="${esc(n.name)}" aria-label="Object name" maxlength="120" ${disabled}></div><div class="object-type">${esc(shape?.name||(n.type==='boolean'?n.operation+' · '+n.children.length+' source parts':'Imported STL'))}${n.locked?' · Locked':''}</div>`;
  if(!currentGroup())content+=`<div class="role-toggle" style="--object-color:${n.color}" role="group" aria-label="Object role"><button data-role="solid" class="${n.role==='solid'?'active':''}" aria-pressed="${n.role==='solid'}" ${disabled}><span class="role-ball"></span>Solid</button><button data-role="hole" class="${n.role==='hole'?'active':''}" aria-pressed="${n.role==='hole'}" ${disabled}><span class="role-ball hole"></span>Hole</button></div>`;
  if(n.role==='hole'&&!currentGroup())content+='<p class="hole-note">This shape cuts material from every visible solid it overlaps. See the cut in Print result.</p>';
  if(n.type==='boolean')content+=`<div class="group-actions"><select class="operation-select" id="group-operation" aria-label="Group operation" ${disabled}>${['union','difference','intersection'].map(op=>`<option value="${op}" ${op===n.operation?'selected':''}>${op==='union'?'Join':op==='difference'?'Subtract':'Intersect'} source parts</option>`).join('')}</select><button class="button secondary full-width" data-enter="${esc(n.id)}">Edit source parts</button><p class="section-help">Your original shapes stay editable.</p><button class="button quiet full-width" data-action="ungroup" ${disabled}>Separate source parts</button></div>`;
  if(shape)content+=`<section class="inspector-section"><h3>Dimensions <span>before scale</span></h3>${numberFields(['Width','Depth','Height'],['width','depth','height'].map(k=>n.params[k]),'param',['width','depth','height'],'mm',{min:.1,max:10000,disabled:n.locked,prefix:'Dimensions'})}</section>`;
  const extras={roundedBox:['radius','Corner radius','mm',.1],tube:['wall','Wall thickness','mm',.1],cone:['topRatio','Top / base ratio','',.05],torus:['tubeRatio','Tube / width ratio','',.05],polygon:['sides','Number of sides','',1],gear:['teeth','Number of teeth','',1]};
  if(extras[n.type]){const[k,label,unit,step]=extras[n.type];content+=`<section class="inspector-section"><h3>${label}<span>${unit}</span></h3><input class="field-input" type="number" value="${n.params[k]}" data-param="${k}" aria-label="${label}" step="${step}" ${disabled}>${n.type==='gear'?'<p class="section-help">A decorative gear blank; not a mechanically specified involute gear.</p>':''}</section>`;}
  if(n.type==='capsule')content+=`<section class="inspector-section capsule-ends"><h3>End curvature</h3>${[['topRoundness','Top'],['bottomRoundness','Bottom']].map(([key,label])=>`<div class="end-control"><label for="${key}-value">${label} end</label><input id="${key}-value" class="field-input" type="number" min="0" max="2" step="0.05" value="${n.params[key]??1}" data-param="${key}" aria-label="${label} end curvature" ${disabled}><input type="range" min="0" max="2" step="0.05" value="${n.params[key]??1}" data-param="${key}" aria-label="${label} end curvature slider" ${disabled}></div>`).join('')}<p class="section-help">0 flat · 1 round · 2 elongated. Each end is independent; the overall height stays fixed.</p></section>`;
  if(n.clipPlanes?.length)content+=`<section class="inspector-section plane-cut-note"><h3>Plane cut applied</h3><p class="section-help">The cut moves with this object. Its original shape is retained.</p><button class="button secondary full-width" data-action="removeCuts" ${disabled}>Remove plane cuts</button></section>`;
  content+=`<button class="button secondary full-width fit-hole-inspector" data-action="fitHole" ${disabled}>${icon('fit-hole')}Fit to hole</button>`;
  content+=`<section class="inspector-section"><h3>Position <span>object centre</span></h3>${numberFields(['X','Y','Z'],trans.position,'position',['0','1','2'],'mm',{disabled:n.locked,prefix:'Position'})}</section><section class="inspector-section"><h3>Rotation</h3>${numberFields(['X','Y','Z'],trans.rotation,'rotation',['0','1','2'],'°',{step:1,disabled:n.locked,prefix:'Rotation'})}</section><section class="inspector-section"><h3>Scale</h3>${numberFields(['X','Y','Z'],trans.scale,'scale',['0','1','2'],'×',{step:.1,disabled:n.locked,prefix:'Scale'})}<p class="section-help">Use a negative value or Mirror to reflect an axis.</p></section>`;
  content+=`<hr class="thin-line"><section class="inspector-section"><h3>Preview colour</h3><div class="color-row">${COLORS.map(c=>`<button class="color-swatch ${n.color===c?'active':''}" style="background:${c}" data-color="${c}" title="Use ${c}" aria-label="Use colour ${c}" ${disabled}></button>`).join('')}</div></section><section class="inspector-section"><h3>Mirror</h3><div class="inline-controls">${['X','Y','Z'].map((a,i)=>`<button class="button secondary" data-mirror="${i}" ${disabled}>${a}</button>`).join('')}</div></section><div class="inspector-tools"><button class="button" data-action="drop" ${disabled}>${icon('drop')}Drop to bed</button><button class="button" data-action="array" ${disabled}>${icon('array')}Repeat</button><button class="button" data-action="duplicate">${icon('copy')}Duplicate</button><button class="button" data-action="toggleLock">${icon(n.locked?'unlock':'lock')}${n.locked?'Unlock':'Lock'}</button></div>`;
  $('#inspector-content').innerHTML=content;
}
function renderActions(){
  $('#undo').disabled=!history.past.length;$('#redo').disabled=!history.future.length;
  const list=selected(),locked=list.some(n=>n.locked);
  $$('[data-op]').forEach(b=>b.disabled=list.length<2||locked);
  $$('[data-action=duplicate],[data-action=delete],[data-action=drop]').forEach(b=>b.disabled=!list.length||(b.dataset.action!=='duplicate'&&locked));
  const current=evaluatedSerial===buildSerial&&Boolean(lastEvaluation)&&Boolean(viewport);
  $$('[data-action=faceSnap]').forEach(b=>b.disabled=!current||list.length!==1||locked||objects().filter(n=>n.visible).length<2);
  $$('[data-action=align]').forEach(b=>b.disabled=!current||list.length<2||locked);
  $$('[data-action=drop]').forEach(b=>b.disabled=!current||!list.length||locked);
  $$('[data-align]').forEach(b=>b.disabled=!current);
  $$('[data-action=fitHole]').forEach(b=>b.disabled=!list.length||Boolean(list[0]?.locked));
  $$('[data-action=cutPlane]').forEach(b=>b.disabled=!project.objects.length);
}
function renderStats(){
  const stats=lastEvaluation?.stats,dims=dimensions(stats?.bounds),result=lastEvaluation?.result;
  $('#result-size').textContent=result?dims.map(fmt).join(' × ')+' mm':'— × — × — mm';
  $('#result-volume').textContent=result?fmt(stats.volume/1000)+' cm³':'— cm³';
  $('#result-triangles').textContent=result?stats.triangles.toLocaleString()+' triangles':'— triangles';
  let warning=false,note='A combined solid, ready for your slicer.',badge='Closed mesh';
  if(!result){note='Add a visible solid to create a printable result.';badge='Empty';}
  else if(currentGroup()){note=contextPath.some(id=>findNode(project.objects,id)?.clipPlanes?.length)?'Source parts before the parent plane cut. Done editing parts restores the cut preview.':'Preview of this group. Export includes the whole design.';badge='Editing parts';}
  else if(dims.some(v=>v>project.settings.gridSize+.01)){warning=true;note='Larger than the configured build volume. Check size before printing.';badge='Check size';}
  else if(stats.bounds.min[2]<-.01){warning=true;note='Some geometry is below the bed. Use Cut below plane to remove it, or Drop to bed to move the object up.';badge='Below bed';}
  else if(stats.components>1){warning=true;note=`${stats.components} separate pieces. Overlap and Join parts if they should print as one connected object.`;badge=stats.components+' pieces';}
  else if(lastEvaluation.warnings?.length){note=lastEvaluation.warnings[0];}
  $('#result-note').textContent=note;$('#result-check').textContent=badge;$('#result-check').classList.toggle('warning',warning);
}

function addShape(type){
  const node=makeNode(type),wasEmpty=objects().length===0,baseName=node.name;
  for(let suffix=2;objects().some(n=>n.name===node.name);suffix++)node.name=baseName+' '+suffix;
  const anchor=selected()[0],b=anchor&&evaluatedSerial===buildSerial&&viewport?.getBounds(anchor.id);
  if(b)node.transform.position[0]=b.max[0]+node.params.width/2+5;
  mutate(()=>{objects().push(node);selectedIds=[node.id];},{fit:wasEmpty});setPreview('parts');
  if(innerWidth<=800)setMobilePanel('canvas');
}
function combine(operation){
  const nodes=selected();if(nodes.length<2)throw Error('Select two or more objects first.');if(nodes.some(n=>n.locked))throw Error('Unlock the selected objects first.');
  mutate(()=>{const parent=currentGroup(),list=objects(),group=combineSelection(operation,nodes,{respectRoles:!parent});const first=Math.min(...selectedIds.map(id=>list.findIndex(n=>n.id===id)));const remaining=list.filter(n=>!selectedIds.includes(n.id));remaining.splice(first,0,group);if(parent)parent.children=remaining;else project.objects=remaining;selectedIds=[group.id];});
  setPreview('parts');toast(operation==='difference'?'Cut created. Edit source parts to adjust it.':operation==='union'?'Joined into one editable object.':'Intersection created.');
}
function enterGroup(id){const n=objects().find(n=>n.id===id&&n.type==='boolean');if(!n)return;if(n.locked)throw Error('Unlock this group before editing its parts.');contextPath.push(id);selectedIds=[n.children[0]?.id].filter(Boolean);setPreview('parts');fitNext=true;status('');renderAll();scheduleBuild();}
function exitGroup(){const id=contextPath.pop();selectedIds=id?[id]:[];fitNext=true;status('');renderAll();scheduleBuild();}
function ungroup(){
  const n=single();if(n?.type!=='boolean')return;
  const matrix=transformMatrix(n.transform),children=n.children.map(child=>propagateClipPlanes(n,child));
  for(const child of children){const m=matrix.clone().multiply(transformMatrix(child.transform)),t=matrixTransform(m),recomposed=transformMatrix(t);if(m.elements.some((v,i)=>Math.abs(v-recomposed.elements[i])>1e-5))throw Error('This group combines nonuniform scale with rotated parts. Edit its source parts instead of separating it.');child.transform=t;}
  mutate(()=>{const list=objects(),idx=list.findIndex(x=>x.id===n.id);list.splice(idx,1,...children);selectedIds=children.map(x=>x.id);});toast('Source parts restored. The solid operation has been removed.');
}
function duplicate(){
  const list=selected();if(!list.length)return;
  mutate(()=>{const copies=list.map(n=>{const c=freshClone(n);c.name=n.name+' copy';c.transform.position[0]+=10;c.transform.position[1]+=10;c.locked=false;return c;});objects().push(...copies);selectedIds=copies.map(n=>n.id);});setPreview('parts');
}
function deleteSelection(){
  const list=selected();if(list.some(n=>n.locked))throw Error('Unlock selected objects before deleting them.');
  if(currentGroup()&&list.length===objects().length)throw Error('A group needs at least one source part. Leave this group to delete it.');
  mutate(()=>{const group=currentGroup(),remaining=objects().filter(n=>!selectedIds.includes(n.id));if(group)group.children=remaining;else project.objects=remaining;selectedIds=[];});
}
function dropToBed(){requireCurrentGeometry();mutate(()=>{for(const n of selected()){if(n.locked)continue;const b=viewport?.getBounds(n.id);if(b)n.transform.position[2]-=b.min[2];}});}
function cutAtBuildPlane(){
  if(!project.objects.length)return;
  const before=JSON.stringify(project),wasEditing=contextPath.length>0;
  mutate(()=>{project.objects=cutBelowBuildPlane(project.objects);contextPath=[];selectedIds=selectedIds.filter(id=>project.objects.some(n=>n.id===id));});
  if(wasEditing&&before===JSON.stringify(project)){renderAll();scheduleBuild();}
  setPreview('result');status('');
  toast(before===JSON.stringify(project)?'The existing plane cut is already applied.':'Cut below Z = 0 applied to the whole design. Undo restores it.');
}
function undo(){const p=history.undo(project);if(!p)return;project=p;contextPath=[];selectedIds=[];dirty=true;scheduleDraft();renderAll();scheduleBuild();}
function redo(){const p=history.redo(project);if(!p)return;project=p;contextPath=[];selectedIds=[];dirty=true;scheduleDraft();renderAll();scheduleBuild();}
function startFaceSnap(){
  requireCurrentGeometry();const n=single();if(!n)throw Error('Select the object you want to attach.');if(n.locked)throw Error('Unlock this object first.');setPreview('parts');
  viewport.beginFaceSnap(({source,target})=>{try{mutate(()=>{const obj=objects().find(x=>x.id===source.id);obj.transform=attachFaces(obj,source,target,.1);});toast('Faces attached with 0.1 mm overlap. Join to make one solid.');status('');}catch(error){showError(error);}});
}
function setMobilePanel(value){$('.workspace').dataset.mobilePanel=value;$$('[data-panel]').forEach(b=>b.classList.toggle('active',b.dataset.panel===value));}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function filename(name=project.name){return name.trim().replace(/[^\p{L}\p{N}\-_ ]/gu,'').replace(/\s+/g,'-').slice(0,80)||'solid-studio-design';}

function modal(title,html,eyebrow='SOLID STUDIO'){$('#modal-title').textContent=title;$('#modal-eyebrow').textContent=eyebrow;$('#modal-content').innerHTML=html;if(!$('#modal').open)$('#modal').showModal();}
function closeModal(){$('#modal').close();}
function confirmAction(title,message,yes='Continue'){
  return new Promise(resolve=>{modal(title,`<p>${esc(message)}</p><div class="modal-actions"><button class="button secondary" data-action="closeModal">Cancel</button><button class="button primary" id="confirm-yes">${esc(yes)}</button></div>`);let accepted=false;$('#confirm-yes').onclick=()=>{accepted=true;closeModal();};$('#modal').addEventListener('close',()=>resolve(accepted),{once:true});});
}
async function newDesign(){
  if(dirty&&!(await confirmAction('Start a new design?','Your current working draft will be replaced. Save it to your server or download its editable project first.','Choose a starting point')))return;
  modal('What will you make?',`<p>Start with a blank workplane or an editable design.</p><div class="starter-grid">${[{key:'blank',name:'Blank workplane',help:'An empty space for your idea',type:'box'},{key:'organiser',name:'Desktop organiser',help:'A tray, a cup and a joined base',type:'tube'},{key:'bracket',name:'Mounting bracket',help:'A functional part with bolt holes',type:'wedge'},{key:'enclosure',name:'Project enclosure',help:'A hollow case with a cable opening',type:'roundedBox'},{key:'stand',name:'Phone stand',help:'An angled support and charging slot',type:'wedge'}].map(s=>`<button class="starter-card" data-starter="${s.key}">${shapeIcon(s.type,COLORS[SHAPES.find(x=>x.type===s.type)?.color||0])}<strong>${s.name}</strong><small>${s.help}</small></button>`).join('')}</div>`,'START A DESIGN');
}
function loadProject(doc,id=null,revision=null){project=validateProject(clone(doc));documentGeneration++;serverId=id;serverRevision=revision;dirty=!id;contextPath=[];selectedIds=project.objects[0]?[project.objects[0].id]:[];history.clear();hasDraft=false;libraryAttempt=null;lastEvaluation=null;fitNext=true;setPreview('parts');renderAll();scheduleBuild();scheduleDraft();}
async function saveProject(copy=false){
  if(saveInFlight){toast('A save is already in progress.');return;}
  const snapshot=clone(project),generation=documentGeneration;saveInFlight=true;
  $$('[data-action=save]').forEach(b=>b.disabled=true);
  try{const result=await api(copy||!serverId?'projects':'projects/'+serverId,{method:copy||!serverId?'POST':'PUT',body:{project:snapshot,...(!copy&&serverId?{expectedRevision:serverRevision}:{})}});
    if(generation!==documentGeneration){toast('Your previous project was saved.');return;}
    serverId=result.project.id;serverRevision=result.project.revision;dirty=JSON.stringify(snapshot)!==JSON.stringify(project);serverConnected=true;await persistDraft();renderSaveStatus();toast(copy?'Saved as a new project.':'Project saved on your server.');return result.project;
  }catch(error){if(error.status===409&&generation===documentGeneration){modal('This project changed elsewhere',`<p>The server has a newer version. Save your current work as a separate project to preserve both versions.</p><div class="modal-actions"><button class="button secondary" data-action="closeModal">Cancel</button><button class="button primary" id="save-copy">Save a copy</button></div>`);$('#save-copy').onclick=async()=>{closeModal();await saveProject(true).catch(showError);};}else throw error;}finally{saveInFlight=false;$$('[data-action=save]').forEach(b=>b.disabled=false);}
}
async function projectsDialog(){
  modal('Your projects','<p>Loading projects from your server…</p>','SAVED ON YOUR SERVER');
  try{const result=await api('projects');if(!$('#modal').open||$('#modal-title').textContent!=='Your projects')return;
    $('#modal-content').innerHTML=`<p>Save an editable project to keep every shape, cut and dimension.</p><div id="project-rows">${result.projects.map(p=>`<div class="project-row"><div><strong>${esc(p.name)}</strong><small>${p.objectCount} objects · ${new Date(p.updatedAt).toLocaleString()}</small></div><button class="button secondary" data-open-project="${esc(p.id)}">Open</button><button class="button quiet icon-only" data-delete-project="${esc(p.id)}" data-revision="${p.revision}" aria-label="Delete ${esc(p.name)}">${icon('trash')}</button></div>`).join('')||'<p class="empty-list">No saved projects yet. Use Save when you are ready.</p>'}</div><div class="modal-actions"><button class="button quiet" data-action="downloadProject">${icon('download')}Download editable project</button></div>`;
  }catch(error){$('#modal-content').innerHTML=`<p class="modal-error">${esc(error.message)}</p><button class="button secondary" data-action="downloadProject">Download this project instead</button>`;}
}
async function openProject(id){if(dirty&&!(await confirmAction('Open saved project?','The current working draft will be replaced. Save or download it first if you want to keep it.','Open project')))return;const generation=documentGeneration;const r=await api('projects/'+id);if(generation!==documentGeneration)throw Error('The workspace changed while the project was loading. Open it again when you are ready.');loadProject(r.project.document,r.project.id,r.project.revision);closeModal();toast('Project opened.');}
function downloadProject(){downloadBlob(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),filename()+'.solid.json');toast('Editable project downloaded.');}
async function importFile(file){
  if(!file)return;
  const generation=documentGeneration,contextKey=contextPath.join('/');
  if(/\.json$/i.test(file.name)){
    if(file.size>20*1024*1024)throw Error('Project files must be smaller than 20 MiB.');
    let data;try{data=JSON.parse(await file.text());}catch{throw Error('This file does not contain valid JSON.');}validateProject(data);
    await rpc('evaluate',{project:data,quality:'standard'});
    if(generation!==documentGeneration)throw Error('Your workspace changed during import. Import the file again when you are ready.');
    if(dirty&&!(await confirmAction('Import editable project?','This replaces your current working draft. Save it first if you want to keep it.','Import project')))return;
    loadProject(data);toast('Editable project imported.');
  }else if(/\.stl$/i.test(file.name)){
    if(file.size>40*1024*1024)throw Error('STL files must be smaller than 40 MiB.');
    status('Checking the imported STL…');
    try{const mesh=await rpc('import',{buffer:await file.arrayBuffer()}),d=dimensions(mesh.bounds),centre=mesh.bounds.min.map((v,i)=>(v+mesh.bounds.max[i])/2),positions=Array.from(mesh.positions,(v,i)=>v-centre[i%3]);
      if(generation!==documentGeneration||contextKey!==contextPath.join('/'))throw Error('Your workspace changed during import. Import the STL again in the intended project.');
      const n=makeNode('mesh',{name:file.name.replace(/\.stl$/i,'').slice(0,100)||'Imported STL',params:{positions,indices:Array.from(mesh.indices),width:d[0],depth:d[1],height:d[2]},transform:{position:[0,0,d[2]/2]},color:COLORS[2]});
      mutate(()=>{objects().push(n);selectedIds=[n.id];},{fit:true});setPreview('parts');toast('STL imported as an editable mesh object.');
    }finally{status('');}
  }else throw Error('Choose a .stl or .solid.json file.');
}
function alignmentDialog(){
  requireCurrentGeometry();const list=selected();if(list.length<2)throw Error('Select at least two objects to align.');
  modal('Align objects',`<p>Keep <strong>${esc(list[0].name)}</strong> in place and align the other selections to it.</p><div class="align-grid"><span></span><span class="small-muted">Minimum</span><span class="small-muted">Centre</span><span class="small-muted">Maximum</span>${['X','Y','Z'].map((a,i)=>`<span class="axis-label">${a}</span>${['min','center','max'].map(e=>`<button class="button secondary" data-align="${i},${e}">${e==='center'?'Centre':e==='min'?'Min':'Max'} ${a}</button>`).join('')}`).join('')}</div><p class="field-help">Alignment uses the outside bounds, including rotations. Click another option to align on more than one axis.</p><div class="modal-actions"><button class="button primary" data-action="closeModal">Done</button></div>`);
}
async function fitHoleDialog(){
  const source=clone(selected()[0]);
  if(!source)throw Error('Select the shape you want to fit first.');
  if(source.locked)throw Error('Unlock the shape before fitting it.');
  const targets=collectFitTargets(objects(),{excludeIds:[source.id],combineOperation:currentGroup()?.operation});
  if(!targets.length){
    modal('Fit to hole',`<p>Select the part you want to resize, then choose a hole, a saved subtraction cutout, or the bore of a tube.</p><p>There are no other openings in this editing context yet. Add a cutting shape and set it to <strong>Hole</strong>, or create a body with <strong>Subtract</strong>.</p><p class="field-help">Openings in imported STL meshes do not have editable cutting shapes. Use exact dimensions for those.</p><div class="modal-actions"><button class="button primary" data-action="closeModal">Done</button></div>`);return;
  }
  const preferred=targets.find(t=>selectedIds.slice(1).some(id=>id===t.sourceId||id===t.ownerId))||targets[0];
  const generation=documentGeneration,contextKey=contextPath.join('/'),snapshot=JSON.stringify(project);
  let request=0,candidate=null;
  const cache=new Map();
  modal('Fit to hole',`<p>Resize <strong>${esc(source.name)}</strong> to an opening, with room for the printed part to fit.</p><label class="form-field"><span>Opening</span><select class="field-input" id="fit-opening">${targets.map(t=>`<option value="${esc(t.key)}" ${t.key===preferred.key?'selected':''}>${esc(t.label)}${t.hidden?' · hidden':''}</option>`).join('')}</select></label><div class="fit-options"><label class="form-field"><span>Fit dimensions</span><select class="field-input" id="fit-axes"><option value="xy">Width and depth</option><option value="xyz">Width, depth and height</option></select></label><label class="form-field"><span>Scaling</span><select class="field-input" id="fit-mode"><option value="stretch">Match opening dimensions</option><option value="uniform">Keep proportions</option></select></label></div><label class="form-field"><span>Clearance on each side <small>mm</small></span><input class="field-input" id="fit-clearance" aria-label="Clearance on each side" type="number" value="0.2" min="0" step="0.05"></label><p class="field-help">For example, 0.2 mm clearance makes a matching part 0.4 mm smaller across the opening. Actual print fit depends on your printer and material.</p><div class="fit-placement"><label class="checkbox-line"><input type="checkbox" id="fit-place" checked>Centre in hole</label><button class="button secondary" id="fit-exact" title="Match all three dimensions, centre the shape and use zero clearance">Fill exactly</button></div><p class="field-help" id="fit-place-note"></p><div id="fit-feedback" role="status" aria-live="polite"></div><div class="modal-actions"><button class="button secondary" data-action="closeModal">Cancel</button><button class="button primary" id="fit-apply" disabled>Apply fit</button></div>`,'PRECISION FIT');
  const dialogToken={};$('#fit-apply').fitDialogToken=dialogToken;
  const isCurrent=()=>$('#modal').open&&$('#fit-apply')?.fitDialogToken===dialogToken;
  const measure=async target=>{
    if(!cache.has(target.key)){
      const a=freshClone(source);a.transform=identity();a.role='solid';a.visible=true;
      const b=freshClone(target.node);b.transform=identity();b.role='solid';b.visible=true;
      const doc=blankProject('Fit measurements');doc.objects=[a,b];
      cache.set(target.key,rpc('evaluate',{project:doc,quality:'fine'}).then(result=>{
        const sourceBounds=result.meshes.find(m=>m.id===a.id)?.bounds,targetBounds=result.meshes.find(m=>m.id===b.id)?.bounds;
        if(!sourceBounds||!targetBounds)throw Error('The selected shape or opening has no remaining volume. Remove its plane cut or choose another opening.');
        return{sourceBounds,targetBounds};
      }));
    }
    return cache.get(target.key);
  };
  const update=async()=>{
    const serial=++request,target=targets.find(t=>t.key===$('#fit-opening').value);candidate=null;$('#fit-apply').disabled=true;
    const restrictedContext=['difference','intersection'].includes(currentGroup()?.operation),place=$('#fit-place');place.disabled=restrictedContext;if(restrictedContext)place.checked=false;
    $('#fit-place-note').textContent=restrictedContext?'Return to the whole design to centre a separate insert in this opening. You can resize this source part here.':'Centring aligns the part with the opening on all three axes. Turn it off to keep the resized part at its current position.';
    $('#fit-exact').disabled=restrictedContext;
    $('#fit-feedback').innerHTML='<p class="field-help">Measuring the shape and opening…</p>';
    try{
      const clearance=Number($('#fit-clearance').value),axes=$('#fit-axes').value,scaling=$('#fit-mode').value,placeInside=place.checked;
      if(!$('#fit-clearance').value.trim()||!Number.isFinite(clearance)||clearance<0)throw Error('Enter a nonnegative clearance in millimetres.');
      const bounds=await measure(target);
      if(serial!==request||!isCurrent())return;
      const fitted=fitNodeToTarget(source,bounds.sourceBounds,target,bounds.targetBounds,{clearance,axes,mode:scaling});
      candidate=applyFittedNode(objects(),source.id,target,fitted,{placeInside,combineOperation:currentGroup()?.operation});
      $('#fit-place-note').textContent=restrictedContext?'Return to the whole design to centre a separate insert. This source part will be resized in place.':candidate.message;
      $('#fit-feedback').innerHTML=`<div class="fit-measurements"><div><span>Opening</span><strong>${fitted.targetDimensions.map(fmt).join(' × ')} mm</strong></div><div><span>Fitted shape</span><strong>${fitted.dimensions.map(fmt).join(' × ')} mm</strong></div>${placeInside?`<div><span>New position · X / Y / Z</span><strong>${fitted.transform.position.map(fmt).join(' / ')} mm</strong></div>`:''}</div>${fitted.profileWarning?`<p class="limit-note">${esc(fitted.profileWarning)}</p>`:''}<p class="field-help">Measured along the opening’s axes.${axes==='xy'?' Height stays unchanged.':''}${scaling==='uniform'?' The tighter dimension controls the fit.':''}${clearance===0?' Zero clearance gives an exact fill when the profiles match.':''}</p>`;
      $('#fit-apply').textContent=placeInside?'Fit and centre':'Resize shape';
      $('#fit-apply').disabled=false;
    }catch(error){if(serial!==request||!isCurrent())return;$('#fit-feedback').innerHTML=`<p class="modal-error">${esc(error.message)}</p>`;}
  };
  for(const id of ['fit-opening','fit-axes','fit-mode','fit-clearance','fit-place'])$('#'+id).addEventListener('change',update);
  $('#fit-exact').onclick=()=>{$('#fit-axes').value='xyz';$('#fit-mode').value='stretch';$('#fit-clearance').value='0';$('#fit-place').checked=true;update();};
  $('#fit-apply').onclick=()=>{try{
    if(!candidate)return;
    if(generation!==documentGeneration||contextKey!==contextPath.join('/')||snapshot!==JSON.stringify(project))throw Error('The design changed while fitting. Close this dialog and start Fit to hole again.');
    const result=candidate;mutate(()=>{const n=objects().find(x=>x.id===source.id);if(!n||n.locked)throw Error('The selected shape is no longer editable.');const group=currentGroup();if(group)group.children=clone(result.objects);else project.objects=clone(result.objects);selectedIds=[result.selectedId];},{fit:true});
    closeModal();setPreview('parts');toast(result.placement==='centred'?'Shape resized and centred in the opening. Undo restores the whole change.':'Shape resized at its existing position.');
  }catch(error){showError(error);}};
  await update();
}
function arrayDialog(){
  const n=single();if(!n)throw Error('Select one object to repeat.');
  modal('Repeat object',`<p>Make independent, editable copies of <strong>${esc(n.name)}</strong>.</p><label class="form-field"><span>Arrangement</span><select class="field-input" id="array-mode"><option value="linear">Linear</option><option value="radial">Circular around Z</option></select></label><div class="field-grid"><label class="number-field"><span>Total objects</span><input id="array-count" type="number" min="2" max="64" step="1" value="4"></label><label class="number-field" id="spacing-label"><span>Spacing (mm)</span><input id="array-spacing" type="number" value="35" min="0.1" step="1"></label><label class="number-field"><span id="axis-label">Direction</span><select class="field-input" id="array-axis"><option value="0">X</option><option value="1">Y</option><option value="2">Z</option></select></label></div><div id="radial-options" hidden><label class="checkbox-line"><input id="array-rotate" type="checkbox" checked>Rotate each copy around the circle</label><p class="field-help">The selected object stays at its current position. The circle centre is one radius to its left along X.</p></div><div class="modal-actions"><button class="button secondary" data-action="closeModal">Cancel</button><button class="button primary" id="create-array">Create copies</button></div>`);
  $('#array-mode').onchange=()=>{const radial=$('#array-mode').value==='radial';$('#spacing-label>span').textContent=radial?'Radius (mm)':'Spacing (mm)';$('#radial-options').hidden=!radial;$('#array-axis').disabled=radial;};
  $('#create-array').onclick=()=>{try{const count=Number($('#array-count').value),spacing=Number($('#array-spacing').value);if(!Number.isInteger(count)||count<2||count>64||!Number.isFinite(spacing)||spacing<=0)throw Error('Use 2–64 objects and a positive spacing or radius.');const copies=createArray(n,{mode:$('#array-mode').value,count,spacing,radius:spacing,axis:Number($('#array-axis').value),rotate:$('#array-rotate').checked});mutate(()=>{objects().push(...copies);selectedIds=[n.id,...copies.map(x=>x.id)];},{fit:true});closeModal();toast(`${copies.length} editable copies created.`);}catch(error){showError(error);}};
}
async function exportDialog(toLibrary=false){
  if(!project.objects.some(n=>n.visible&&n.role==='solid'))throw Error('Add a visible solid before exporting.');
  try{serverSettings=await api('settings');}catch{}
  let exporting=false;
  modal('Export your design',`<div class="export-preview"><strong>${esc(project.name)}</strong><p>Combined solid · STL in millimetres</p></div><label class="form-field"><span>Destination</span><select id="export-destination" class="field-input" aria-label="Export destination"><option value="download" ${toLibrary?'':'selected'}>Download STL</option><option value="library" ${toLibrary?'selected':''}>Layer Library</option></select></label><div id="export-library-details" class="export-library-details" ${toLibrary?'':'hidden'}><p id="export-library-address"></p><button class="button secondary" id="configure-export-library">Configure Layer Library</button></div><label class="form-field"><span>Surface detail</span><select id="export-quality" class="field-input"><option value="fine">Fine · smoother curves</option><option value="standard">Standard · smaller file</option></select></label><label class="form-field"><span>Objects</span><select id="export-scope" class="field-input"><option value="all">Whole design</option>${selectedIds.length&&!currentGroup()?'<option value="selected">Selected objects only</option>':''}</select></label><p>Solid objects are joined and holes are subtracted from the exported mesh. The editable project keeps all of your original parts.</p><p class="muted-note">STL stores geometry only. Preview colours are not included. Check orientation, wall thickness, supports and material settings in your slicer.</p><div id="export-feedback" role="status"></div><div class="modal-actions"><button class="button quiet" data-action="downloadProject">${icon('save')}Save project file</button><button class="button primary" id="export-now"></button></div>`,'READY TO MAKE');
  const destination=$('#export-destination'),button=$('#export-now'),feedback=$('#export-feedback'),qualityControl=$('#export-quality'),scopeControl=$('#export-scope'),configure=$('#configure-export-library');
  const current=()=>$('#modal').open&&$('#export-now')===button;
  const updateDestination=()=>{
    if(!current())return;
    const library=destination.value==='library',connected=Boolean(serverSettings.layerLibraryUrl);
    $('#export-library-details').hidden=!library;
    $('#export-library-address').textContent=connected?'Send to '+serverSettings.layerLibraryUrl+' · Solid Studio collection':'Add your Layer Library address once to send models directly from this studio.';
    configure.textContent=connected?'Change connection':'Configure Layer Library';
    button.innerHTML=icon(library?'library':'download')+(library?'Send to Layer Library':'Download STL');
    button.disabled=exporting||(library&&!connected);
  };
  destination.onchange=()=>{feedback.textContent='';updateDestination();};
  configure.onclick=()=>settingsDialog({onSaved:()=>exportDialog(true)}).catch(showError);
  button.onclick=async()=>{
    if(exporting||librarySaving){toast('An export is already in progress.');return;}
    const library=destination.value==='library',libraryUrl=serverSettings.layerLibraryUrl;
    if(library&&!libraryUrl){updateDestination();return;}
    exporting=true;if(library)librarySaving=true;
    for(const control of [button,destination,qualityControl,scopeControl,configure])control.disabled=true;
    feedback.innerHTML='<p>Building the final solid…</p>';
    const snapshot=clone(project),quality=qualityControl.value,selectionScope=scopeControl.value==='selected'&&!currentGroup();
    if(selectionScope){snapshot.objects=clone(selected());delete snapshot.combineOperation;}
    try{const output=await rpc('export',{project:snapshot,quality});
      if(!output.buffer.byteLength||!output.stats.triangles)throw Error('The selected objects do not contain any solid material.');
      if(library){
        const key=JSON.stringify({snapshot,quality,libraryUrl});if(libraryAttempt?.key!==key)libraryAttempt={key,id:uid()};
        feedback.innerHTML='<p>Sending STL to your library…</p>';
        const result=await api('library/export',{method:'POST',body:{name:snapshot.name,stlBase64:bytesToBase64(output.buffer),project:snapshot,requestId:libraryAttempt.id,expectedLibraryUrl:libraryUrl}});
        feedback.innerHTML=`<p>${esc(result.message||'Saved to Layer Library.')}</p>${result.warning?`<p class="limit-note">${esc(result.warning)}</p>`:''}<a class="button secondary" href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">Open Layer Library</a>`;
        toast(result.reused?'This STL is already in Layer Library.':'STL sent to Layer Library.');
      }else{
        downloadBlob(new Blob([output.buffer],{type:'model/stl'}),filename(snapshot.name)+'.stl');
        feedback.innerHTML=`<p>${output.stats.triangles.toLocaleString()} triangles · ${fmt(output.stats.volume/1000)} cm³ · ${output.stats.components} ${output.stats.components===1?'connected part':'separate parts'}.</p>`;toast('STL downloaded.');
      }
    }catch(error){feedback.innerHTML=`<p class="modal-error">${esc(error.message)}</p>`;}
    finally{exporting=false;if(library)librarySaving=false;for(const control of [destination,qualityControl,scopeControl,configure])control.disabled=false;updateDestination();}
  };
  updateDestination();
}
async function settingsDialog({onSaved}={}){
  try{serverSettings=await api('settings');}catch{}
  modal('Studio settings',`<h3>Workspace</h3><div class="field-grid"><label class="number-field"><span>Build volume (mm)</span><input id="setting-bed" type="number" min="20" max="2000" value="${project.settings.gridSize}"></label><label class="number-field"><span>Rotation snap (°)</span><input id="setting-angle" type="number" min="1" max="180" value="${project.settings.angleSnap}"></label></div><h3>Appearance</h3><div class="view-display-buttons">${['solid','wire','xray'].map(x=>`<button class="button ${displayMode===x?'primary':'secondary'}" data-display="${x}">${x==='xray'?'X-ray':x==='wire'?'Wireframe':'Solid'}</button>`).join('')}</div><h3>Layer Library</h3><label class="form-field"><span>Your library address</span><input id="setting-library" class="field-input" type="url" value="${esc(serverSettings.layerLibraryUrl)}" placeholder="http://your-nas:8777"></label><p class="field-help">Optional. Use a LAN address reachable from this server. Leave it empty to keep this studio independent.</p><div id="settings-feedback" role="status"></div><div class="modal-actions"><button class="button quiet" id="test-library">Test connection</button><button class="button primary" id="save-settings">Save settings</button></div><p class="version-label">Solid Studio ${esc(serverSettings.version||'1.2.0')} · No account or cloud connection needed</p>`);
  $('#save-settings').onclick=async()=>{try{const bed=Number($('#setting-bed').value),angle=Number($('#setting-angle').value),url=$('#setting-library').value.trim();if(bed<20||bed>2000||angle<1||angle>180)throw Error('Use a 20–2000 mm build volume and a 1–180° rotation snap.');serverSettings=await api('settings',{method:'PUT',body:{layerLibraryUrl:url}});mutate(()=>{project.settings.gridSize=bed;project.settings.angleSnap=angle;});closeModal();toast('Settings saved.');if(onSaved)await onSaved();}catch(error){const feedback=$('#settings-feedback');if(feedback)feedback.innerHTML=`<p class="modal-error">${esc(error.message)}</p>`;else showError(error);}};
  $('#test-library').onclick=async()=>{try{serverSettings=await api('settings',{method:'PUT',body:{layerLibraryUrl:$('#setting-library').value.trim()}});const result=await api('library/test',{method:'POST',body:{}});$('#settings-feedback').innerHTML=`<p>${esc(result.message)}</p>`;}catch(error){$('#settings-feedback').innerHTML=`<p class="modal-error">${esc(error.message)}</p>`;}};
}
function helpDialog(){modal('A small studio. Real solids.',`<ol class="help-steps"><li><strong>Add and shape.</strong> Choose a primitive, then type exact dimensions, position and rotation. Drag the coloured handles to move, rotate or scale it.</li><li><strong>Attach parts.</strong> Select an object and choose Face snap. Click its attachment face, then a face on the other object. The faces align with 0.1 mm overlap.</li><li><strong>Join or cut.</strong> Shift-click objects, then Join, Subtract or Intersect. Subtract keeps your first selected object as its base. Use Edit source parts to change a combined object later.</li><li><strong>Use negative shapes.</strong> Change any root object to Hole. It removes material from every visible solid it overlaps. Print result shows the finished shape.</li><li><strong>Fit a part to an opening.</strong> Select the part, then Fit to hole. Choose the opening, clearance and scaling mode. The part centres in the opening by default. Fill exactly uses all three dimensions and zero clearance for matching profiles. Turn off Centre in hole to resize at its existing position.</li><li><strong>Cut at the build plane.</strong> Cut below plane removes everything below Z = 0 across the design and closes the cut faces. Undo restores the previous design. Cuts remain attached to each object.</li><li><strong>Shape capsule ends.</strong> Top and bottom curvature are independent: 0 is flat, 1 is rounded and 2 is elongated.</li><li><strong>Save and print.</strong> Save keeps an editable project on your server. Export STL makes the final solid for your slicer.</li></ol><h3>Shortcuts</h3><div class="shortcut-list">${[['Move','W'],['Rotate','E'],['Scale','R'],['Fit view','F'],['Duplicate','Ctrl / ⌘ D'],['Undo','Ctrl / ⌘ Z'],['Redo','Ctrl / ⌘ Shift Z'],['Save project','Ctrl / ⌘ S'],['Select all','Ctrl / ⌘ A'],['Delete','Delete'],['Cancel / deselect','Esc'],['Multi-select','Shift click']].map(([k,v])=>`<div><span>${k}</span><kbd>${v}</kbd></div>`).join('')}</div><h3>Keep the editable version</h3><p>An STL contains a finished mesh. Download the .solid.json project as well if you want to retain dimensions and source parts. Imported STLs can be moved, scaled, joined and cut, but do not recover the original CAD features.</p><p class="muted-note">Desktop and a mouse give you the most precise controls. Use a recent browser with WebAssembly. WebGL 2 gives the fastest view; a software preview is available when WebGL cannot start. This is a solid modeller; use your slicer to prepare the actual print.</p>`,'MAKE SOMETHING USEFUL');}

const actions={
  new:newDesign,projects:projectsDialog,import:()=>$('#file-import').click(),save:()=>saveProject(),export:()=>exportDialog(),library:()=>exportDialog(true),
  help:helpDialog,settings:settingsDialog,closeModal,downloadProject,undo,redo,duplicate,delete:deleteSelection,drop:dropToBed,faceSnap:startFaceSnap,align:alignmentDialog,fitHole:fitHoleDialog,cutPlane:cutAtBuildPlane,array:arrayDialog,ungroup,
  removeCuts:()=>mutate(()=>{const n=single();if(n&&!n.locked)delete n.clipPlanes;}),
  selectAll:()=>setSelection(objects().map(n=>n.id)),fit:()=>viewport?.fit(selectedIds.length>0),exitGroup,
  toggleLock:()=>mutate(()=>{const n=single();if(n)n.locked=!n.locked;}),
  toggleSnap:()=>mutate(()=>project.settings.snapEnabled=!project.settings.snapEnabled),
  toggleGrid:()=>mutate(()=>project.settings.showGrid=!project.settings.showGrid)
};
document.addEventListener('click',async event=>{
  const b=event.target.closest('button,a[data-action]');if(!b||b.disabled)return;
  try{
    if(b.dataset.action){event.preventDefault();await actions[b.dataset.action]?.();}
    else if(b.dataset.add)addShape(b.dataset.add);
    else if(b.dataset.mode){mode=b.dataset.mode;viewport?.setMode(mode);$$('[data-mode]').forEach(x=>{x.classList.toggle('active',x.dataset.mode===mode);x.setAttribute('aria-pressed',String(x.dataset.mode===mode));});}
    else if(b.dataset.op)combine(b.dataset.op);
    else if(b.dataset.enter)enterGroup(b.dataset.enter);
    else if(b.dataset.visible)mutate(()=>{const n=objects().find(x=>x.id===b.dataset.visible);if(n.locked)throw Error('Unlock this object to change visibility.');n.visible=!n.visible;});
    else if(b.dataset.role)mutate(()=>{const n=single();if(n&&!n.locked)n.role=b.dataset.role;});
    else if(b.dataset.color)mutate(()=>{const n=single();if(n&&!n.locked)n.color=b.dataset.color;});
    else if(b.dataset.mirror!==undefined)mutate(()=>{const n=single();if(n&&!n.locked)n.transform.scale[Number(b.dataset.mirror)]*=-1;});
    else if(b.dataset.preview)setPreview(b.dataset.preview);
    else if(b.dataset.panel)setMobilePanel(b.dataset.panel);
    else if(b.dataset.starter){loadProject(starterProject(b.dataset.starter));closeModal();}
    else if(b.dataset.align){requireCurrentGeometry();const[a,e]=b.dataset.align.split(',');mutate(()=>alignObjects(objects(),selectedIds,Number(a),e,id=>viewport?.getBounds(id)));}
    else if(b.dataset.openProject)await openProject(b.dataset.openProject);
    else if(b.dataset.deleteProject){const id=b.dataset.deleteProject,rev=Number(b.dataset.revision);if(await confirmAction('Delete saved project?','This removes the saved project from the server. Download an editable copy first if you need it.','Delete project')){await api('projects/'+id,{method:'DELETE',body:{expectedRevision:rev}});if(serverId===id){serverId=null;serverRevision=null;dirty=true;await persistDraft();}await projectsDialog();}}
    else if(b.dataset.display){displayMode=b.dataset.display;viewport?.setDisplayMode(displayMode);$$('[data-display]').forEach(x=>{x.classList.toggle('primary',x.dataset.display===displayMode);x.classList.toggle('secondary',x.dataset.display!==displayMode);});}
  }catch(error){showError(error);}
});
$('#object-list').addEventListener('click',event=>{if(event.target.closest('button'))return;const row=event.target.closest('[data-select]');if(row)selectObject(row.dataset.select,event.shiftKey||event.ctrlKey||event.metaKey);});
$('#object-list').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){const row=event.target.closest('[data-select]');if(row){event.preventDefault();selectObject(row.dataset.select,event.shiftKey);}}});
document.addEventListener('change',event=>{
  const el=event.target;try{
    if(el.id==='project-name'){const name=el.value.trim()||'Untitled design';mutate(()=>project.name=name);}
    else if(el.id==='object-name')mutate(()=>{const n=single();if(n&&!n.locked)n.name=el.value.trim()||n.name;});
    else if(el.id==='group-operation')mutate(()=>{const n=single();if(n?.type==='boolean'&&!n.locked)n.operation=el.value;});
    else if(el.id==='grid-snap')mutate(()=>project.settings.gridSnap=Number(el.value));
    else if(el.id==='camera-view')viewport?.setView(el.value);
    else if(el.matches('[data-param],[data-position],[data-rotation],[data-scale]')){
      const n=single(),value=Number(el.value);if(!n||n.locked)return;if(el.value.trim()===''||!Number.isFinite(value))throw Error('Enter a valid number.');
      mutate(()=>{if(el.dataset.param)n.params[el.dataset.param]=value;else for(const kind of ['position','rotation','scale'])if(el.dataset[kind]!==undefined)n.transform[kind][Number(el.dataset[kind])]=value;});
    }
  }catch(error){renderInspector();showError(error);}
});
$('#shape-search').addEventListener('input',renderPalette);
$('#file-import').addEventListener('change',event=>{const file=event.target.files[0];event.target.value='';importFile(file).catch(showError);});
document.addEventListener('keydown',event=>{
  const typing=event.target.closest('input,textarea,select,[contenteditable=true]');
  if(typing)return;
  const key=event.key.toLowerCase(),cmd=event.ctrlKey||event.metaKey;
  if($('#modal').open)return;
  let action;
  if(cmd&&key==='z')action=event.shiftKey?'redo':'undo';else if(cmd&&key==='y')action='redo';else if(cmd&&key==='s')action='save';else if(cmd&&key==='d')action='duplicate';else if(cmd&&key==='a')action='selectAll';else if(key==='delete'||key==='backspace')action='delete';else if(key==='f')action='fit';
  if(action){event.preventDefault();Promise.resolve().then(()=>actions[action]()).catch(showError);}
  else if(['w','e','r'].includes(key)&&!cmd){const m={w:'translate',e:'rotate',r:'scale'}[key];$(`[data-mode=${m}]`).click();}
  else if(key==='escape'){viewport?.cancelFaceSnap();status('');setSelection([]);}
});
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')persistDraft();});

async function init(){
  const saved=await readDraft();
  if(saved?.project)try{project=validateProject(saved.project);serverId=saved.serverId||null;serverRevision=saved.serverRevision||null;dirty=saved.dirty!==false;hasDraft=true;}catch{toast('The previous browser draft could not be read. A fresh workspace is open.',true);}
  selectedIds=project.objects.length?[project.objects[Math.min(1,project.objects.length-1)].id]:[];
  const callbacks={
    onSelect:selectObject,
    onTransformStart:()=>{gestureBefore=evaluatedSerial===buildSerial?JSON.stringify(project):null;},
    onTransform:(id,t,final)=>{const n=objects().find(x=>x.id===id);if(!n||n.locked)return;n.transform=t;if(final){const before=gestureBefore;gestureBefore=null;if(before){try{validateProject(project);changed(before);}catch(error){project=JSON.parse(before);renderAll();scheduleBuild();showError(error);}}}else{for(const k of ['position','rotation','scale'])t[k].forEach((v,i)=>{const input=$(`[data-${k}="${i}"]`);if(input)input.value=round(v,3);});}},
    onStatus:status
  };
  try{viewport=new Viewport($('#viewport'),callbacks);}
  catch(webglError){
    try{viewport=new SoftwareViewport($('#viewport'),callbacks);const badge=document.createElement('span');badge.className='software-badge';badge.textContent='Software 3D preview';badge.title='WebGL is unavailable in this browser. Solid calculations and STL quality are unchanged.';$('#viewport').append(badge);}
    catch(error){rendererError=error.message;$('#geometry-error').textContent=error.message;$('#geometry-error').hidden=false;toast(error.message,true);}
  }
  renderPalette();renderAll();if(innerWidth<=510)setMobilePanel('canvas');
  scheduleBuild();
  Promise.all([api('health'),api('settings')]).then(([,settings])=>{serverConnected=true;serverSettings=settings;renderSaveStatus();}).catch(()=>{serverConnected=false;toast('The server is unavailable. You can still download your project and STL.',true);});
}
init().catch(error=>{$('#loading-state').hidden=true;$('#geometry-error').hidden=false;$('#geometry-error').textContent=error.message;});
