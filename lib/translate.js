// Turns Claude Code transcript lines into agentviz events: thinking,
// tool_call, tool_result, token, response and idle. The page has one global
// state, so this keeps it in step with whether any session is working.
const INTERRUPTED = /^\[Request interrupted by user/;
export const END_MS = 250; // a final message lands as several lines; wait for the last
export const SETTLE_MS = 5500; // the page holds a response bloom for 5s
export const STALE_MS = 3 * 60e3; // a turn silent this long counts as stopped
const FORGET_MS = 30 * 60e3;
const TOKEN_GAP_MS = 45;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

export function agentLabel(cwd) {
  return String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || 'claude';
}

export class Translator {
  constructor({ send, now = () => Date.now(), schedule = setTimeout } = {}) {
    Object.assign(this, { send, now, schedule });
    this.sessions = new Map();
    this.state = 'idle'; // what the page is showing: idle, thinking or done
    this.doneAt = 0;
  }

  session(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, agent: 'claude', working: false, lastSeen: 0, pending: new Map(), end: null };
      this.sessions.set(id, s);
    }
    return s;
  }

  think(s) {
    if (this.state === 'thinking') return;
    this.state = 'thinking';
    this.send({ type: 'thinking', agent: s.agent });
  }

  apply(ctx, d) {
    if (!d || typeof d !== 'object' || d.isMeta) return;
    if (d.type !== 'user' && d.type !== 'assistant') return;
    const s = this.session(ctx.sessionId);
    if (d.cwd) s.agent = agentLabel(d.cwd);
    s.lastSeen = this.now();
    const content = d.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    if (d.type === 'user') {
      const results = blocks.filter((b) => b?.type === 'tool_result');
      if (results.length) {
        for (const r of results) {
          const name = s.pending.get(r.tool_use_id) ?? 'tool';
          s.pending.delete(r.tool_use_id);
          this.send({ type: 'tool_result', agent: s.agent, name });
        }
        if (!ctx.agentId) s.working = true; // a result means the turn is still open
        if (this.state === 'idle') this.state = 'thinking'; // the page does the same
        return;
      }
      if (ctx.agentId) return; // the brief a sub-agent starts with
      const text = textOf(content).trim();
      if (!text) return;
      s.end = null;
      if (INTERRUPTED.test(text)) {
        s.working = false;
        s.pending.clear();
        return;
      }
      s.working = true;
      this.think(s);
      return;
    }

    for (const b of blocks) {
      if (b?.type === 'thinking' || b?.type === 'redacted_thinking') this.think(s);
      else if (b?.type === 'tool_use') {
        const name = b.name ?? 'tool';
        s.pending.set(b.id, name);
        this.send({ type: 'tool_call', agent: s.agent, name });
      }
    }
    if (ctx.agentId) return; // a sub-agent finishing doesn't end the parent's turn
    if (d.message?.stop_reason === 'end_turn') {
      const id = d.message.id ?? d.uuid;
      const len = textOf(content).length;
      if (s.end?.id === id) {
        s.end.at = s.lastSeen;
        s.end.len = Math.max(s.end.len, len);
      } else s.end = { id, at: s.lastSeen, len };
    } else s.working = true;
  }

  // The final answer streams as a burst of tokens, then blooms.
  respond(s, len) {
    const n = Math.max(12, Math.min(46, Math.round(len / 50)));
    for (let i = 0; i < n; i++) this.schedule(() => this.send({ type: 'token', agent: s.agent }), i * TOKEN_GAP_MS);
    this.schedule(() => this.send({ type: 'response', agent: s.agent }), n * TOKEN_GAP_MS + 200);
    this.state = 'done';
    this.doneAt = this.now() + n * TOKEN_GAP_MS + 200;
  }

  // Runs a few times a second: finishes turns, and wakes or rests the field.
  tick() {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (s.end && now - s.end.at >= END_MS) {
        const { len } = s.end;
        s.end = null;
        s.working = false;
        s.pending.clear();
        this.respond(s, len);
      }
      if (!s.working && !s.end && now - s.lastSeen > FORGET_MS) this.sessions.delete(s.id);
    }
    if (this.state === 'done' && now - this.doneAt >= SETTLE_MS) this.state = 'idle';
    const busy = [...this.sessions.values()].filter((s) => s.working && now - s.lastSeen < STALE_MS);
    if (busy.length && this.state === 'idle') {
      this.think(busy.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a)));
    } else if (!busy.length && this.state === 'thinking') {
      this.state = 'idle';
      this.send({ type: 'idle' });
    }
  }

  stats() {
    const now = this.now();
    const working = [...this.sessions.values()].filter((s) => s.working && now - s.lastSeen < STALE_MS);
    return { state: this.state, sessions: this.sessions.size, working: working.map((s) => s.agent) };
  }
}
