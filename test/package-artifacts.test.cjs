'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const packageJson = require('../package.json');

const root = path.resolve(__dirname, '..');
const artifactName = `${packageJson.name}-${packageJson.version}`;

test('one plugin ZIP contains both launchers and an isolated dependency-free InputKit runtime', async (t) => {
  execFileSync('python3', [path.join(root, 'scripts/package.py')], { cwd: root, stdio: 'pipe' });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'worklouder-packages-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const archive = `${artifactName}-plugin.zip`;
  const archivePath = path.join(root, 'dist', archive);
  const extracted = path.join(temporary, 'plugin');
  await fs.mkdir(extracted);
  execFileSync('python3', ['-m', 'zipfile', '-e', archivePath, extracted]);
  const packageRoot = await fs.realpath(path.join(extracted, packageJson.name));
  await fs.access(path.join(packageRoot, 'src/resources/layers/cursor-default.json'));
  await fs.access(path.join(packageRoot, 'src/resources/layers/platform.cjs'));
  await fs.access(path.join(packageRoot, 'scripts/run-cursor'));
  await fs.access(path.join(packageRoot, 'scripts/run-cursor.cmd'));
  await fs.access(path.join(packageRoot, 'node_modules/@worklouder/input-kit/dist/cjs/index.js'));
  await assert.rejects(fs.access(path.join(packageRoot, 'node_modules/ws')), 'artifact must not ship ws');
  await assert.rejects(fs.access(path.join(packageRoot, 'layers/cursor-default.json')));
  await assert.rejects(fs.access(path.join(packageRoot, 'docs')), 'artifact must not ship development docs');

  const mcp = JSON.parse(await fs.readFile(path.join(packageRoot, 'mcp.json'), 'utf8'));
  const hooks = JSON.parse(await fs.readFile(path.join(packageRoot, 'hooks/hooks.json'), 'utf8'));
  const server = mcp.mcpServers['worklouder'];
  assert.equal(server.command, '${CURSOR_PLUGIN_ROOT}/scripts/run-cursor');
  assert.deepEqual(server.args, ['mcp']);
  assert.doesNotMatch(JSON.stringify({ mcp, hooks }), /\/bin\/sh|cmd\.exe|run-cursor\.(?:sh|cmd)/i);
  // Every hook is anchored to the installed plugin so a workspace-owned launcher cannot shadow it.
  for (const [event, definitions] of Object.entries(hooks.hooks)) {
    assert.deepEqual(definitions, [{ command: `'\${CURSOR_PLUGIN_ROOT}/scripts/run-cursor' hook ${event}`, timeout: 3 }]);
  }

  const launcherMode = Number(execFileSync('python3', ['-c',
    'import sys, zipfile; print((zipfile.ZipFile(sys.argv[1]).getinfo(sys.argv[2]).external_attr >> 16) & 0o777)',
    archivePath, `${packageJson.name}/scripts/run-cursor`], { encoding: 'utf8' }).trim());
  assert.notEqual(launcherMode & 0o111, 0, 'macOS launcher is executable in the ZIP');
  assert.match(await fs.readFile(path.join(packageRoot, 'scripts/run-cursor'), 'utf8'), /^#!\/bin\/sh/);
  const windowsLauncherBytes = await fs.readFile(path.join(packageRoot, 'scripts/run-cursor.cmd'));
  const windowsLauncher = windowsLauncherBytes.toString('utf8');
  assert.match(windowsLauncher, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(windowsLauncher, /Programs\\cursor\\Cursor\.exe/i);
  assert.ok(windowsLauncherBytes.includes(Buffer.from('\r\n')), 'Windows launcher uses CRLF line endings');

  const result = isolatedRuntimeProbe(packageRoot);
  assert.equal(result.status, 0, `${archive}: ${result.stderr || result.stdout}`);
  const resolved = JSON.parse(result.stdout);
  const bundledModules = path.join(packageRoot, 'node_modules') + path.sep;
  assert.ok(resolved.inputKit.startsWith(bundledModules), `${archive} resolved InputKit outside the artifact`);
  assert.equal(resolved.ws, null, `${archive} unexpectedly resolved ws: ${resolved.ws}`);
  assert.deepEqual(resolved.loadedWs, [], `${archive} loaded ws modules`);
  assert.equal(resolved.inputClientType, 'function');
  assert.equal(resolved.clientType, 'function');

  const windowsLayer = JSON.parse(await fs.readFile(path.join(root, 'dist', `cursor-default-layer-${packageJson.version}-windows.json`), 'utf8'));
  assert.deepEqual(windowsLayer.os, [1]);
  assert.equal(windowsLayer.layer.os, 1);
  assert.equal(windowsLayer.actions.some((action) => action.keyInputs.some((input) => input.keycode === 'KC_LGUI')), false);
});

function isolatedRuntimeProbe(packageRoot) {
  const script = String.raw`
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const root = process.argv[1];
    const pluginRequire = createRequire(path.join(root, 'src/client/client.cjs'));
    const inputKit = pluginRequire.resolve('@worklouder/input-kit');
    const inputKitRequire = createRequire(inputKit);
    let ws = null;
    try { ws = inputKitRequire.resolve('ws'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    const { InputClient } = pluginRequire('@worklouder/input-kit');
    const { Client } = pluginRequire('./client.cjs');
    const loadedWs = Object.keys(require.cache).filter((file) => file.includes(path.join('node_modules', 'ws') + path.sep));
    process.stdout.write(JSON.stringify({ inputKit, ws, loadedWs, inputClientType: typeof InputClient, clientType: typeof Client }));
  `;
  return spawnSync(process.execPath, ['-e', script, packageRoot], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
}
