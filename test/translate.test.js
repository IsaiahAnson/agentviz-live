import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Translator, agentLabel, END_MS, SETTLE_MS, STALE_MS } from '../lib/translate.js';

// A translator on a fake clock that runs scheduled sends right away.
function rig() {
  const sent = [];
  const clock = { t: 1_000_000 };
  const tr = new Translator({ send: (e) => sent.push(e), now: () => clock.t, schedule: (fn) => fn() });
  const types = () => sent.splice(0).map((e) => (e.name ? `${e.type}:${e.name}` : e.type));
  const later = (ms) => {
    clock.t += ms;
    tr.tick();
  };
  return { tr, types, later };
}

const main = { sessionId: 's1' };
const cwd = 'C:\\Users\\isaia\\Projects\\agent-hq';
const prompt = (text = 'fix the bug') => ({ type: 'user', cwd, message: { role: 'user', content: text } });
const toolUse = (id, name, stop = 'tool_use') => ({
  type: 'assistant',
  cwd,
  message: { id: 'm1', stop_reason: stop, content: [{ type: 'tool_use', id, name, input: {} }] },
});
const toolResult = (id) => ({ type: 'user', cwd, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const say = (msgId, block, stop = 'end_turn') => ({ type: 'assistant', cwd, message: { id: msgId, stop_reason: stop, content: [block] } });

test('agentLabel names the project folder', () => {
  assert.equal(agentLabel(cwd), 'agent-hq');
  assert.equal(agentLabel('/home/me/repo/'), 'repo');
  assert.equal(agentLabel(undefined), 'claude');
});

test('a prompt starts thinking and tool calls go out and come back by name', () => {
  const { tr, types } = rig();
  tr.apply(main, prompt());
  tr.apply(main, toolUse('t1', 'Bash'));
  tr.apply(main, toolResult('t1'));
  assert.deepEqual(types(), ['thinking', 'tool_call:Bash', 'tool_result:Bash']);
});

test('thinking is sent once while the field is already thinking', () => {
  const { tr, types } = rig();
  tr.apply(main, prompt());
  tr.apply(main, say('m1', { type: 'thinking', thinking: '' }, 'tool_use'));
  tr.apply(main, prompt('and another thing'));
  assert.deepEqual(types(), ['thinking']);
});

test('a final answer written as several lines blooms once, after a token burst', () => {
  const { tr, types, later } = rig();
  tr.apply(main, prompt());
  types();
  tr.apply(main, say('m9', { type: 'thinking', thinking: '' }));
  tr.apply(main, say('m9', { type: 'text', text: 'x'.repeat(1000) }));
  later(END_MS - 1);
  assert.deepEqual(types(), []);
  later(1);
  const out = types();
  assert.equal(out.filter((t) => t === 'response').length, 1);
  assert.equal(out.at(-1), 'response');
  assert.equal(out.filter((t) => t === 'token').length, 20);
  assert.equal(tr.state, 'done');
  later(SETTLE_MS + 5000);
  assert.deepEqual(types(), []); // the page settles to idle by itself
  assert.equal(tr.state, 'idle');
});

test('an interrupted turn rests the field on the next tick', () => {
  const { tr, types, later } = rig();
  tr.apply(main, prompt());
  tr.apply(main, prompt('[Request interrupted by user for tool use]'));
  later(250);
  assert.deepEqual(types(), ['thinking', 'idle']);
});

test('a turn that goes silent counts as stopped after STALE_MS', () => {
  const { tr, types, later } = rig();
  tr.apply(main, prompt());
  types();
  later(STALE_MS - 1000);
  assert.deepEqual(types(), []);
  later(2000);
  assert.deepEqual(types(), ['idle']);
});

test('another session still working wakes the field after a response settles', () => {
  const { tr, types, later } = rig();
  tr.apply(main, prompt());
  tr.apply({ sessionId: 's2' }, { ...prompt(), cwd: 'C:\\x\\branchline' });
  tr.apply(main, say('m1', { type: 'text', text: 'done' }));
  later(END_MS);
  types();
  later(SETTLE_MS + 1000);
  const out = types();
  assert.deepEqual(out, ['thinking']);
});

test('sub-agents add tool traffic but neither start nor end the turn', () => {
  const { tr, types, later } = rig();
  const sub = { sessionId: 's1', agentId: 'a1' };
  tr.apply(main, prompt());
  tr.apply(sub, prompt('You are a search agent...'));
  tr.apply(sub, toolUse('t7', 'Grep'));
  tr.apply(sub, toolResult('t7'));
  tr.apply(sub, say('m3', { type: 'text', text: 'found it' }));
  later(END_MS);
  assert.deepEqual(types(), ['thinking', 'tool_call:Grep', 'tool_result:Grep']);
  assert.equal(tr.state, 'thinking');
});

test('meta lines and other line types are ignored', () => {
  const { tr, types } = rig();
  tr.apply(main, { ...prompt(), isMeta: true });
  tr.apply(main, { type: 'system', subtype: 'stop_hook_summary' });
  tr.apply(main, { type: 'attachment' });
  tr.apply(main, null);
  assert.deepEqual(types(), []);
});
