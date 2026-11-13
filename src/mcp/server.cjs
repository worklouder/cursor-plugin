'use strict';
const crypto = require('node:crypto');
const readline = require('node:readline');
const { ensureHelper, request } = require('../helper/client.cjs');
const { VERSION } = require('../helper/version.cjs');

const TOOLS = [
  { name: 'worklouder_status', description: 'Read the local Work Louder connection, assigned observed Cursor chats, and supported controls. Does not change the device.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'worklouder_setup', description: 'Open the local Work Louder setup page when the user asks to set up, pair, or configure their device. Input requires the user to approve authorization; the page provides a manual pairing retry and layer installation controls.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
];

async function mcp() {
  const id = crypto.randomUUID(); let runtime, timer, initializing, closed = false, reportedError;
  const send = (value) => { if (!closed) process.stdout.write(`${JSON.stringify(value)}\n`); };
  const reportState = (value) => {
    if (typeof value?.lastError === 'string' && value.lastError && value.lastError !== reportedError) {
      reportedError = value.lastError;
      process.stderr.write(`Work Louder: ${value.lastError}\n`);
    }
  };
  async function connect() {
    if (closed) throw new Error('Cursor connection closed');
    if (runtime) {
      const current = runtime;
      try { await request(current, '/health', undefined, 500); return current; }
      catch { if (runtime === current) runtime = null; }
    }
    if (closed) throw new Error('Cursor connection closed');
    if (!initializing) initializing = (async () => {
      const next = await ensureHelper();
      if (closed) throw new Error('Cursor connection closed');
      reportState(await request(next, '/lease', { id, pid: process.pid })); runtime = next;
      return next;
    })().finally(() => { initializing = null; });
    return initializing;
  }
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.length > 1048576) { lines.close(); return; }
    let message;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return; }
    if (!Object.hasOwn(message, 'id')) return;
    void (async () => {
      let result;
      switch (message.method) {
        case 'initialize':
          result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'worklouder', version: VERSION } };
          if (!timer) {
            timer = setInterval(() => {
              if (closed) return;
              const current = runtime;
              if (!current) { void connect().catch(() => {}); return; }
              request(current, '/lease', { id, pid: process.pid }).then(reportState).catch(() => { if (runtime === current) runtime = null; void connect().catch(() => {}); });
            }, 10000); timer.unref();
          }
          void connect().catch(() => {}); break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: TOOLS }; break;
        case 'tools/call': {
          const name = message.params?.name;
          if (!TOOLS.some((tool) => tool.name === name)) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } }); return; }
          try {
            const live = await connect();
            const value = name === 'worklouder_setup' ? await request(live, '/setup-open', {}) : await request(live, '/state');
            reportState(value);
            result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
          } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
          break;
        }
        default: send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      send({ jsonrpc: '2.0', id: message.id, result });
    })().catch(() => send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Work Louder request failed' } }));
  });
  await new Promise((resolve) => lines.once('close', resolve)); closed = true; clearInterval(timer);
  await initializing?.catch(() => {}); clearInterval(timer);
  if (runtime) await request(runtime, '/release', { id }).catch(() => {});
}

module.exports = { mcp, TOOLS };
