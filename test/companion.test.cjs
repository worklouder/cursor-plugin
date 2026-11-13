'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Store, readPrivateJson, stateDirectory } = require('../src/helper/storage.cjs');
const { Controller, agentUrl } = require('../src/helper/controller.cjs');
const { startServer, openExternal } = require('../src/helper/server.cjs');
const { ensureHelper, request } = require('../src/helper/client.cjs');
const { inputServer } = require('./fixture.cjs');
const { Client } = require('../src/client/client.cjs');
const UUID = '170298cc-caf4-4cb8-8313-033ddc501722';
process.env.WORKLOUDER_NO_AUTO_AUTHORIZE = '1';
const temporaryDirectories = [];
after(async () => { for (const directory of temporaryDirectories) await fs.rm(directory, { recursive: true, force: true }); });
const clientOptions = (server, options = {}) => ({ port: Number(new URL(server.url).port), ...options });
async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worklouder-companion-'));
  temporaryDirectories.push(directory); return directory;
}
function fakeClient() {
  const client = new EventEmitter(); client.epoch = 1; client.authenticated = true; client.state = 'connected'; client.calls = [];
  client.stop = () => { client.authenticated = false; client.epoch++; };
  client.addLayer = async (params) => { client.calls.push({ method: 'addLayer', params }); return { added: true }; };
  client.setKeyLighting = async (params) => { client.calls.push({ method: 'setKeyLighting', params }); return { applied: true }; };
  return client;
}
async function controllerFixture(t, options = {}) {
  const store = new Store(await temp(t)); await store.load(); const client = fakeClient(), opened = [];
  const controller = new Controller(store, { client, openUrl: async (url) => opened.push(url), ...options });
  controller.devices.list = [{ id: 7, deviceType: 'codex_micro' }];
  controller.devices.info.set(7, { serialNumber: 'device-serial', deviceStatus: { selectedProfileIndex: 2, selectedLayerIndex: 1 } });
  t.after(() => controller.stop()); return { store, client, controller, opened };
}
test('a sole device is selected when a saved device is no longer available', async (t) => {
  const { store, controller } = await controllerFixture(t);
  await store.update((data) => { data.selectedSerial = 'missing-device'; });
  assert.equal(controller.status().deviceId, 7);
});
test('macOS uses the Work Louder application support directory', () => {
  assert.equal(
    stateDirectory('darwin', {}, '/Users/tester'),
    '/Users/tester/Library/Application Support/Work Louder/Cursor Plugin',
  );
});
test('Windows opens Cursor links directly, keeps shell-associated setup URLs and uses a Windows Cursor layer', async (t) => {
  assert.equal(
    stateDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, 'C:\\Users\\tester'),
    'C:\\Users\\tester\\AppData\\Local\\Work Louder\\Cursor Plugin',
  );
  const opened = [];
  const url = 'cursor://anysphere.cursor-deeplink/agent?id=example';
  const helperEnvironment = {
    PATH: 'C:\\Windows\\System32',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
    NODE_REPL_EXTERNAL_MODULE: 'cursor',
  };
  const cursorExecutable = 'C:\\Users\\tester\\AppData\\Local\\Programs\\cursor\\Cursor.exe';
  await openExternal(url, 'win32', async (...args) => opened.push(args), helperEnvironment, cursorExecutable);
  let [command, args, options] = opened[0];
  assert.equal(command, cursorExecutable);
  assert.deepEqual(args, ['--open-url', '--', url]);
  assert.equal(options.timeout, 10000);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.PATH, helperEnvironment.PATH);
  assert.equal(Object.hasOwn(options.env, 'WORKLOUDER_OPEN_URL'), false);
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE']) assert.equal(Object.hasOwn(options.env, name), false);
  assert.doesNotMatch(JSON.stringify(opened), /explorer\.exe/i);

  opened.length = 0;
  const setupUrl = 'http://127.0.0.1:12345/#token';
  await openExternal(setupUrl, 'win32', async (...values) => opened.push(values), helperEnvironment, cursorExecutable);
  [command, args, options] = opened[0];
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$url = $env:WORKLOUDER_OPEN_URL; Remove-Item Env:WORKLOUDER_OPEN_URL; Start-Process -FilePath $url -ErrorAction Stop']);
  assert.equal(options.env.WORKLOUDER_OPEN_URL, setupUrl);
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE']) assert.equal(Object.hasOwn(options.env, name), false);

  opened.length = 0;
  await openExternal(url, 'win32', async (...values) => opened.push(values), helperEnvironment, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(opened[0][0], 'powershell.exe');

  const { controller, client } = await controllerFixture(t, { platform: 'win32' });
  const offer = await controller.claimLayerOffer();
  await controller.decideLayer({ nonce: offer.nonce, accept: true });
  const definition = client.calls.find((call) => call.method === 'addLayer').params.definition;
  assert.deepEqual(definition.os, [1]);
  assert.equal(definition.layer.os, 1);
  assert.equal(definition.actions.some((action) => action.keyInputs.some((input) => input.keycode === 'KC_LGUI')), false);
  assert.match(controller.status().controls.newChat, /Ctrl\+N/);
  assert.match(controller.status().controls.modelPicker, /Ctrl\+\//);
  assert.match(controller.status().controls.approve, /Ctrl\+Enter/);
});
test('helper saves No once across restarts, without a device write', async (t) => {
  const { store, controller, client } = await controllerFixture(t);
  const offer = await controller.claimLayerOffer(); assert.equal(offer.profileNumber, 3);
  await controller.decideLayer({ nonce: offer.nonce, accept: false }); assert.equal(store.data.defaultLayerDecision, 'declined');
  assert.equal(await controller.claimLayerOffer(), null); assert.equal(client.calls.length, 0);
  const restarted = new Store(store.directory); await restarted.load(); assert.equal(restarted.data.defaultLayerDecision, 'declined');
  assert.equal(new Controller(restarted, { client }).status(true).canOfferDefaultLayer, false);
});
test('helper saves Yes before one verified Smart Action write, and never repeats an uncertain write', async (t) => {
  const { store, controller, client } = await controllerFixture(t);
  const offer = await controller.claimLayerOffer();
  client.addLayer = async (params) => {
    assert.equal(store.data.defaultLayerDecision, 'accepted'); assert.equal(params.profileIndex, 2);
    assert.equal(params.definition.smartActions.length, 10); throw new Error('Write timed out; outcome unknown');
  };
  await assert.rejects(controller.decideLayer({ nonce: offer.nonce, accept: true }), /outcome unknown/);
  assert.equal(await controller.claimLayerOffer(), null);
  await assert.rejects(controller.decideLayer({ nonce: offer.nonce, accept: true }), /no longer active/);
  const restarted = new Store(store.directory); await restarted.load(); assert.equal(restarted.data.defaultLayerDecision, 'accepted');
});
test('offer nonce, changed connection and interrupted setup cannot cause another write or offer', async (t) => {
  const { store, controller, client } = await controllerFixture(t);
  const [offer, duplicate] = await Promise.all([controller.claimLayerOffer(), controller.claimLayerOffer()]); assert.equal(duplicate, null, 'two setup pages must not show the same question twice');
  await assert.rejects(controller.decideLayer({ nonce: 'invalid', accept: true }));
  ++client.epoch; await assert.rejects(controller.decideLayer({ nonce: offer.nonce, accept: true }), /connection changed/);
  assert.equal(client.calls.length, 0); assert.equal(store.data.defaultLayerDecision, 'accepted');
  const other = await controllerFixture(t); await other.controller.claimLayerOffer();
  const restarted = new Store(other.store.directory); await restarted.load(); assert.equal(restarted.data.defaultLayerDecision, 'offered');
});
test('manual layer additions work after any saved choice without resetting the one-time decision', async (t) => {
  for (const decision of ['accepted', 'declined', 'offered']) {
    const { controller, store, client } = await controllerFixture(t);
    await store.update((data) => { data.defaultLayerDecision = decision; });
    assert.equal(await controller.claimLayerOffer(), null);
    assert.equal(controller.status(true).canAddLayer, true);
    const cancelled = await controller.claimLayerOffer(true);
    assert.equal(cancelled.profileNumber, 3); assert.equal(cancelled.manual, true);
    assert.equal(client.calls.length, 0, 'opening confirmation does not write');
    await controller.decideLayer({ accept: false, nonce: cancelled.nonce });
    assert.equal(client.calls.length, 0); assert.equal(store.data.defaultLayerDecision, decision);
    const confirmed = await controller.claimLayerOffer(true);
    assert.deepEqual(await controller.decideLayer({ accept: true, nonce: confirmed.nonce }), { added: true });
    assert.equal(client.calls.length, 1); assert.equal(client.calls[0].method, 'addLayer');
    assert.equal(client.calls[0].params.deviceId, 7); assert.equal(client.calls[0].params.profileIndex, 2);
    assert.equal(client.calls[0].params.definition.layer.layout.base[3][0].keycode, 'KA_1');
    assert.equal(store.data.defaultLayerDecision, decision);
    await assert.rejects(controller.decideLayer({ accept: true, nonce: confirmed.nonce }), /no longer active/);
    assert.equal(await controller.claimLayerOffer(), null);
    const restarted = new Store(store.directory); await restarted.load(); assert.equal(restarted.data.defaultLayerDecision, decision);
  }
});
test('manual additions reject changed connections and block duplicate writes until Input finishes', async (t) => {
  const { controller, store, client } = await controllerFixture(t);
  await store.update((data) => { data.defaultLayerDecision = 'declined'; });
  const stale = await controller.claimLayerOffer(true); ++client.epoch;
  await assert.rejects(controller.decideLayer({ accept: true, nonce: stale.nonce }), /connection changed/);
  assert.equal(client.calls.length, 0);
  let finish;
  client.addLayer = async (params) => { client.calls.push({ method: 'addLayer', params }); return new Promise((resolve) => { finish = resolve; }); };
  const offer = await controller.claimLayerOffer(true);
  const writing = controller.decideLayer({ accept: true, nonce: offer.nonce });
  assert.equal(controller.status(true).canAddLayer, false);
  await assert.rejects(controller.claimLayerOffer(true), /already in progress/);
  assert.equal(client.calls.length, 1);
  finish({ added: true }); await writing;
  assert.equal(controller.status(true).canAddLayer, true); assert.equal(store.data.defaultLayerDecision, 'declined');
});
test('a manual failed write is never retried automatically and a new explicit confirmation is required', async (t) => {
  const { controller, store, client } = await controllerFixture(t);
  await store.update((data) => { data.defaultLayerDecision = 'accepted'; });
  client.addLayer = async () => { client.calls.push('write'); throw new Error('addLayer timed out; outcome unknown'); };
  const offer = await controller.claimLayerOffer(true);
  await assert.rejects(controller.decideLayer({ accept: true, nonce: offer.nonce }), /outcome unknown/);
  await assert.rejects(controller.decideLayer({ accept: true, nonce: offer.nonce }), /no longer active/);
  assert.equal(await controller.claimLayerOffer(), null); assert.equal(client.calls.length, 1);
  assert.ok((await controller.claimLayerOffer(true)).nonce, 'the user can deliberately try again after checking Input');
  assert.equal(client.calls.length, 1); assert.equal(store.data.defaultLayerDecision, 'accepted');
});
test('setup HTTP endpoints require manual confirmation before re-adding a layer', async (t) => {
  const { controller, store, client } = await controllerFixture(t);
  await store.update((data) => { data.defaultLayerDecision = 'declined'; });
  const server = await startServer({ directory: store.directory, store, controller }); t.after(() => server.close());
  assert.equal((await request(server.runtime, '/state')).canAddLayer, true);
  assert.equal(await request(server.runtime, '/layer/offer', {}), null);
  const offer = await request(server.runtime, '/layer/offer', { manual: true });
  assert.equal(client.calls.length, 0);
  await request(server.runtime, '/layer/decision', { accept: true, nonce: offer.nonce });
  assert.equal(client.calls.length, 1); assert.equal(store.data.defaultLayerDecision, 'declined');
});
test('native agent keys and dial work across layers on only the selected device', async (t) => {
  const { controller, store, client, opened } = await controllerFixture(t);
  controller.receive({ conversation_id: UUID, hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/workspace'], prompt: 'private' });
  client.emit('keyTriggered', { deviceId: 8, identifier: 'cursor.agent.1', action: 'click' });
  await delay(0); assert.equal(opened.length, 0);
  client.emit('keyTriggered', { deviceId: 7, identifier: 'cursor.agent.1', action: 'click' });
  await delay(0);
  assert.deepEqual(opened, [agentUrl(UUID)]);
  assert.ok(client.calls.length > 0 && client.calls.every((call) => call.method === 'setKeyLighting'));
  await controller.dispatch('cursor.command.approve', 'tap'); assert.equal(opened.length, 1); assert.match(controller.lastAction, /not connected/);
  client.emit('deviceInfoChanged', { deviceId: 7, deviceInfo: { serialNumber: 'device-serial', deviceStatus: { selectedProfileIndex: 2, selectedLayerIndex: 1 } } });
  assert.equal(controller.devices.info.get(7).deviceStatus.selectedLayerIndex, 1);
  client.emit('keyTriggered', { deviceId: 7, identifier: 'cursor.dial.cw', action: 'click' });
  await delay(0); assert.deepEqual(opened, [agentUrl(UUID), agentUrl(UUID)]);
  assert.equal(controller.status().deviceReady, true); assert.equal(Object.hasOwn(controller.status(), 'layerActive'), false);
  assert.throws(() => agentUrl('https://example.com'), /supported Cursor agent link/);
  assert.equal(JSON.stringify(controller.status()).includes('private'), false);
});
test('empty drafts never occupy Agent Keys; actual chat activity admits only the two used conversations', async (t) => {
  const { controller } = await controllerFixture(t);
  const ids = Array.from({ length: 4 }, (_, index) => `170298cc-caf4-4cb8-8313-033ddc50172${index}`);
  for (const id of ids) controller.receive({ conversation_id: id, hook_event_name: 'sessionStart', workspace_roots: [] });
  assert.equal(controller.slots().filter(Boolean).length, 0);
  controller.receive({ conversation_id: ids[0], hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/project'] });
  controller.receive({ conversation_id: ids[1], hook_event_name: 'postToolUse', workspace_roots: ['/project'] });
  assert.deepEqual(new Set(controller.slots().filter(Boolean).map((slot) => slot.id)), new Set(ids.slice(0, 2)));
  for (const id of ids) controller.receive({ conversation_id: id, hook_event_name: 'sessionStart', workspace_roots: [] });
  assert.equal(controller.slots().filter(Boolean).length, 2);
  controller.receive({ conversation_id: ids[0], hook_event_name: 'sessionEnd' });
  assert.deepEqual(controller.slots().filter(Boolean).map((slot) => slot.id), [ids[1]]);
});
test('private storage serializes updates, protects permissions, and preserves malformed settings', async (t) => {
  const directory = await temp(t), store = new Store(directory); await store.load();
  await Promise.all([store.update((data) => { data.first = 1; }), store.update((data) => { data.second = 2; })]);
  assert.deepEqual(await readPrivateJson(store.file), { first: 1, second: 2 });
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700); assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
  await fs.writeFile(store.file, '{broken'); await assert.rejects(new Store(directory).load(), /No saved data was overwritten/);
  assert.equal(await fs.readFile(store.file, 'utf8'), '{broken');
});
test('local server rejects unauthenticated and foreign-origin requests and exposes no credentials', async (t) => {
  const directory = await temp(t), opened = []; const server = await startServer({ directory, openUrl: async (url) => opened.push(url) });
  t.after(() => server.close());
  async function raw(headers) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${server.runtime.port}/state`, { headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
    });
  }
  assert.equal(await raw({}), 401);
  assert.equal(await raw({ Authorization: `Bearer ${server.runtime.token}`, Origin: 'https://example.com' }), 403);
  assert.equal(await raw({ Authorization: `Bearer ${server.runtime.token}`, Host: 'example.com' }), 403);
  const state = await request(server.runtime, '/state'); assert.equal(state.input, 'unpaired'); assert.equal(JSON.stringify(state).includes(server.runtime.token), false);
  assert.equal(await startServer({ directory }), null, 'a second server does not acquire the lock');
  await request(server.runtime, '/lease', { id: UUID, pid: process.pid }); assert.equal(opened.length, 1);
  await request(server.runtime, '/lease', { id: UUID, pid: process.pid }); assert.equal(opened.length, 1);
});
test('helper requests authorization once on true first setup and later authenticates without another prompt', async (t) => {
  const mock = await inputServer((call) => {
    if (call.method === 'requestAuthorization') return { applicationId: 'app', token: 'saved-token' };
    if (call.method === 'authenticate') return { authenticated: true };
    if (call.method === 'getDevices') return [{ id: 7, deviceType: 'codex_micro' }];
    if (call.method === 'getDeviceInfo') return { portPath: '/dev/mock', devicePid: 'mock-pid', serialNumber: 'serial', connectionType: 1, deviceType: 'codex_micro', layoutType: 'universal', isUsbConnection: true, deviceStatus: { selectedProfileIndex: 0, selectedLayerIndex: 1 } };
    return { applied: true };
  }); t.after(() => mock.close());
  const store = new Store(await temp(t)); await store.load();
  const make = () => new Client(store.credentials(), clientOptions(mock));
  const first = new Controller(store, { client: make() }); await first.start();
  await delay(30); assert.equal(first.client.authenticated, true);
  assert.equal(store.data.inputAuthorizationAttempted, true); first.stop();
  const next = new Controller(store, { client: make() }); t.after(() => next.stop()); await next.start();
  assert.equal(next.client.authenticated, true); assert.equal(mock.calls.filter((call) => call.method === 'requestAuthorization').length, 1);
  assert.equal(mock.calls.filter((call) => call.method === 'authenticate').length, 1);
});
test('a denied first-setup authorization is not repeated after restart and manual pairing can retry', async (t) => {
  let attempts = 0;
  const mock = await inputServer((call) => {
    if (call.method === 'requestAuthorization' && ++attempts === 1) return { error: { code: -32003, message: 'Authorization denied' } };
    if (call.method === 'requestAuthorization') return { applicationId: 'app', token: 'saved-token' };
  }); t.after(() => mock.close());
  const directory = await temp(t), store = new Store(directory); await store.load();
  const client = new Client(store.credentials(), clientOptions(mock));
  const controller = new Controller(store, { client });
  await controller.start();
  assert.equal(attempts, 1); assert.equal(client.state, 'unpaired'); assert.equal(controller.lastError, 'Authorization denied');
  assert.equal(store.data.inputAuthorizationAttempted, true); controller.stop();

  const restartedStore = new Store(directory); await restartedStore.load();
  const restartedClient = new Client(restartedStore.credentials(), clientOptions(mock));
  const restarted = new Controller(restartedStore, { client: restartedClient }); t.after(() => restarted.stop());
  await restarted.start(); await delay(30);
  assert.equal(attempts, 1, 'restart must not repeat a denied first-setup prompt');
  assert.equal(restartedClient.state, 'unpaired');
  await restarted.pair();
  assert.equal(attempts, 2); assert.equal(restartedClient.authenticated, true); assert.equal(restarted.lastError, null);
});
test('existing setup state without credentials is not mistaken for a first-time authorization', async (t) => {
  const mock = await inputServer((call) => call.method === 'requestAuthorization'
    ? { applicationId: 'unexpected', token: 'unexpected' } : undefined); t.after(() => mock.close());
  const store = new Store(await temp(t)); await store.load();
  await store.update((data) => { data.setupOpened = true; });
  const client = new Client(store.credentials(), clientOptions(mock));
  const controller = new Controller(store, { client }); t.after(() => controller.stop());
  await controller.start(); await delay(30);
  assert.equal(client.state, 'unpaired');
  assert.equal(mock.calls.filter((call) => call.method === 'requestAuthorization').length, 0);
  assert.equal(store.data.inputAuthorizationAttempted, undefined);
});
test('revoked Input permission is cleared and reported without opening setup or requesting authorization', async (t) => {
  const mock = await inputServer((call) => {
    if (call.method === 'authenticate') return { error: { code: -32001, message: 'Authentication failed' } };
    if (call.method === 'requestAuthorization') return { applicationId: 'repaired-app', token: 'repaired-token' };
  }); t.after(() => mock.close());
  const directory = await temp(t), store = new Store(directory); await store.load();
  await store.update((data) => { data.credentials = { applicationId: 'revoked-app', token: 'revoked-token' }; data.setupOpened = true; });
  const client = new Client(store.credentials(), clientOptions(mock));
  const controller = new Controller(store, { client });
  await controller.start();
  const status = controller.status();
  assert.equal(status.input, 'unpaired'); assert.equal(status.permission, 'revoked');
  assert.match(status.lastError, /permission was revoked.*worklouder-setup/i);
  assert.equal(store.data.credentials, undefined); assert.equal(store.data.inputPermissionRevoked, true);
  assert.equal(store.data.inputAuthorizationAttempted, true);
  assert.equal(mock.calls.filter((call) => call.method === 'requestAuthorization').length, 0);
  controller.stop();

  const restartedStore = new Store(directory); await restartedStore.load();
  const restartedClient = new Client(restartedStore.credentials(), clientOptions(mock));
  const restarted = new Controller(restartedStore, { client: restartedClient }); t.after(() => restarted.stop());
  await restarted.start();
  assert.equal(restarted.status().permission, 'revoked');
  assert.match(restarted.status().lastError, /permission was revoked.*worklouder-setup/i);
  assert.equal(mock.calls.filter((call) => call.method === 'requestAuthorization').length, 0);
  await restarted.pair();
  assert.equal(restarted.status().permission, 'authorized'); assert.equal(restarted.status().lastError, null);
  assert.equal(restartedStore.data.inputPermissionRevoked, undefined);
});
test('concurrent launches share one helper and authenticated hook events arrive', async (t) => {
  const directory = await temp(t);
  const runtimes = await Promise.all(Array.from({ length: 3 }, () => ensureHelper({ directory })));
  assert.equal(new Set(runtimes.map((runtime) => runtime.pid)).size, 1);
  const runtime = runtimes[0];
  t.after(async () => { process.kill(runtime.pid, 'SIGTERM'); for (let i = 0; i < 50; i++) { if (!await fs.stat(path.join(directory, 'owner.lock')).catch(() => null)) return; await delay(20); } });
  await request(runtime, '/event', { conversation_id: UUID, hook_event_name: 'beforeSubmitPrompt', prompt: 'secret' });
  const status = await request(runtime, '/state'); assert.equal(status.slots[0].id, UUID); assert.equal(status.slots[0].state, 'working');
  assert.equal(JSON.stringify(status).includes('secret'), false);
});
test('idle helper removes its runtime metadata and a crashed owner is recovered once', async (t) => {
  const directory = await temp(t);
  const server = await startServer({ directory, idleMs: 30 }); t.after(() => server.close());
  for (let i = 0; i < 50 && await fs.stat(path.join(directory, 'runtime.json')).catch(() => null); i++) await delay(10);
  assert.equal(await fs.stat(path.join(directory, 'runtime.json')).catch(() => null), null);
  await fs.writeFile(path.join(directory, 'owner.lock'), JSON.stringify({ pid: 2147483647, owner: UUID }), { mode: 0o600 });
  const runtimes = await Promise.all([ensureHelper({ directory }), ensureHelper({ directory })]);
  assert.equal(runtimes[0].pid, runtimes[1].pid);
  t.after(async () => { process.kill(runtimes[0].pid, 'SIGTERM'); await delay(100); });
});
test('packaged launcher runs MCP and hooks using Cursor with no Node on PATH', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS Cursor runtime check');
  const runtimePath = '/Applications/Cursor.app/Contents/MacOS/Cursor';
  if (!await fs.stat(runtimePath).catch(() => null)) return t.skip('Cursor is not installed');
  const directory = await temp(t), root = path.resolve(__dirname, '..');
  const launcher = path.join(root, 'scripts/run-cursor');
  const child = spawn(launcher, ['mcp'], { env: { ...process.env, PATH: '/usr/bin:/bin', WORKLOUDER_STATE_DIR: directory, WORKLOUDER_NO_OPEN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    child.kill(); await exited;
    const runtime = await readPrivateJson(path.join(directory, 'runtime.json')).catch(() => null);
    if (runtime) { process.kill(runtime.pid, 'SIGTERM'); await delay(100); }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'worklouder_status', arguments: {} } })}\n`);
  for (let i = 0; i < 100 && !stdout.includes('"id":3'); i++) await delay(50);
  const messages = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.find((message) => message.id === 1)?.result.serverInfo.name, 'worklouder', stderr);
  assert.equal(messages.find((message) => message.id === 1)?.result.serverInfo.version, require('../package.json').version, stderr);
  assert.equal(messages.find((message) => message.id === 2)?.result.tools.length, 2);
  const status = messages.find((message) => message.id === 3)?.result; assert.equal(status?.isError, undefined); assert.equal(JSON.parse(status.content[0].text).input, 'unpaired');
  const hook = spawn(launcher, ['hook', 'beforeSubmitPrompt'], { env: { ...process.env, PATH: '/usr/bin:/bin', WORKLOUDER_STATE_DIR: directory, WORKLOUDER_NO_OPEN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; hook.stdout.on('data', (chunk) => { output += chunk; });
  const done = new Promise((resolve) => hook.once('exit', resolve)); hook.stdin.end(JSON.stringify({ conversation_id: UUID, prompt: 'private', workspace_roots: ['/project'] }));
  assert.equal(await done, 0); assert.deepEqual(JSON.parse(output), { continue: true });
  const runtime = await readPrivateJson(path.join(directory, 'runtime.json')); assert.equal((await request(runtime, '/state')).slots[0].id, UUID);
  const start = spawn(launcher, ['hook', 'sessionStart'], { env: { ...process.env, PATH: '/usr/bin:/bin', WORKLOUDER_STATE_DIR: directory, WORKLOUDER_NO_OPEN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let startOutput = ''; start.stdout.on('data', (chunk) => { startOutput += chunk; });
  const startDone = new Promise((resolve) => start.once('exit', resolve)); start.stdin.end('{}');
  assert.equal(await startDone, 0);
  assert.equal(JSON.parse(startOutput).env.PATH.split(path.delimiter)[0], path.join(root, 'scripts'));
  child.stdin.end(); assert.equal(await exited, 0);
});
