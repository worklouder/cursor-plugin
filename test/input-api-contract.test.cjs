'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('runtime uses InputKit public methods and typed events', () => {
  const root = path.resolve(__dirname, '..');
  const adapter = fs.readFileSync(path.join(root, 'src/client/client.cjs'), 'utf8');
  const files = ['src/domain/devices.cjs', 'src/domain/lighting.cjs', 'src/helper/controller.cjs'];
  const runtime = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

  assert.match(adapter, /require\('@worklouder\/input-kit'\)/);
  assert.doesNotMatch(adapter, /new WebSocket|jsonrpc|\.send\(/);
  assert.doesNotMatch(runtime, /\.request\(\s*'/);
  for (const method of ['getDevices', 'getDeviceInfo', 'setActiveProfileLayer', 'setKeyLighting', 'addLayer']) {
    assert.match(adapter, new RegExp(`\\.${method}\\(`));
  }
  for (const method of ['getDevices', 'getDeviceInfo', 'setKeyLighting', 'addLayer']) {
    assert.match(runtime, new RegExp(`\\.${method}\\(`));
  }
  for (const event of ['devicesUpdated', 'deviceInfoChanged', 'keyTriggered']) {
    assert.match(adapter, new RegExp(`\\.on\\('${event}'`));
  }
  for (const stale of ['changeProfileLayer', 'changeKeyLighting', 'apiKey']) {
    assert.doesNotMatch(`${adapter}\n${runtime}`, new RegExp(stale));
  }
});

test('setup page shows the device picker only for multiple devices', () => {
  const root = path.resolve(__dirname, '..');
  const browser = fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8');
  assert.match(browser, /\$\('device-row'\)\.hidden = state\.devices\.length < 2/);
  assert.match(page, /Connect your device to the Cursor Agent Window\./);
  assert.doesNotMatch(page, /\bMicro\b/);
  assert.doesNotMatch(page, /Lights show idle, working, completed and error/);
  assert.doesNotMatch(page, /Your Yes was saved|Pinned chat IDs|Chats appear after activity/);
  assert.match(page, /Each card shows the chat assigned to that key and its current status/);
  assert.doesNotMatch(browser, /\$\('pins'\)/);
  assert.match(browser, /Chat pinned\.|Chat unpinned\./);
});
