// Follows every Claude Code transcript under ~/.claude/projects and hands each
// new line to onLine. Files that already exist at start are read from their
// end, so only live activity comes through.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_READ = 4e6; // a bigger jump (a rewrite, a huge paste) only keeps its tail
const ACTIVE_MS = 10 * 60e3; // files that grew this recently get polled too

export function classify(root, file) {
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  const name = parts[parts.length - 1];
  if (parts.length === 2 && name.endsWith('.jsonl')) return { sessionId: name.slice(0, -6) };
  if (parts.length === 4 && parts[2] === 'subagents') {
    const m = name.match(/^agent-(.+)\.jsonl$/);
    if (m) return { sessionId: parts[1], agentId: m[1] };
  }
  return null;
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // half-written or foreign line: skip it
    }
  }
  return out;
}

// Reads the complete lines appended to a file since the last call. Partial
// lines stay as bytes, so a UTF-8 character split across writes survives.
export class Tail {
  constructor(file, offset = 0) {
    this.file = file;
    this.offset = offset;
    this.rest = Buffer.alloc(0);
    this.changedAt = 0;
  }

  async readNew() {
    let handle;
    try {
      handle = await fsp.open(this.file, 'r');
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.rest = Buffer.alloc(0);
      }
      if (size === this.offset) return [];
      let start = this.offset;
      let skipPartial = false;
      if (size - start > MAX_READ) {
        start = size - MAX_READ;
        this.rest = Buffer.alloc(0);
        skipPartial = true;
      }
      const chunk = Buffer.alloc(size - start);
      await handle.read(chunk, 0, chunk.length, start);
      this.offset = size;
      this.changedAt = Date.now();
      let buf = Buffer.concat([this.rest, chunk]);
      if (skipPartial) buf = buf.subarray(buf.indexOf(0x0a) + 1);
      const cut = buf.lastIndexOf(0x0a) + 1;
      this.rest = Buffer.from(buf.subarray(cut));
      return parseLines(buf.subarray(0, cut).toString('utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    } finally {
      await handle?.close();
    }
  }
}

export class Watcher {
  constructor(root, onLine) {
    this.root = root;
    this.onLine = onLine;
    this.tails = new Map();
    this.queue = new Set();
    this.timer = null;
    this.busy = Promise.resolve();
  }

  async start() {
    for (const file of await this.list()) {
      const st = await fsp.stat(file).catch(() => null);
      if (!st) continue;
      const tail = new Tail(file, st.size);
      tail.changedAt = st.mtimeMs;
      this.tails.set(file, tail);
    }
    try {
      this.fsWatcher = fs.watch(this.root, { recursive: true }, (_event, name) => {
        if (name) this.enqueue(path.join(this.root, name.toString()));
      });
      this.fsWatcher.on('error', () => {});
    } catch {
      // polling below still picks up changes
    }
    this.pollTimer = setInterval(() => this.poll(), 2000);
    this.scanTimer = setInterval(() => this.scan(), 30000);
  }

  stop() {
    this.fsWatcher?.close();
    clearInterval(this.pollTimer);
    clearInterval(this.scanTimer);
    clearTimeout(this.timer);
  }

  // Every transcript: <project>/<session>.jsonl and <project>/<session>/subagents/agent-*.jsonl
  async list() {
    const files = [];
    const dirs = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs.filter((d) => d.isDirectory())) {
      const projectDir = path.join(this.root, dir.name);
      const entries = await fsp.readdir(projectDir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(projectDir, e.name);
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
        else if (e.isDirectory() && e.name !== 'memory') {
          const subDir = path.join(full, 'subagents');
          for (const n of await fsp.readdir(subDir).catch(() => [])) files.push(path.join(subDir, n));
        }
      }
    }
    return files.filter((f) => classify(this.root, f));
  }

  // fs.watch can miss events on Windows, so recently active files get polled.
  poll() {
    const cutoff = Date.now() - ACTIVE_MS;
    for (const [file, tail] of this.tails) if (tail.changedAt >= cutoff) this.enqueue(file);
  }

  // Catches new transcripts that fs.watch missed.
  async scan() {
    for (const file of await this.list()) if (!this.tails.has(file)) this.enqueue(file);
  }

  enqueue(file) {
    if (!classify(this.root, file)) return;
    this.queue.add(file);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 60);
  }

  flush() {
    const files = [...this.queue];
    this.queue.clear();
    this.busy = this.busy
      .then(async () => {
        for (const file of files) await this.process(file);
      })
      .catch((err) => console.error('[watch]', err.message));
    return this.busy;
  }

  async process(file) {
    const ctx = classify(this.root, file);
    if (!ctx) return;
    let tail = this.tails.get(file);
    if (!tail) {
      // created after start, so every line in it is new
      tail = new Tail(file, 0);
      this.tails.set(file, tail);
    }
    for (const line of await tail.readNew()) this.onLine(ctx, line);
  }
}
