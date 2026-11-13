'use strict';
const path = require('node:path');
const { ensureHelper, request } = require('../helper/client.cjs');
const { normalizeHook } = require('../domain/sessions.cjs');

function hookEnvironment() {
  const scripts = path.resolve(__dirname, '../../scripts');
  return { PATH: [scripts, process.env.PATH].filter(Boolean).join(path.delimiter) };
}

async function hook(name) {
  const output = () => {
    const response = name === 'beforeSubmitPrompt' ? { continue: true } : {};
    if (name === 'sessionStart' && process.env.CURSOR_CODE_REMOTE !== 'true') response.env = hookEnvironment();
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };
  const timer = setTimeout(() => { output(); process.exit(0); }, 2200);
  try {
    if (process.env.CURSOR_CODE_REMOTE === 'true') return;
    let text = '';
    for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 1048576) return; }
    if (name === 'sessionStart') return;
    const input = JSON.parse(text || '{}'); input.hook_event_name = name;
    input.workspace_roots ||= process.env.CURSOR_PROJECT_DIR ? [process.env.CURSOR_PROJECT_DIR] : [];
    const event = normalizeHook(input); if (!event && name !== 'workspaceOpen') return;
    const runtime = await ensureHelper({ timeout: 1600 }); if (event) await request(runtime, '/event', event, 500);
  } catch { /* Observational hooks must never block chat use. */ }
  finally { clearTimeout(timer); output(); }
}

module.exports = { hook, hookEnvironment };
