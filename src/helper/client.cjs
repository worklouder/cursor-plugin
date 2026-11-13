'use strict';
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { stateDirectory, privateDirectory, readPrivateJson } = require('./storage.cjs');
const { VERSION, compareVersions } = require('./version.cjs');

function request(runtime, route, data, timeout = 2000) {
  if (runtime?.protocol !== 1 || !Number.isSafeInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 || !/^[a-f0-9]{64}$/.test(runtime.token)) return Promise.reject(new Error('Invalid Work Louder helper connection'));
  return new Promise((resolve, reject) => {
    const text = data === undefined ? null : JSON.stringify(data);
    const req = http.request({ hostname: '127.0.0.1', port: runtime.port, path: route, method: text === null ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${runtime.token}`, ...(text === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }) } }, (res) => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; if (body.length > 262144) req.destroy(new Error('Work Louder response is too large')); });
      res.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (res.statusCode !== 200) throw Object.assign(new Error(value.error ?? 'Work Louder request failed'), { statusCode: res.statusCode });
          resolve(value);
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('Work Louder helper did not respond'), { code: 'ETIMEDOUT' })), timeout);
    req.once('close', () => clearTimeout(timer)); req.on('error', reject); req.end(text);
  });
}
async function ensureHelper(options = {}) {
  const directory = options.directory ?? stateDirectory(); await privateDirectory(directory);
  const runtimeFile = path.join(directory, 'runtime.json'), lockFile = path.join(directory, 'owner.lock');
  async function existing() {
    try {
      const runtime = await readPrivateJson(runtimeFile); const health = await request(runtime, '/health', undefined, 300);
      return health.protocol === 1 && Number.isSafeInteger(runtime.pid) && runtime.pid > 0 && health.pid === runtime.pid ? { runtime, health } : null;
    } catch { return null; }
  }
  const deadline = Date.now() + (options.timeout ?? 6000), retiring = new Set();
  let launched = false, spawnError, busy = false;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error('Work Louder could not start its included helper');
    const current = await existing();
    if (current) {
      const { runtime, health } = current;
      // Older Cursor windows may attach to a newer compatible helper, never downgrade it.
      if (health.version && compareVersions(health.version, VERSION) >= 0) return runtime;
      if (!retiring.has(runtime.pid)) {
        busy = !!health.busy;
        if (!busy) {
          try {
            const result = await request(runtime, '/upgrade', { version: VERSION }, 1000);
            if (result.stopping !== true) throw new Error('Work Louder did not confirm its helper update');
            retiring.add(runtime.pid);
          } catch (error) {
            if (error.statusCode === 409) busy = true;
            else if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) retiring.add(runtime.pid);
            else throw error;
          }
        }
      }
    } else if (!launched) {
      let owner;
      try { owner = await readPrivateJson(lockFile); }
      catch (error) { owner = error.code === 'ENOENT' ? null : {}; }
      let ownerAlive = !!owner;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (error) { ownerAlive = error.code === 'EPERM'; }
      }
      if (!ownerAlive) {
        const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], { detached: true, stdio: 'ignore', cwd: path.resolve(__dirname, '../..'),
          env: { ...process.env, WORKLOUDER_STATE_DIR: directory, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } });
        child.once('error', (error) => { spawnError = error; }); child.unref(); launched = true;
      }
    }
    await delay(50);
  }
  if (busy) throw new Error('Work Louder is finishing pairing or a layer write. The helper update will retry when it finishes.');
  throw new Error('Work Louder helper did not start. Restart Cursor, then run /worklouder-setup.');
}
module.exports = { request, ensureHelper };
