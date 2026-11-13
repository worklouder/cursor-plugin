'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Sessions, normalizeHook } = require('../src/domain/sessions.cjs');
const { Devices } = require('../src/domain/devices.cjs');
const { Lighting } = require('../src/domain/lighting.cjs');
const { Gestures } = require('../src/domain/gestures.cjs');
function event(id, name, extra = {}) { return { conversation_id: id, hook_event_name: name, workspace_roots: ['/project'], ...extra }; }
test('lifecycle state, unread acknowledgement, six slots and local pin policies', () => {
  const sessions = new Sessions(); sessions.receive(event('a', 'sessionStart')); assert.equal(sessions.items.get('a').state, 'idle');
  sessions.receive(event('a', 'beforeSubmitPrompt')); assert.equal(sessions.items.get('a').state, 'working');
  sessions.receive(event('a', 'afterAgentResponse')); assert.equal(sessions.items.get('a').state, 'working');
  sessions.receive(event('a', 'stop', { status: 'completed' })); assert.equal(sessions.items.get('a').state, 'complete');
  sessions.select('a'); assert.equal(sessions.items.get('a').state, 'idle');
  sessions.receive(event('b', 'stop', { status: 'error' })); assert.equal(sessions.slots('priority')[0].id, 'b');
  assert.equal(sessions.slots('pinned', ['a', 'missing'])[1], null); assert.equal(sessions.slots().length, 6);
  assert.equal(sessions.slots('custom', [], [{ command: 'workbench.view.scm' }])[0].action.command, 'workbench.view.scm');
  sessions.receive(event('a', 'sessionEnd')); assert.equal(sessions.items.has('a'), false);
});
test('late events from a retired generation cannot overwrite a newer turn', () => {
  const sessions = new Sessions();
  sessions.receive(event('a', 'beforeSubmitPrompt', { generation_id: 'one' }));
  sessions.receive(event('a', 'beforeSubmitPrompt', { generation_id: 'two' }));
  assert.equal(sessions.receive(event('a', 'stop', { generation_id: 'one', status: 'error' })), false);
  assert.equal(sessions.items.get('a').state, 'working');
});
test('hook forwarding strips prompt, thoughts, transcript and account information', () => {
  const normalized = normalizeHook(event('a', 'stop', { prompt: 'secret', text: 'secret', tool_input: { password: 'secret' }, transcript_path: '/secret', user_email: 'secret' }));
  assert.equal(JSON.stringify(normalized).includes('secret'), false);
  assert.equal(normalizeHook(event('a', 'unknown')), null);
});
test('all valid device types are retained while info notifications replace stale snapshots', async () => {
  let resolve;
  const client = { getDeviceInfo: (id) => id === 4 ? new Promise((done) => { resolve = done; }) : Promise.resolve({ serialNumber: `device-${id}` }) };
  const devices = new Devices(client, () => {});
  const updating = devices.replace([{ id: 4, deviceType: 'codex_micro' }, { id: 5, deviceType: 'knob' }, { id: 0, deviceType: 'invalid' }]);
  devices.update({ deviceId: 4, deviceInfo: { deviceStatus: { selectedLayerIndex: 2 } } });
  resolve({ serialNumber: 'old', deviceStatus: { selectedLayerIndex: 1 } }); await updating;
  assert.deepEqual(devices.list.map((device) => device.id), [4, 5]);
  assert.deepEqual(devices.info.get(4), { deviceStatus: { selectedLayerIndex: 2 } });
  assert.equal(devices.info.get(5).serialNumber, 'device-5');
  devices.update({ deviceId: 4, deviceInfo: { deviceType: 'codex_micro' } }); assert.equal(devices.info.get(4).deviceStatus, undefined);
  await devices.replace([]); assert.equal(devices.info.size, 0);
});
test('new pushed device lists defeat older discovery replies', async () => {
  let resolve;
  const client = { getDevices: () => new Promise((done) => { resolve = done; }) };
  const devices = new Devices(client, () => {}); const refresh = devices.refresh(); await devices.replace([]);
  resolve([{ id: 1, deviceType: 'codex_micro' }]); await refresh; assert.equal(devices.list.length, 0);
});
test('press/release/click deduplication, double-tap and dial hold', async () => {
  const calls = []; const gestures = new Gestures((...args) => calls.push(args), { holdMs: 15 });
  const id = 'cursor.agent.1'; gestures.receive(id, 'press'); gestures.receive(id, 'release'); gestures.receive(id, 'click');
  assert.equal(calls.length, 1); gestures.receive(id, 'press'); gestures.receive(id, 'release'); assert.equal(calls[1][1], 'double');
  gestures.receive('cursor.dial.press', 'press'); await delay(25); gestures.receive('cursor.dial.press', 'release');
  gestures.receive('cursor.dial.press', 'click');
  assert.equal(calls.at(-1)[1], 'hold'); gestures.receive('unrelated', 'click'); assert.equal(calls.length, 3); gestures.clear();
});
test('lighting uses current public API fields, coalesces equal states, and does not retry missing mappings in a loop', async () => {
  const calls = []; const client = { authenticated: true, setKeyLighting: async (options) => { calls.push(options); return { applied: true }; } };
  const lighting = new Lighting(client, () => ({ deviceId: 1, slots: [{ id: 'a', state: 'working' }], selectedId: 'a', brightness: 0.7 }), () => {});
  await lighting.flush(); await lighting.flush(); assert.equal(calls.length, 6);
  assert.deepEqual(calls[0], { deviceId: 1, identifier: 'cursor.agent.1', isRegex: false, color: 0x2864ff, brightness: 0.7, effect: 6, speed: 0.35 });
  assert.equal(calls[1].brightness, 0);
  lighting.reset(); client.setKeyLighting = async () => { throw new Error('Identifier not found'); }; await lighting.flush(); assert.equal(lighting.retryAt.size, 6);
});
