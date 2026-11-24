'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Client, ENDPOINT } = require('../src/client/client.cjs');
const { inputServer, credentials } = require('./fixture.cjs');
const { cursorLayer } = require('../src/resources/layers/platform.cjs');
const saved = { applicationId: 'application', token: 'token' };
const clientOptions = (server, options = {}) => ({ port: Number(new URL(server.url).port), ...options });
test('pairs once, saves credentials, then authenticates on a later connection', async (t) => {
  const server = await inputServer((call) => call.method === 'requestAuthorization' ? saved : call.method === 'authenticate' ? { authenticated: true } : []);
  t.after(() => server.close()); const store = credentials();
  assert.equal(ENDPOINT, 'ws://127.0.0.1:19147/input');
  const client = new Client(store, clientOptions(server));
  t.after(() => client.stop()); await client.connect(); assert.equal(server.calls.length, 0);
  await client.connect(true); assert.equal(client.authenticated, true); assert.deepEqual(await store.get(), saved);
  client.stop(); await client.connect(); assert.deepEqual(server.calls.map((c) => c.method), ['requestAuthorization', 'authenticate']);
  const key = { deviceId: 1, identifier: 'cursor.agent.1', action: 'click' };
  const triggered = once(client, 'keyTriggered'); server.notify('keyTriggered', key);
  assert.deepEqual(await triggered, [key]);
  const future = once(client, 'notification'); server.notify('futureEvent', { value: 1 });
  assert.deepEqual(await future, [{ method: 'futureEvent', params: { value: 1 } }]);
});
test('rejected pairing does not re-prompt automatically', async (t) => {
  const server = await inputServer(() => ({ error: { code: -32003, message: 'Pairing denied' } })); t.after(() => server.close());
  const client = new Client(credentials(), clientOptions(server)); t.after(() => client.stop());
  await assert.rejects(client.connect(true), { code: -32003 });
  assert.equal(client.state, 'unpaired'); assert.equal(client.pairRequired, true); assert.equal(client.reconnectTimer, undefined);
});
test('revoked credentials are cleared and require explicit pairing', async (t) => {
  const server = await inputServer(() => ({ error: { code: -32001, message: 'Authentication failed' } })); t.after(() => server.close());
  const store = credentials(saved); const client = new Client(store, clientOptions(server)); t.after(() => client.stop());
  await assert.rejects(client.connect(), (error) => error.code === -32001 && /permission was revoked.*worklouder-setup/i.test(error.message));
  assert.equal(await store.get(), null); assert.equal(client.pairRequired, true); assert.equal(client.permissionRevoked, true);
  assert.equal(server.calls.filter((call) => call.method === 'requestAuthorization').length, 0);
});
test('uses current selection and lighting methods, serializes requests, and never retries a timed-out write', async (t) => {
  const server = await inputServer((call) => {
    if (call.method === 'authenticate') return { authenticated: true };
    if (call.method === 'setActiveProfileLayer') return { changed: true };
    if (call.method === 'setKeyLighting') return { applied: true };
    if (call.method === 'addLayer') return undefined;
    return [];
  }); t.after(() => server.close());
  const client = new Client(credentials(saved), clientOptions(server, { requestTimeoutMs: 80, addLayerTimeoutMs: 80 })); t.after(() => client.stop());
  await client.connect(); await Promise.all([client.getDevices(), client.getDevices()]);
  for (let i = 1; i < 3; i++) assert.ok(server.calls[i].at - server.calls[i - 1].at >= 140);
  assert.deepEqual(await client.setActiveProfileLayer({ deviceId: 1, profileIndex: 0, layerIndex: 1 }), { changed: true });
  assert.deepEqual(await client.setKeyLighting({ deviceId: 1, identifier: 'cursor.agent.1', isRegex: false, brightness: 0.5 }), { applied: true });
  const definition = cursorLayer();
  await assert.rejects(client.addLayer({ deviceId: 1, profileIndex: 0, definition }), /outcome may be unknown/i);
  const addLayerCalls = server.calls.filter((call) => call.method === 'addLayer');
  assert.equal(addLayerCalls.length, 1);
  assert.deepEqual(addLayerCalls[0].params, { deviceId: 1, profileIndex: 0, definition });
  assert.equal(Object.hasOwn(addLayerCalls[0].params, 'preset'), false);
});
test('disconnect rejects in-flight work and an explicit stop disables reconnect', async (t) => {
  const server = await inputServer((call) => call.method === 'authenticate' ? { authenticated: true } : undefined); t.after(() => server.close());
  const client = new Client(credentials(saved), clientOptions(server)); t.after(() => client.stop());
  await client.connect(); const pending = client.getDevices();
  const rejected = assert.rejects(pending, /closing|closed|disconnected|not connected|stopped/); client.stop(); await rejected;
  assert.equal(client.reconnectTimer, undefined);
});
test('stopping while credentials load cannot open a socket afterward', async () => {
  let resolve; const store = { get: () => new Promise((done) => { resolve = done; }) };
  const client = new Client(store, { createClient: () => { throw new Error('must not create a client'); } });
  const pending = client.connect(); client.stop(); resolve(saved); await assert.rejects(pending, /cancelled/);
});
test('regaining focus during a cancelled connection can start a fresh authenticated connection', async (t) => {
  const server = await inputServer(() => ({ authenticated: true })); t.after(() => server.close());
  let resolveFirst, count = 0;
  const store = { get: () => ++count === 1 ? new Promise((resolve) => { resolveFirst = resolve; }) : Promise.resolve(saved) };
  const client = new Client(store, clientOptions(server)); t.after(() => client.stop());
  const original = client.connect(); const cancelled = assert.rejects(original, /cancelled/);
  client.stop(); const current = client.connect(); resolveFirst(saved);
  await cancelled; await current;
  assert.equal(client.authenticated, true); assert.equal(server.calls.length, 1);
});
