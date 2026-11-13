'use strict';
// Computes and sends Agent Key lighting state.
const { COLORS } = require('./sessions.cjs');
class Lighting {
  constructor(client, desired, fault) {
    this.client = client; this.desired = desired; this.fault = fault;
    this.applied = new Map(); this.retryAt = new Map(); this.active = false; this.version = 0;
  }
  reset() { ++this.version; this.applied.clear(); this.retryAt.clear(); }
  async flush() {
    if (this.active || !this.client.authenticated) return;
    this.active = true;
    try {
      for (let index = 0; index < 6; index++) {
        // Re-read before each send so a burst of hooks collapses to the latest state.
        const target = this.desired();
        if (!target) return;
        const { deviceId, slots, selectedId, brightness } = target;
        const slot = slots[index];
        const fields = { color: COLORS[slot?.state ?? (slot?.action ? 'idle' : 'off')], brightness: slot ? brightness : 0, effect: slot?.id && slot.id === selectedId ? 6 : 1, speed: 0.35 };
        const key = `${deviceId}:${index}`; const signature = JSON.stringify(fields);
        const version = this.version;
        if (this.applied.get(key) === signature || (this.retryAt.get(key) ?? 0) > Date.now()) continue;
        try {
          const result = await this.client.setKeyLighting({ deviceId, identifier: `cursor.agent.${index + 1}`, isRegex: false, ...fields });
          if (result?.applied !== true) throw new Error('Input did not acknowledge lighting');
          if (version === this.version) { this.applied.set(key, signature); this.retryAt.delete(key); }
        } catch (error) { if (version === this.version) this.retryAt.set(key, Date.now() + 15000); this.fault(error); }
      }
    } finally { this.active = false; }
  }
}
module.exports = { Lighting };
