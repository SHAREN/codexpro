import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Older deployed wrappers retained the token but omitted its instruction from
// structuredContent. Repair only that field, without replacing a custom server.
export function repairBindingInstruction(source) {
  const start = source.indexOf('function tagToolResult(');
  const end = source.indexOf('function toolCardMeta', start);
  if (start < 0 || end < start) throw new Error('Unrecognized tagToolResult boundaries');
  const tag = source.slice(start, end);
  if (tag.includes('codexpro_response_binding_instruction:')) return source;
  const field = /codexpro_response_binding_marker: responseMarker(?=\s*})/g;
  if ([...tag.matchAll(field)].length !== 1 || !tag.includes('responseBindingInstruction(responseMarker)')) {
    throw new Error('Unrecognized marker-only envelope; inspect before repair');
  }
  const repaired = tag.replace(field, 'codexpro_response_binding_marker: responseMarker, codexpro_response_binding_instruction: responseBindingInstruction(responseMarker)');
  return source.slice(0, start) + repaired + source.slice(end);
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, expected, mode = '--check'] = process.argv.slice(2);
  if (!file || !/^[a-f0-9]{64}$/.test(expected || '') || !['--check', '--apply'].includes(mode)) {
    throw new Error('Usage: repair-binding-envelope.mjs SERVER_FILE EXPECTED_SHA256 [--check|--apply]');
  }
  const before = fs.readFileSync(file);
  if (sha(before) !== expected) throw new Error('Server hash changed; re-audit before modifying');
  const source = before.toString('utf8');
  const after = repairBindingInstruction(source);
  const changed = after !== source;
  if (changed && mode === '--apply') {
    const backup = file + '.before-envelope-instruction';
    fs.writeFileSync(backup, before, { flag: 'wx' });
    const temporary = file + '.envelope-instruction.tmp';
    fs.writeFileSync(temporary, after, { flag: 'wx', mode: fs.statSync(file).mode });
    fs.renameSync(temporary, file);
  }
  console.log(JSON.stringify({ changed, applied: changed && mode === '--apply', before: sha(before), after: sha(after) }));
}
