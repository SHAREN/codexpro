import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { WorkspaceManager, PathGuard } from '../dist/guard.js';
import { editTextFile, writeTextFile } from '../dist/fsOps.js';
import { hasNewSecretValue, hasSecretValue } from '../dist/redact.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-secret-delta-'));
try {
  const config = loadConfig(['--root', tmp, '--bash', 'off', '--write', 'workspace']);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  const guard = new PathGuard(config);
  const existing = ['sk', 'a'.repeat(22)].join('-');
  const fresh = ['sk', 'b'.repeat(22)].join('-');
  const before = ['fixture', existing, 'change-this'].join('\n');
  const filename = 'fixture.txt';
  await fs.writeFile(path.join(tmp, filename), before, 'utf8');
  assert(hasSecretValue(before), 'fixture must reproduce the original rejection');
  assert.equal(hasNewSecretValue(before, before.replace('change-this', 'updated')), false);
  assert.equal(hasNewSecretValue(before, before + '\n' + fresh), true);
  assert.equal(hasNewSecretValue(before, before + '\n' + existing), true);
  assert.equal(hasNewSecretValue('Authorization: Bearer ', 'Authorization: Bearer ' + 'c'.repeat(24)), true);
  const result = await editTextFile(config, guard, workspace, filename, 'change-this', 'updated');
  assert.equal(result.replacements, 1);
  const after = await fs.readFile(path.join(tmp, filename), 'utf8');
  assert(after.endsWith('updated'));
  await assert.rejects(editTextFile(config, guard, workspace, filename, 'updated', 'updated\n' + fresh), /Secret-looking/);
  await assert.rejects(editTextFile(config, guard, workspace, filename, 'updated', 'updated\n' + existing), /Secret-looking/);
  await assert.rejects(writeTextFile(config, guard, workspace, 'new.txt', 'token ' + fresh), /Secret-looking/);
  assert.equal(await fs.readFile(path.join(tmp, filename), 'utf8'), after);
  console.log('PASS: edit keeps unchanged fixture secrets but rejects new and duplicate values');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
