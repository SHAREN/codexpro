import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cancel-'));
const root = path.join(tmp, 'repo');
await fs.mkdir(root, { recursive: true });
await fs.writeFile(path.join(root, 'AGENTS.md'), 'Cancellation smoke fixture.');
const freePort = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const token = 'test-' + 'x'.repeat(32);
const env = {
  ...process.env,
  CODEXPRO_HOME: path.join(tmp, 'data'),
  CODEXPRO_ROOT: root,
  CODEXPRO_ALLOWED_ROOTS: root,
  CODEXPRO_HOST: '127.0.0.1',
  CODEXPRO_PORT: String(freePort),
  CODEXPRO_HTTP_TOKEN: token,
  CODEXPRO_REQUIRE_HTTP_TOKEN: '1',
  CODEXPRO_BASH_MODE: 'full',
  CODEXPRO_BASH_RUNTIME: process.platform === 'win32' ? 'wsl' : (process.env.CODEXPRO_BASH_RUNTIME || 'auto'),
  CODEXPRO_WRITE_MODE: 'workspace',
  CODEXPRO_TOOL_MODE: 'standard',
  CODEXPRO_TOOL_CARDS: '0',
  CODEXPRO_CONNECTION_TEST: '0',
  CODEXPRO_TOOL_HEARTBEAT_MS: '5000',
  CODEXPRO_INTERACTIVE_BASH_BUDGET_MS: '7000',
  CODEXPRO_MAX_BASH_TIMEOUT_MS: '15000',
  CODEXPRO_LOG_REQUESTS: '0',
  CODEXPRO_LOG_TOOL_CALLS: '0',
  CODEXPRO_TELEMETRY: '0'
};
const base = `http://127.0.0.1:${freePort}`;
const headers = { Authorization: `Bearer ${token}` };
let child;
let client;
let transport;

async function until(fn, predicate, timeout = 15000) {
  const started = Date.now();
  let value;
  do {
    value = await fn();
    if (predicate(value)) return value;
    await delay(50);
  } while (Date.now() - started < timeout);
  throw new Error(`Timed out: ${JSON.stringify(value)}`);
}

async function boot() {
  child = spawn(process.execPath, ['dist/http.js'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(errors);
    try { return (await fetch(`${base}/healthz`, { headers })).ok; } catch { return false; }
  }, Boolean);
}

async function connect() {
  client = new Client({ name: 'cancellation-smoke', version: '1.0' });
  transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
}

async function close() {
  await client?.close().catch(() => undefined);
  client = null;
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}

async function rawDisconnectToolCall(command, id = 9001) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bash', arguments: { command, timeout_ms: 15000 } } });
  await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: freePort,
      path: '/mcp',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': transport.sessionId,
        'MCP-Protocol-Version': '2025-06-18',
        'Content-Length': Buffer.byteLength(body)
      }
    });
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    req.on('response', res => { res.resume(); res.on('end', done); });
    req.on('error', error => {
      if (error.message.includes('intentional disconnect') || error.code === 'ECONNRESET') done();
      else reject(error);
    });
    req.end(body);
    setTimeout(() => req.destroy(new Error('intentional disconnect')), 300).unref();
  });
}

try {
  await boot();
  await connect();

  const cancelMarker = path.join(root, 'cancel-marker.txt');
  const abort = new AbortController();
  const cancelledCall = client.callTool(
    { name: 'bash', arguments: { command: 'sleep 5; printf survived > cancel-marker.txt', timeout_ms: 15000 } },
    undefined,
    { signal: abort.signal, timeout: 10000 }
  );
  setTimeout(() => abort.abort(), 300).unref();
  await assert.rejects(cancelledCall);
  await delay(2200);
  await assert.rejects(fs.stat(cancelMarker), /ENOENT/);

  const progress = [];
  const result = await client.callTool(
    { name: 'bash', arguments: { command: 'sleep 6; printf progress-ok', timeout_ms: 15000 } },
    undefined,
    { timeout: 12000, maxTotalTimeout: 12000, resetTimeoutOnProgress: true, onprogress: value => progress.push(value) }
  );
  assert.equal(result.isError, undefined);
  assert.ok(progress.length >= 1, `expected progress notification, received ${progress.length}`);
  assert.match(JSON.stringify(result), /progress-ok/);
  const transientJobsDir = path.join(env.CODEXPRO_HOME, 'jobs');
  const transientJobFiles = await fs.readdir(transientJobsDir).catch(() => []);
  assert.equal(transientJobFiles.filter(name => name.endsWith('.json')).length, 0, 'short/cancelled request-owned bash jobs must be cleaned up');

  // A command that outlives the interactive budget must return running + job_id
  // without replaying the process. The same job then completes in the background.
  const handoffStarted = Date.now();
  const handedOff = await client.callTool(
    { name: 'bash', arguments: { command: 'sleep 9; printf handoff-ok' } },
    undefined,
    { timeout: 12000, maxTotalTimeout: 12000 }
  );
  assert.equal(handedOff.structuredContent.status, 'running');
  assert.ok(handedOff.structuredContent.job_id);
  assert.ok(Date.now() - handoffStarted < 8500, 'bash should release the MCP turn near the interactive budget');
  const completed = await until(
    async () => (await client.callTool({ name: 'get_job', arguments: { job_id: handedOff.structuredContent.job_id } })).structuredContent,
    job => job.status !== 'running',
    7000
  );
  assert.equal(completed.status, 'completed');
  const handoffLogs = await client.callTool({ name: 'job_logs', arguments: { job_id: handedOff.structuredContent.job_id, offset: 0 } });
  assert.match(handoffLogs.structuredContent.text, /handoff-ok/);
  const durableFiles = await fs.readdir(transientJobsDir);
  assert.ok(durableFiles.includes(`${handedOff.structuredContent.job_id}.json`));
  const removeHandoff = await client.callTool({ name: 'remove_job', arguments: { job_id: handedOff.structuredContent.job_id } });
  assert.equal(removeHandoff.structuredContent.removed, true);

  const disconnectMarker = path.join(root, 'disconnect-marker.txt');
  await rawDisconnectToolCall('sleep 5; printf survived > disconnect-marker.txt');
  await delay(2200);
  await assert.rejects(fs.stat(disconnectMarker), /ENOENT/);

  console.log(`Cancellation smoke passed: request abort reaped bash, ${progress.length} progress notification(s) received, HTTP disconnect reaped bash.`);
} finally {
  await close();
  await fs.rm(tmp, { recursive: true, force: true });
}
