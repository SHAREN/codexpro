import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (name) => import(pathToFileURL(path.join(projectRoot, 'dist', name)).href);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-read-bounds-'));

try {
  const [{ loadConfig }, { WorkspaceManager, PathGuard }, { readTextFile }] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('fsOps.js')
  ]);
  const config = loadConfig(['--root', tmp, '--bash', 'off', '--write', 'off']);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  const guard = new PathGuard(config);

  const lines = Array.from({ length: 400 }, (_, i) => `entry-${i + 1} café ${'x'.repeat(85)}`);
  const original = lines.join('\n');
  await fs.writeFile(path.join(tmp, 'large.txt'), original, 'utf8');
  const options = { maxBytes: 600, truncateToFit: true };

  // Non-MCP/internal readers must continue to reject incomplete content.
  await assert.rejects(
    readTextFile(config, guard, workspace, 'large.txt', { maxBytes: options.maxBytes }),
    /File is too large/
  );
  await assert.rejects(
    readTextFile(config, guard, workspace, 'large.txt', {
      startLine: 100, endLine: 300, maxBytes: options.maxBytes
    }),
    /Selected line range is too large/
  );
  const first = await readTextFile(config, guard, workspace, 'large.txt', options);
  assert(first.endLine > 0 && first.endLine < 400);
  assert.equal(first.totalLines, 400);
  assert.equal(first.startLine, 1);
  assert.equal(first.truncated, true);
  assert(Buffer.byteLength(first.text, 'utf8') <= options.maxBytes);
  assert.match(first.text, /entry-1 café/);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert(first.bytes > options.maxBytes);

  const next = await readTextFile(config, guard, workspace, 'large.txt', {
    startLine: first.endLine + 1, maxBytes: options.maxBytes, truncateToFit: true
  });
  assert.equal(next.startLine, first.endLine + 1);
  assert.match(next.text, new RegExp(`entry-${next.startLine} café`));
  assert(Buffer.byteLength(next.text, 'utf8') <= options.maxBytes);

  const ranged = await readTextFile(config, guard, workspace, 'large.txt', {
    startLine: 100, endLine: 300, maxBytes: options.maxBytes, truncateToFit: true
  });
  assert.equal(ranged.startLine, 100);
  assert(ranged.endLine >= 100 && ranged.endLine < 300);
  assert.equal(ranged.truncated, true);
  assert(Buffer.byteLength(ranged.text, 'utf8') <= options.maxBytes);

  const smallRange = await readTextFile(config, guard, workspace, 'large.txt', {
    startLine: 101, endLine: 101, maxBytes: options.maxBytes, truncateToFit: true
  });
  assert.equal(smallRange.endLine, 101);
  assert.match(smallRange.text, /entry-101 café/);

  await fs.writeFile(path.join(tmp, 'small.txt'), 'one\ntwo', 'utf8');
  const small = await readTextFile(config, guard, workspace, 'small.txt', options);
  assert.equal(small.truncated, false);
  assert.equal(small.endLine, 2);

  await fs.writeFile(path.join(tmp, 'single-line.txt'), 'x'.repeat(950), 'utf8');
  await assert.rejects(
    readTextFile(config, guard, workspace, 'single-line.txt', options),
    /Line 1 alone exceeds max_bytes/
  );

  await fs.writeFile(path.join(tmp, 'binary.bin'), Buffer.from([65, 0, 66]));
  await assert.rejects(readTextFile(config, guard, workspace, 'binary.bin', options), /binary/i);

  // Reproduce the actual Home PC incident without exposing file contents.
  const homeRoot = path.dirname(projectRoot);
  const homeConfig = loadConfig(['--root', homeRoot, '--bash', 'off', '--write', 'off']);
  const homeGuard = new PathGuard(homeConfig);
  const homeWorkspace = new WorkspaceManager(homeConfig).defaultWorkspace();
  for (const filename of ['AGENTS.md', 'MCP_SHELL_COMMAND_RUNBOOK.md']) {
    // Local regression fixtures exist on Home PC but not in a clean GitHub CI checkout.
    const stat = await fs.stat(path.join(homeRoot, filename)).catch(() => null);
    if (!stat?.isFile() || stat.size <= 55_000) continue;
    const head = await readTextFile(homeConfig, homeGuard, homeWorkspace, filename, { maxBytes: 55_000, truncateToFit: true });
    assert(head.bytes > 55_000, `fixture unexpectedly small: ${filename}`);
    assert.equal(head.truncated, true);
    assert(head.endLine < head.totalLines);
    assert(Buffer.byteLength(head.text, 'utf8') <= 55_000);
    const continuation = await readTextFile(homeConfig, homeGuard, homeWorkspace, filename, {
      startLine: head.endLine + 1,
      maxBytes: 55_000,
      truncateToFit: true
    });
    assert.equal(continuation.startLine, head.endLine + 1);
    assert.equal(continuation.sha256, head.sha256);
  }

  console.log('PASS: bounded read, line-accurate continuation, UTF-8, binary safeguards, optional real Home PC fixtures');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
