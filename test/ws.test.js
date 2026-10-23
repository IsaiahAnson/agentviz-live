import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub, acceptKey, allowOrigin, frame, parseFrames } from '../lib/ws.js';

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('allowOrigin lets the file:// wallpaper and localhost pages in, nothing else', () => {
  for (const o of [undefined, 'null', 'file://', 'http://localhost:4747', 'http://127.0.0.1', 'http://[::1]:8000']) assert.ok(allowOrigin(o), o);
  for (const o of ['https://example.com', 'http://localhost.evil.com', 'http://127.0.0.1.nip.io']) assert.ok(!allowOrigin(o), o);
});

test('frames round-trip at every length encoding, masked like a client sends', () => {
  for (const len of [0, 5, 125, 126, 300, 65535, 70000]) {
    const payload = Buffer.alloc(len, 7);
    const f = frame(0x1, payload);
    const mask = Buffer.from([1, 2, 3, 4]);
    const headLen = f.length - len;
    const masked = Buffer.concat([f.subarray(0, headLen), mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))]);
    masked[1] |= 0x80;
    const [frames, rest] = parseFrames(masked);
    assert.equal(frames.length, 1, `len ${len}`);
    assert.equal(frames[0].opcode, 0x1);
    assert.deepEqual(frames[0].payload, payload);
    assert.equal(rest.length, 0);
  }
});

test('parseFrames leaves an incomplete frame for the next chunk', () => {
  const f = frame(0x1, Buffer.from('hello'));
  const [frames, rest] = parseFrames(f.subarray(0, 4));
  assert.equal(frames.length, 0);
  assert.equal(rest.length, 4);
});

async function listen(hub) {
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket) => hub.upgrade(req, socket));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('a WebSocket client receives broadcast events as JSON', async () => {
  const hub = new Hub();
  const server = await listen(hub);
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const got = new Promise((resolve) => {
    ws.onmessage = (m) => resolve(JSON.parse(m.data));
  });
  hub.broadcast({ type: 'tool_call', name: 'Bash' });
  assert.deepEqual(await got, { type: 'tool_call', name: 'Bash' });
  const closed = new Promise((r) => (ws.onclose = r));
  ws.close();
  await closed;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hub.clients.size, 0);
  server.close();
});

test('an upgrade from a foreign website is refused', async () => {
  const hub = new Hub();
  const server = await listen(hub);
  const status = await new Promise((resolve) => {
    const req = http.request({
      port: server.address().port,
      host: '127.0.0.1',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'https://example.com' },
    });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('upgrade', () => resolve(101));
    req.on('error', () => resolve('error'));
    req.end();
  });
  assert.equal(status, 403);
  assert.equal(hub.clients.size, 0);
  server.close();
});
