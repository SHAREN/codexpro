import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-platform-toolset-'));
const client = new Client({ name: 'codexpro-platform-toolset-test', version: '1.0.0' }, { capabilities: {} });
let connected = false;
try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/stdio.js', '--root', root, '--allow-root', root, '--bash', 'off', '--write', 'off'],
    cwd: repo
  });
  await client.connect(transport);
  connected = true;
  const result = await client.callTool({
    name: 'codexpro_self_test',
    arguments: { write_probe: false, bash_probe: false, pro_context_probe: false, include_global_skills: false }
  });
  assert.notEqual(result.isError, true);
  const data = result.structuredContent;
  assert.equal(data?.failed, 0, JSON.stringify(data?.checks ?? []));
  assert.deepEqual([...data.expected_tools].sort(), [...data.registered_tools].sort());
  if (process.platform !== 'win32') {
    assert(!data.expected_tools.includes('windows_control'));
    assert(!data.registered_tools.includes('windows_control'));
  }
  const lines = Array.from({ length: 150 }, (_, i) => `record-${i + 1} ${'x'.repeat(50)}`);
  await fs.writeFile(path.join(root, 'large.txt'), lines.join('\n'), 'utf8');
  const first = await client.callTool({
    name: 'read', arguments: { path: 'large.txt', max_bytes: 1500 }
  });
  assert.notEqual(first.isError, true);
  const head = first.structuredContent;
  assert.equal(head?.truncated, true);
  assert(head.endLine > 0 && head.endLine < head.totalLines);
  const continuation = await client.callTool({
    name: 'read',
    arguments: { path: 'large.txt', start_line: head.endLine + 1, max_bytes: 1500 }
  });
  assert.notEqual(continuation.isError, true);
  assert.equal(continuation.structuredContent?.startLine, head.endLine + 1);
  assert.equal(continuation.structuredContent?.sha256, head.sha256);
  console.log('PASS: platform tool set and real MCP read pagination');
} finally {
  if (connected) await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
