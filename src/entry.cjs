'use strict';
const { ensureHelper } = require('./helper/client.cjs');
const { hook } = require('./hooks/handler.cjs');
const { mcp, TOOLS } = require('./mcp/server.cjs');

async function main() {
  switch (process.argv[2]) {
    case 'hook': await hook(process.argv[3]); break;
    case 'mcp': await mcp(); break;
    case 'start': await ensureHelper(); break;
    default: throw new Error('Use the included Cursor plugin to start Work Louder');
  }
}
if (require.main === module) main().catch((error) => { process.stderr.write(`Work Louder: ${error.message}\n`); process.exitCode = 1; });
module.exports = { hook, mcp, TOOLS };
