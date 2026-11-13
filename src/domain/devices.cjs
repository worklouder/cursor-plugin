'use strict';
// Selected-device snapshots and stale-response protection.
class Devices {
  constructor(client, changed) {
    this.client = client; this.changed = changed; this.list = []; this.info = new Map(); this.versions = new Map(); this.revision = 0;
  }
  clear() { ++this.revision; this.list = []; this.info.clear(); this.versions.clear(); this.changed(); }
  async refresh() {
    const revision = this.revision;
    const devices = await this.client.getDevices();
    if (revision === this.revision) await this.replace(devices);
  }
  async replace(devices) {
    if (!Array.isArray(devices)) throw new Error('Invalid Input device list');
    const revision = ++this.revision;
    this.list = devices.filter((d) => Number.isSafeInteger(d?.id) && d.id > 0);
    const ids = new Set(this.list.map((d) => d.id));
    for (const id of this.info.keys()) if (!ids.has(id)) { this.info.delete(id); this.versions.delete(id); }
    this.changed();
    for (const device of this.list) {
      const version = this.versions.get(device.id) ?? 0;
      try {
        const info = await this.client.getDeviceInfo(device.id);
        if (revision !== this.revision) return;
        if ((this.versions.get(device.id) ?? 0) === version) { this.info.set(device.id, info); this.changed(); }
      } catch (error) { if (revision === this.revision) this.changed(error); }
    }
  }
  update({ deviceId, deviceInfo } = {}) {
    if (!this.list.some((d) => d.id === deviceId) || !deviceInfo || typeof deviceInfo !== 'object' || Array.isArray(deviceInfo)) return;
    this.versions.set(deviceId, (this.versions.get(deviceId) ?? 0) + 1);
    this.info.set(deviceId, deviceInfo); // Replacement snapshot, never merge status fields.
    this.changed();
  }
}
module.exports = { Devices };
