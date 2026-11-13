'use strict';
// Private persistence used by the shared local helper.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function stateDirectory(platform = process.platform, environment = process.env, home = os.homedir()) {
  if (environment.WORKLOUDER_STATE_DIR) return environment.WORKLOUDER_STATE_DIR;
  if (platform === 'win32') {
    const root = environment.LOCALAPPDATA || environment.APPDATA || home;
    return path.win32.join(root, 'Work Louder', 'Cursor Plugin');
  }
  return path.join(home, 'Library', 'Application Support', 'Work Louder', 'Cursor Plugin');
}
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe Work Louder data directory');
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
}
async function readPrivateJson(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe Work Louder data file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function atomicJson(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
class Store {
  constructor(directory = stateDirectory()) {
    this.directory = directory; this.file = path.join(directory, 'state.json'); this.data = {}; this.tail = Promise.resolve();
  }
  async load() {
    await privateDirectory(this.directory);
    try {
      const data = await readPrivateJson(this.file);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Work Louder settings');
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Work Louder settings could not be read. No saved data was overwritten.'); }
  }
  update(change) {
    const task = this.tail.then(async () => {
      const next = structuredClone(this.data); change(next);
      await atomicJson(this.file, next); this.data = next;
    });
    this.tail = task.catch(() => {}); return task;
  }
  credentials() {
    return {
      get: async () => {
        const value = this.data.credentials;
        return typeof value?.applicationId === 'string' && typeof value?.token === 'string' ? { ...value } : null;
      },
      set: (credentials) => this.update((data) => { data.credentials = credentials; delete data.inputPermissionRevoked; }),
      delete: () => this.update((data) => { delete data.credentials; data.inputPermissionRevoked = true; data.inputAuthorizationAttempted = true; }),
    };
  }
}
module.exports = { Store, stateDirectory, privateDirectory, readPrivateJson, atomicJson };
