'use strict';
// Normalizes Input key events into tap, double-tap, and hold gestures.
class Gestures {
  constructor(dispatch, options = {}) {
    this.dispatch = dispatch; this.holdMs = options.holdMs ?? 650;
    this.doubleMs = options.doubleMs ?? 350; this.down = new Map(); this.last = new Map();
  }
  receive(identifier, action) {
    if (!identifier?.startsWith('cursor.') || !['press', 'release', 'click'].includes(action)) return;
    const now = Date.now();
    if (action === 'press') {
      if (this.down.has(identifier)) return;
      const entry = { at: now, held: false };
      if (identifier === 'cursor.dial.press') entry.timer = setTimeout(() => {
        entry.held = true; this.dispatch(identifier, 'hold');
      }, this.holdMs);
      this.down.set(identifier, entry); return;
    }
    const entry = this.down.get(identifier);
    if (action === 'release') {
      if (!entry) return;
      clearTimeout(entry.timer); this.down.delete(identifier);
      if (entry.held) { this.last.set(identifier, { at: now, kind: 'hold', source: 'release' }); return; }
    } else {
      if (entry) return; // Firmware can emit click between press and release.
      if (now - (this.last.get(identifier)?.at ?? 0) < 80 && this.last.get(identifier)?.source === 'release') return;
    }
    const previous = this.last.get(identifier);
    const gesture = previous?.kind === 'tap' && now - previous.at <= this.doubleMs ? 'double' : 'tap';
    this.last.set(identifier, { at: now, kind: gesture, source: action });
    this.dispatch(identifier, gesture);
  }
  clear() { for (const entry of this.down.values()) clearTimeout(entry.timer); this.down.clear(); this.last.clear(); }
}
module.exports = { Gestures };
