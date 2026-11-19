import test from 'node:test';
import assert from 'node:assert/strict';
import {blankProject,makeNode,validateProject} from '../static/model.js';

test('imported object IDs cannot introduce HTML attributes or markup',()=>{
  for(const id of ['"><img src=x>',"x' data-action='delete",'spaces are invalid','x'.repeat(129)]){
    const project=blankProject();project.objects=[makeNode('box',{id})];
    assert.throws(()=>validateProject(project),/invalid or duplicate objects/);
  }
  const project=blankProject();project.objects=[makeNode('box',{id:'a'.repeat(128)})];
  assert.equal(validateProject(project).objects[0].id.length,128);
});

test('editable imports cannot open with a name that the server cannot save',()=>{
  for(const name of ['', '   ', '\n\t'])assert.throws(()=>validateProject(blankProject(name)),/Project name/);
  assert.equal(validateProject(blankProject('My bracket')).name,'My bracket');
});
