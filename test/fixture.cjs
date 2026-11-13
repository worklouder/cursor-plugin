'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
function frame(text) {
  const payload = Buffer.from(JSON.stringify(text));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}
async function inputServer(handler) {
  const sockets = new Set(); const calls = [];
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15; let size = buffered[1] & 127, offset = 2;
        if (size === 126) { if (buffered.length < 4) return; size = buffered.readUInt16BE(2); offset = 4; }
        if (size === 127) { socket.destroy(); return; }
        const masked = !!(buffered[1] & 128), maskBytes = masked ? 4 : 0;
        if (buffered.length < offset + maskBytes + size) return;
        const mask = buffered.subarray(offset, offset + maskBytes); offset += maskBytes;
        const payload = Buffer.from(buffered.subarray(offset, offset + size));
        if (masked) for (let i = 0; i < size; i++) payload[i] ^= mask[i % 4];
        buffered = buffered.subarray(offset + size);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const call = JSON.parse(payload.toString()); calls.push({ ...call, at: Date.now() });
        Promise.resolve(handler(call)).then((result) => {
          if (result === undefined || socket.destroyed) return;
          socket.write(frame({ jsonrpc: '2.0', id: call.id, ...(result.error ? result : { result }) }));
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `ws://127.0.0.1:${server.address().port}/input`,
    notify: (method, params) => { for (const socket of sockets) socket.write(frame({ jsonrpc: '2.0', method, params })); },
    disconnect: () => { for (const socket of sockets) socket.destroy(); },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}
function credentials(initial = null) {
  let value = initial;
  return { get: async () => value, set: async (next) => { value = next; }, delete: async () => { value = null; } };
}
module.exports = { inputServer, credentials };
