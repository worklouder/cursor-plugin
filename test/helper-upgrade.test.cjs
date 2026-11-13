'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { startServer } = require('../src/helper/server.cjs');
const { Store, readPrivateJson } = require('../src/helper/storage.cjs');
const { ensureHelper, request } = require('../src/helper/client.cjs');
const { VERSION, compareVersions } = require('../src/helper/version.cjs');
process.env.WORKLOUDER_NO_AUTO_AUTHORIZE = '1';
const directories = [];
after(async () => { for (const directory of directories) await fs.rm(directory, { recursive: true, force: true }); });
async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worklouder-upgrade-')); directories.push(directory);
  t.after(async () => {
    const runtime = await readPrivateJson(path.join(directory, 'runtime.json')).catch(() => null);
    if (runtime && runtime.pid !== process.pid) { try { process.kill(runtime.pid, 'SIGTERM'); } catch {} await delay(100); }
  });
  return directory;
}
test('older helper is replaced once across concurrent callers, while saved preferences survive', async (t) => {
  const directory = await temp(t), store = new Store(directory); await store.load();
  await store.update((data) => { data.defaultLayerDecision = 'declined'; data.settings = { brightness: 0.4 }; });
  const old = await startServer({ directory, version: '0.2.2' }); t.after(() => old.close());
  const runtimes = await Promise.all([ensureHelper({ directory }), ensureHelper({ directory }), ensureHelper({ directory })]);
  assert.equal(new Set(runtimes.map((runtime) => runtime.pid)).size, 1);
  assert.notEqual(runtimes[0].pid, process.pid); assert.equal((await request(runtimes[0], '/health')).version, VERSION);
  const saved = await readPrivateJson(path.join(directory, 'state.json'));
  assert.equal(saved.defaultLayerDecision, 'declined'); assert.deepEqual(saved.settings, { brightness: 0.4 });
});
test('a newer compatible helper is reused and cannot be downgraded', async (t) => {
  const directory = await temp(t), server = await startServer({ directory, version: '9.0.0' }); t.after(() => server.close());
  assert.equal((await ensureHelper({ directory })).pid, process.pid);
  await assert.rejects(request(server.runtime, '/upgrade', { version: VERSION }), (error) => error.statusCode === 412);
  assert.equal((await request(server.runtime, '/health')).version, '9.0.0');
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
});
test('upgrades wait for pairing or device writes and preserve credentials when stopping', async (t) => {
  const directory = await temp(t), store = new Store(directory); await store.load();
  const credentials = { applicationId: 'test-only', token: 'test-only' };
  await store.update((data) => { data.credentials = credentials; data.defaultLayerDecision = 'accepted'; });
  const controller = { layerWriting: true, client: { state: 'connected' }, start: async () => {}, stop() {}, status: () => ({}) };
  const server = await startServer({ directory, store, controller, version: '0.2.2' }); t.after(() => server.close());
  await assert.rejects(ensureHelper({ directory, timeout: 150 }), /finishing pairing or a layer write/);
  await assert.rejects(request(server.runtime, '/upgrade', { version: VERSION }), (error) => error.statusCode === 409);
  assert.equal((await request(server.runtime, '/health')).busy, true);
  controller.layerWriting = false; controller.pairing = true;
  await assert.rejects(request(server.runtime, '/upgrade', { version: VERSION }), (error) => error.statusCode === 409);
  controller.pairing = false; await request(server.runtime, '/upgrade', { version: VERSION }); await delay(50);
  const saved = await readPrivateJson(store.file); assert.deepEqual(saved.credentials, credentials); assert.equal(saved.defaultLayerDecision, 'accepted');
});
test('setup opens only on first install and stays closed across helper versions', async (t) => {
  const directory = await temp(t), store = new Store(directory); await store.load();
  await store.update((data) => { data.setupOpened = true; data.defaultLayerDecision = 'declined'; });
  const opened = [], server = await startServer({ directory, store, openUrl: async (url) => opened.push(url) }); t.after(() => server.close());
  const lease = { id: '170298cc-caf4-4cb8-8313-033ddc501722', pid: process.pid };
  await request(server.runtime, '/lease', lease); await request(server.runtime, '/lease', lease);
  assert.equal(opened.length, 0); assert.equal(store.data.setupOpened, true); assert.equal(store.data.defaultLayerDecision, 'declined');
  await request(server.runtime, '/setup-open', {}); await request(server.runtime, '/setup-open', {});
  assert.equal(opened.length, 2, 'each explicit setup request must open the page');
  assert.equal((await request(server.runtime, '/state')).helperVersion, VERSION);
});
test('MCP reconnects automatically after its helper exits', async (t) => {
  const directory = await temp(t), root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, [path.join(root, 'src/entry.cjs'), 'mcp'], { env: { ...process.env, WORKLOUDER_STATE_DIR: directory, WORKLOUDER_NO_OPEN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
  const done = new Promise((resolve) => child.once('exit', resolve)); t.after(async () => { child.stdin.end(); await done; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  let first;
  for (let i = 0; i < 100; i++) { first = await readPrivateJson(path.join(directory, 'runtime.json')).catch(() => null); if (first) break; await delay(50); }
  assert.ok(first); process.kill(first.pid, 'SIGTERM');
  let next;
  for (let i = 0; i < 140; i++) { next = await readPrivateJson(path.join(directory, 'runtime.json')).catch(() => null); if (next && next.pid !== first.pid) break; await delay(100); }
  assert.ok(next); assert.notEqual(next.pid, first.pid);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worklouder_status', arguments: {} } }) + '\n');
  for (let i = 0; i < 40 && !output.includes('"id":2'); i++) await delay(50);
  const response = output.trim().split('\n').map(JSON.parse).find((item) => item.id === 2);
  assert.equal(response.result.isError, undefined); assert.equal(JSON.parse(response.result.content[0].text).helperVersion, VERSION);
});
test('MCP logs revoked permission while status remains available and setup stays closed', async (t) => {
  const directory = await temp(t), store = new Store(directory); await store.load();
  await store.update((data) => { data.setupOpened = true; });
  const message = 'Input permission was revoked. Run /worklouder-setup and pair again.';
  const controller = {
    layerWriting: false, pairing: null, lastError: message,
    client: { state: 'unpaired', permissionRevoked: true },
    start: async () => {}, stop() {}, fault() {},
    status: () => ({ input: 'unpaired', permission: 'revoked', lastError: message }),
  };
  const opened = [], server = await startServer({ directory, store, controller, openUrl: async (url) => opened.push(url) });
  t.after(() => server.close());
  const child = spawn(process.execPath, [path.join(__dirname, '../src/entry.cjs'), 'mcp'], {
    env: { ...process.env, WORKLOUDER_STATE_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', errors = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
  const done = new Promise((resolve) => child.once('exit', resolve)); t.after(async () => { child.stdin.end(); await done; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  for (let i = 0; i < 50 && !errors.includes(message); i++) await delay(20);
  assert.match(errors, /permission was revoked.*worklouder-setup/i); assert.equal(opened.length, 0);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worklouder_status', arguments: {} } }) + '\n');
  for (let i = 0; i < 50 && !output.includes('"id":2'); i++) await delay(20);
  const response = output.trim().split('\n').map(JSON.parse).find((item) => item.id === 2);
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    input: 'unpaired', permission: 'revoked', lastError: message, helperVersion: VERSION,
  });
});
