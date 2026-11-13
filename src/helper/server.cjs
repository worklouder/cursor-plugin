'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Store, stateDirectory, privateDirectory, readPrivateJson, atomicJson } = require('./storage.cjs');
const { Controller } = require('./controller.cjs');
const { VERSION, compareVersions } = require('./version.cjs');
const runFile = promisify(execFile);

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function openExternal(url, platform = process.platform, execute = runFile, inheritedEnvironment = process.env, runtimeExecutable = process.execPath) {
  const environment = { ...inheritedEnvironment };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE']) delete environment[name];
  if (platform === 'darwin') return execute('/usr/bin/open', [url], { timeout: 10000, env: environment });
  if (platform === 'win32' && url.startsWith('cursor://') && path.win32.basename(runtimeExecutable).toLowerCase() === 'cursor.exe') {
    return execute(runtimeExecutable, ['--open-url', '--', url], { timeout: 10000, windowsHide: true, env: environment });
  }
  if (platform === 'win32') return execute('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$url = $env:WORKLOUDER_OPEN_URL; Remove-Item Env:WORKLOUDER_OPEN_URL; Start-Process -FilePath $url -ErrorAction Stop',
  ], { timeout: 10000, windowsHide: true, env: { ...environment, WORKLOUDER_OPEN_URL: url } });
  throw new Error('Opening Cursor is currently supported on macOS and Windows');
}
async function body(request) {
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length; if (bytes > 65536) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function startServer(options = {}) {
  const version = options.version ?? VERSION;
  const directory = options.directory ?? stateDirectory(); await privateDirectory(directory);
  const lockFile = path.join(directory, 'owner.lock'), runtimeFile = path.join(directory, 'runtime.json');
  const owner = crypto.randomUUID();
  async function acquire() {
    try {
      await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readPrivateJson(lockFile).catch(() => null);
      // A partially written or unreadable lock must never be stolen from a live helper.
      if (!previous || alive(previous.pid)) return false;
      const recoveryFile = path.join(directory, 'recovery.lock');
      let recovery;
      try { recovery = await fs.open(recoveryFile, 'wx', 0o600); }
      catch (failure) { if (failure.code === 'EEXIST') return false; throw failure; }
      try {
        const current = await readPrivateJson(lockFile).catch(() => null);
        if (current?.owner !== previous.owner || alive(current.pid)) return false;
        await fs.unlink(lockFile); return await acquire();
      } finally { await recovery.close(); await fs.unlink(recoveryFile).catch(() => {}); }
    }
  }
  if (!await acquire()) return null;
  const token = crypto.randomBytes(32).toString('hex'), leases = new Map();
  let controller, server, timer, lastTouch = Date.now(), inflight = 0, closing = false, upgrading = false, origin;
  const deviceBusy = () => !!(controller?.layerWriting || controller?.pairing || controller?.client.state === 'pairing');
  const idleMs = options.idleMs ?? 90000;
  const open = options.openUrl ?? (async (url) => {
    if (process.env.WORKLOUDER_NO_OPEN === '1') return;
    await openExternal(url);
  });
  const setup = () => open(`${origin}/#${token}`);
  async function close() {
    if (closing) return; closing = true; clearInterval(timer); controller?.stop();
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    const current = await readPrivateJson(lockFile).catch(() => null);
    if (current?.owner === owner) {
      await fs.unlink(runtimeFile).catch(() => {}); await fs.unlink(lockFile).catch(() => {});
    }
  }
  try {
    const store = options.store ?? new Store(directory); await store.load();
    controller = options.controller ?? new Controller(store, { openUrl: open, openSetup: setup,
      autoAuthorize: options.autoAuthorize ?? process.env.WORKLOUDER_NO_AUTO_AUTHORIZE !== '1' });
    const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async (file) => [file, await fs.readFile(path.join(__dirname, '../ui', file))])));
    server = http.createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      const json = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      const route = request.url;
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return json(403, { error: 'Local requests only' });
      const asset = route === '/' ? 'index.html' : route === '/app.js' ? 'app.js' : route === '/style.css' ? 'style.css' : null;
      if (asset && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
        response.end(assets.get(asset)); return;
      }
      const supplied = request.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return json(401, { error: 'Open setup from Cursor to connect this page' });
      if (upgrading) return json(503, { error: 'The device helper is updating. Reopen setup in a moment.' });
      inflight++; lastTouch = Date.now();
      try {
        if (request.method === 'GET' && route === '/health') return json(200, { protocol: 1, pid: process.pid, version, busy: deviceBusy() });
        if (request.method === 'GET' && route === '/state') return json(200, { ...controller.status(true), helperVersion: version });
        if (request.method !== 'POST') return json(404, { error: 'Unknown request' });
        if (!request.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON required' });
        const input = await body(request); let result;
        switch (route) {
          case '/upgrade': {
            if (compareVersions(input?.version, version) <= 0) return json(412, { error: 'The running helper is already this version or newer' });
            if (deviceBusy()) return json(409, { error: 'Pairing or a layer write is still in progress' });
            upgrading = true;
            json(200, { stopping: true });
            setImmediate(() => { void close(); });
            return;
          }
          case '/event': controller.receive(input); result = {}; break;
          case '/pair': result = await controller.pair(); break;
          case '/layer/offer': result = await controller.claimLayerOffer(input?.manual ?? false); break;
          case '/layer/decision': result = await controller.decideLayer(input); break;
          case '/choose-device': result = await controller.chooseDevice(input.id); break;
          case '/settings': result = await controller.configure(input); break;
          case '/setup-open': {
            if (store.data.setupOpened !== true) await store.update((data) => { data.setupOpened = true; });
            await setup(); result = { opened: true }; break;
          }
          case '/lease': {
            if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.id) || !alive(input.pid)) throw new Error('Invalid Cursor connection');
            leases.set(input.id, { pid: input.pid, at: Date.now() });
            if (store.data.setupOpened !== true) {
              await store.update((data) => { data.setupOpened = true; });
              await setup().catch((error) => controller.fault(error));
            }
            result = { permission: controller.client?.permissionRevoked ? 'revoked' : undefined, lastError: controller.lastError ?? null }; break;
          }
          case '/release': leases.delete(input.id); result = {}; break;
          default: return json(404, { error: 'Unknown request' });
        }
        json(200, result);
      } catch (error) { json(400, { error: error.message }); }
      finally { inflight--; }
    });
    server.requestTimeout = 150000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    const runtime = { protocol: 1, pid: process.pid, port: server.address().port, token, version };
    await atomicJson(runtimeFile, runtime);
    void controller.start().catch((error) => controller.fault(error));
    timer = setInterval(() => {
      for (const [id, lease] of leases) if (Date.now() - lease.at > 45000 || !alive(lease.pid)) leases.delete(id);
      if (!leases.size && !inflight && Date.now() - lastTouch > idleMs) void close();
    }, Math.min(10000, idleMs));
    timer.unref();
    return { runtime, controller, store, close };
  } catch (error) { await close(); throw error; }
}
if (require.main === module) {
  startServer().then((server) => {
    if (!server) return;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close(); });
  }).catch(() => { process.stderr.write('Work Louder helper could not start. Check its saved data directory and restart Cursor.\n'); process.exitCode = 1; });
}
module.exports = { startServer, alive, openExternal };
