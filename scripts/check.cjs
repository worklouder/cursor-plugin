'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name);
    return entry.isDirectory() ? files(item) : [item];
  });
}
for (const folder of ['src', 'scripts', 'test']) {
  for (const file of files(path.join(root, folder)).filter((item) => item.endsWith('.cjs'))) execFileSync(process.execPath, ['--check', file]);
}
execFileSync(process.execPath, ['--check', path.join(root, 'src/ui/app.js')]);
for (const file of ['package.json', 'package-lock.json', 'mcp.json', 'hooks/hooks.json', '.cursor-plugin/plugin.json', '.cursor-plugin/marketplace.json', 'docs/input-mappings.json', 'src/resources/layers/cursor-default.json']) JSON.parse(fs.readFileSync(path.join(root, file)));
const pkg = require('../package.json');
const inputKitVersion = '0.2.0';
const expectedDependencies = { '@worklouder/input-kit': inputKitVersion };
assert.deepEqual(pkg.dependencies, expectedDependencies, 'Unexpected dependencies');
assert.equal(pkg.devDependencies, undefined, 'Unexpected devDependencies');

const lock = require('../package-lock.json');
assert.deepEqual(lock.packages?.['']?.dependencies, expectedDependencies, 'Lockfile root dependencies do not match package.json');
const lockedInputKit = lock.packages?.['node_modules/@worklouder/input-kit'];
assert.equal(lockedInputKit?.version, inputKitVersion, 'Lockfile InputKit version does not match package.json');
assert.equal(lockedInputKit?.resolved, `https://registry.npmjs.org/@worklouder/input-kit/-/input-kit-${inputKitVersion}.tgz`, 'Lockfile does not resolve InputKit from npm');
assert.equal(lockedInputKit?.link, undefined, 'Lockfile InputKit dependency is unexpectedly linked');

// Marketplace installs run straight from Git, so the pinned InputKit must be committed.
const committedInputKit = require('../node_modules/@worklouder/input-kit/package.json');
assert.equal(committedInputKit.version, inputKitVersion, 'Committed InputKit version does not match package.json');
const trackedInputKit = execFileSync('git', ['ls-files', 'node_modules/@worklouder/input-kit/dist/cjs/index.js'], { cwd: root, encoding: 'utf8' }).trim();
assert.ok(trackedInputKit, 'InputKit must be committed under node_modules/@worklouder/input-kit');

const inputKit = require('@worklouder/input-kit');
assert.equal(typeof inputKit.InputClient, 'function', 'InputKit CommonJS export is missing InputClient');
for (const method of ['requestAuthorization', 'authenticate', 'getDevices', 'getDeviceInfo', 'setActiveProfileLayer', 'setKeyLighting', 'addLayer']) {
  assert.equal(typeof inputKit.InputClient.prototype[method], 'function', `InputKit is missing ${method}`);
}
console.log('JavaScript syntax, JSON manifests, lockfile, and published InputKit dependency pass.');
