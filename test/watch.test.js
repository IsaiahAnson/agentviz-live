import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classify, Tail, Watcher } from '../lib/watch.js';

test('classify maps transcript paths to sessions and sub-agents', () => {
  const root = path.join('C:', 'x', 'projects');
  const p = (...parts) => path.join(root, ...parts);
  assert.deepEqual(classify(root, p('C--proj', 'abc.jsonl')), { sessionId: 'abc' });
  assert.deepEqual(classify(root, p('C--proj', 'abc', 'subagents', 'agent-a12.jsonl')), { sessionId: 'abc', agentId: 'a12' });
  assert.equal(classify(root, p('C--proj', 'abc', 'subagents', 'agent-a12.meta.json')), null);
  assert.equal(classify(root, p('C--proj', 'memory', 'gpu.md')), null);
  assert.equal(classify(root, path.join('C:', 'elsewhere', 'a.jsonl')), null);
});

test('Tail returns only complete new lines and keeps partial ones for later', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentviz-live-'));
  const file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, '{"a":1}\n{"a":2}\n{"a":');
  const tail = new Tail(file);
  assert.deepEqual(await tail.readNew(), [{ a: 1 }, { a: 2 }]);
  await fs.appendFile(file, '3}\nnot json\n{"a":4}\n');
  assert.deepEqual(await tail.readNew(), [{ a: 3 }, { a: 4 }]);
  assert.deepEqual(await tail.readNew(), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Tail keeps a UTF-8 character that is split across two writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentviz-live-'));
  const file = path.join(dir, 's.jsonl');
  const line = Buffer.from('{"s":"→ done"}\n');
  const split = line.indexOf(0xe2) + 1; // inside the 3-byte arrow
  await fs.writeFile(file, line.subarray(0, split));
  const tail = new Tail(file);
  assert.deepEqual(await tail.readNew(), []);
  await fs.appendFile(file, line.subarray(split));
  assert.deepEqual(await tail.readNew(), [{ s: '→ done' }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Tail starts over when a file is rewritten shorter', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentviz-live-'));
  const file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, '{"a":1}\n{"a":2}\n');
  const tail = new Tail(file);
  await tail.readNew();
  await fs.writeFile(file, '{"b":1}\n');
  assert.deepEqual(await tail.readNew(), [{ b: 1 }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Watcher skips history in existing files and reads new files from the start', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentviz-live-'));
  const proj = path.join(root, 'C--proj');
  await fs.mkdir(path.join(proj, 'old', 'subagents'), { recursive: true });
  await fs.writeFile(path.join(proj, 'old.jsonl'), '{"n":"history"}\n');
  await fs.writeFile(path.join(proj, 'old', 'subagents', 'agent-a1.jsonl'), '{"n":"sub history"}\n');
  const seen = [];
  const watcher = new Watcher(root, (ctx, line) => seen.push([ctx.sessionId, ctx.agentId ?? null, line.n]));
  await watcher.start();
  await fs.appendFile(path.join(proj, 'old.jsonl'), '{"n":"live"}\n');
  await fs.writeFile(path.join(proj, 'new.jsonl'), '{"n":"first"}\n');
  watcher.enqueue(path.join(proj, 'old.jsonl'));
  watcher.enqueue(path.join(proj, 'new.jsonl'));
  await watcher.flush();
  watcher.stop();
  assert.deepEqual(seen.sort(), [
    ['new', null, 'first'],
    ['old', null, 'live'],
  ]);
  await fs.rm(root, { recursive: true, force: true });
});
