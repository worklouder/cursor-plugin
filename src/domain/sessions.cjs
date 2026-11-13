'use strict';
// Tracks observed Cursor chat lifecycle state and slot assignment.
const path = require('node:path');
const COLORS = { idle: 0xffffff, working: 0x2864ff, complete: 0x26cc62, waiting: 0xffb020, error: 0xff3030, off: 0 };
const HOOKS = ['sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'afterAgentResponse', 'stop'];

function normalizeHook(input) {
  const id = input?.conversation_id ?? input?.session_id;
  if (typeof id !== 'string' || !id || id.length > 256 || !HOOKS.includes(input.hook_event_name)) return null;
  // Deliberately omit prompts, tool inputs, thoughts, transcripts and account details.
  return {
    conversation_id: id, hook_event_name: input.hook_event_name,
    generation_id: typeof input.generation_id === 'string' ? input.generation_id.slice(0, 256) : undefined,
    status: ['completed', 'aborted', 'error'].includes(input.status) ? input.status : undefined,
    model: typeof input.model === 'string' ? input.model.slice(0, 128) : undefined,
    workspace_roots: Array.isArray(input.workspace_roots) ? input.workspace_roots.filter((x) => typeof x === 'string').slice(0, 16) : [],
    at: Number.isFinite(input.at) && Math.abs(input.at - Date.now()) < 60000 ? input.at : Date.now(),
  };
}

class Sessions {
  constructor() { this.items = new Map(); this.selectedId = null; this.retired = new Map(); }
  receive(raw) {
    const event = normalizeHook(raw);
    if (!event) return false;
    const id = event.conversation_id;
    if (event.hook_event_name === 'sessionEnd') {
      this.items.delete(id); if (this.selectedId === id) this.selectedId = null; return true;
    }
    let session = this.items.get(id);
    if (!session) {
      session = { id, title: `${path.basename(event.workspace_roots[0] ?? 'Chat')} · ${id.slice(0, 8)}`, state: 'idle', updated: 0, roots: event.workspace_roots };
      this.items.set(id, session);
    }
    if (event.at < session.updated) return false;
    if (event.generation_id && session.generation && event.generation_id !== session.generation) {
      if (this.retired.get(id)?.has(event.generation_id)) return false;
      if (event.hook_event_name !== 'beforeSubmitPrompt') return false;
      const retired = this.retired.get(id) ?? new Set();
      retired.add(session.generation); this.retired.set(id, retired);
    }
    session.generation = event.generation_id ?? session.generation;
    session.model = event.model ?? session.model;
    session.updated = event.at;
    switch (event.hook_event_name) {
      case 'beforeSubmitPrompt': this.selectedId = id; session.state = 'working'; break;
      case 'preToolUse': case 'postToolUse': session.state = 'working'; break;
      case 'postToolUseFailure': session.state = 'error'; break;
      case 'stop': session.state = event.status === 'error' ? 'error' : event.status === 'aborted' ? 'idle' : 'complete'; break;
      // A response can be followed by more tool use; only stop completes a turn.
    }
    // Bound memory without dropping active work first.
    if (this.items.size > 200) {
      const oldest = [...this.items.values()].filter((x) => x.state !== 'working' && x.id !== this.selectedId).sort((a, b) => a.updated - b.updated)[0];
      if (oldest) { this.items.delete(oldest.id); this.retired.delete(oldest.id); }
    }
    return true;
  }
  select(id) { const s = this.items.get(id); if (s) { this.selectedId = id; if (s.state === 'complete') s.state = 'idle'; } }
  slots(mode = 'recent', pinned = [], assignments = []) {
    const all = [...this.items.values()].sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    if (mode === 'priority') {
      const rank = { waiting: 0, error: 1, complete: 2, working: 3, idle: 4 };
      all.sort((a, b) => rank[a.state] - rank[b.state] || b.updated - a.updated);
    }
    const slots = mode === 'pinned' ? pinned.map((id) => this.items.get(id) ?? null)
      : mode === 'custom' ? assignments.map((value) => typeof value === 'string' ? this.items.get(value) ?? null : value?.command ? { action: value } : null)
      : all;
    return Array.from({ length: 6 }, (_, i) => slots[i] ?? null);
  }
}
module.exports = { Sessions, COLORS, HOOKS, normalizeHook };
