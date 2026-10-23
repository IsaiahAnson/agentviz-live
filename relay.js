// agentviz-live: lights up the agentviz page (the Lively wallpaper) from your
// Claude Code sessions. It tails ~/.claude/projects, so no hooks are needed,
// and relays agentviz events on ws://localhost:8765. Local only.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Hub, allowOrigin } from './lib/ws.js';
import { Watcher } from './lib/watch.js';
import { Translator } from './lib/translate.js';

const PORT = Number(process.env.AGENTVIZ_PORT || 8765);
const ROOT = process.env.CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const VERBOSE = process.argv.includes('-v');

const hub = new Hub();
const translator = new Translator({
  send: (event) => {
    if (VERBOSE) console.log(new Date().toLocaleTimeString(), event.type.padEnd(11), event.agent ?? '', event.name ?? '');
    hub.broadcast(event);
  },
});
const watcher = new Watcher(ROOT, (ctx, line) => translator.apply(ctx, line));

function readBody(req, limit = 64e3) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Other local agents can push agentviz events here, like agentviz's own relay.
async function receiveEvent(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    for (const event of Array.isArray(body) ? body : [body]) if (event?.type) hub.broadcast(event);
    res.writeHead(204).end();
  } catch {
    res.writeHead(400).end();
  }
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!allowOrigin(req.headers.origin)) return res.writeHead(403).end();
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ clients: hub.clients.size, ...translator.stats() }));
  }
  if (url.pathname === '/event' && req.method === 'POST') return receiveEvent(req, res);
  res.writeHead(404).end();
}

await watcher.start();
setInterval(() => translator.tick(), 250);

// Browsers may resolve localhost to either address, so listen on both.
for (const host of ['127.0.0.1', '::1']) {
  const server = http.createServer(handle);
  server.on('upgrade', (req, socket) => hub.upgrade(req, socket));
  server.on('error', (err) => {
    if (host === '::1') return; // no IPv6 loopback: 127.0.0.1 is enough
    console.error(err.code === 'EADDRINUSE' ? `port ${PORT} is already in use (relay already running?)` : err.message);
    process.exit(1);
  });
  server.listen(PORT, host, () => {
    if (host === '127.0.0.1') console.log(`agentviz-live  →  ws://localhost:${PORT}  (watching ${ROOT}, ${watcher.tails.size} transcripts)`);
  });
}
