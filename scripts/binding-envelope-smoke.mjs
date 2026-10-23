import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repairBindingInstruction } from './repair-binding-envelope.mjs';
import { withPrimaryBindingContent } from '../dist/bindingContent.js';
import { responseBindingInstruction } from '../dist/bindingMarker.js';

const source = fs.readFileSync(new URL('../dist/server.js', import.meta.url), 'utf8');
const start = source.indexOf('function tagToolResult(');
const end = source.indexOf('function toolCardMeta', start);
assert.ok(start >= 0 && end > start);
const tag = source.slice(start, end);
const marker = 'cpb2_0123456789abcdef01234567';
const instruction = responseBindingInstruction(marker);
for (const confirmed of [false, true]) {
  for (const input of [
    { content: [{type:'text',text:'{"ok":true}'}], structuredContent:{ok:true} },
    { content: [{type:'text',text:'plain result'}] },
    { content: [{type:'text',text:'[1,2]'}] },
    { content: [{type:'text',text:'42'}] },
    { content: [], isError:true },
    { content: [{type:'image',data:'synthetic',mimeType:'image/png'}] }
  ]) {
    const context = {
      input: structuredClone(input), confirmed, withPrimaryBindingContent,
      requestCorrelationSnapshot:()=>({}), bindingMarkerFromCorrelation:()=>undefined,
      responseBindingConfirmedFromCorrelation:()=>confirmed,
      responseBindingMarkerFromCorrelation:()=>marker, responseBindingInstruction,
      compactStructuredContent:x=>x, recordBindingEmission:()=>{}, redactAbsolutePaths:()=>{}
    };
    const result = vm.runInNewContext(tag+'\ntagToolResult(input,"bash",{}, {exposeAbsolutePaths:true});', context, {timeout:1000});
    assert.equal(result.structuredContent.codexpro_response_binding_marker, confirmed ? undefined : marker);
    assert.equal(result.structuredContent.codexpro_response_binding_instruction, confirmed ? undefined : instruction);
    assert.equal(result.content.some(x=>x.type==='text'&&x.text===instruction), !confirmed);
    if(input.isError) assert.equal(result.isError,true);
  }
}
const older = 'function tagToolResult(result) { const responseMarker="test"; result.structuredContent={...(responseMarker ? { codexpro_response_binding_marker: responseMarker } : {})}; result.content=[{text:responseBindingInstruction(responseMarker)}]; return result; }\nfunction toolCardMeta() {}';
const repaired = repairBindingInstruction(older);
assert.equal(repairBindingInstruction(repaired),repaired,'repair must be idempotent');
assert.equal(repairBindingInstruction(source),source,'current implementation must stay unchanged');
assert.throws(()=>repairBindingInstruction('unrelated source'),/boundaries/);
const actual = vm.runInNewContext(repaired+'\ntagToolResult({});',{responseBindingInstruction:x=>'instruction:'+x});
assert.equal(actual.structuredContent.codexpro_response_binding_instruction,'instruction:test');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-envelope-'));
try {
  const file = path.join(temporary, 'server.mjs');
  fs.writeFileSync(file, older);
  const hash = text => createHash('sha256').update(text).digest('hex');
  const run = (expected, mode) => spawnSync(process.execPath,
    [fileURLToPath(new URL('./repair-binding-envelope.mjs', import.meta.url)), file, expected, mode], {encoding:'utf8'});
  assert.notEqual(run('0'.repeat(64), '--apply').status, 0, 'changed hash must refuse');
  assert.equal(fs.readFileSync(file,'utf8'),older);
  assert.equal(run(hash(older), '--check').status, 0);
  assert.equal(fs.existsSync(file+'.before-envelope-instruction'),false);
  assert.equal(run(hash(older), '--apply').status, 0);
  assert.equal(fs.readFileSync(file,'utf8'),repaired);
  assert.equal(fs.readFileSync(file+'.before-envelope-instruction','utf8'),older);
  assert.equal(run(hash(repaired), '--apply').status, 0, 'already repaired is a no-op');
  fs.writeFileSync(file,older);
  assert.notEqual(run(hash(older), '--apply').status, 0, 'existing backup must refuse');
  assert.equal(fs.readFileSync(file,'utf8'),older);
} finally {
  fs.rmSync(temporary,{recursive:true,force:true});
}
console.log('✓ binding envelope: 12 actual-wrapper cases, legacy repair and refusal checks passed');
