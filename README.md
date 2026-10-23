# agentviz-live

Makes the [agentviz](https://github.com/31780/agentviz) wallpaper react to your live Claude Code sessions.

It tails the transcripts in `~/.claude/projects`, the same way Agent HQ does, so no hooks are needed. It turns what happens into agentviz events on `ws://localhost:8765`, which is the address the agentviz page connects to by default. No dependencies. Node 22+.

```bash
npm start          # or: node relay.js -v   (prints every event)
npm test
```

| In Claude Code | Event | On the wallpaper |
|---|---|---|
| You send a prompt, Claude is thinking | `thinking` | the field fires |
| A tool call (sub-agents too) | `tool_call` | a violet pulse runs out to a cluster |
| The tool returns | `tool_result` | the pulse comes back |
| The final answer | `token` burst, then `response` | the core streams, then a full bloom |
| Interrupted, or no new lines for 3 min | `idle` | slow breathing |

The page shows one state for all sessions. If one session finishes while another is still working, the field wakes again once the bloom settles.

## Start at login

A shortcut in the Startup folder runs the relay hidden:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agentviz-live.lnk
```

To stop it running at login, delete that shortcut. To check that it's up, open `http://127.0.0.1:8765/healthz`, which shows clients, state and working sessions.

## Other agents

To make other agents show up, POST agentviz events to the relay:

```bash
curl -X POST http://127.0.0.1:8765/event -d "{\"type\":\"thinking\",\"agent\":\"ollama\"}"
```

The relay only listens on loopback. It refuses WebSocket and HTTP requests that come from other websites, and allows only file://, `null` and localhost origins.

Environment variables: `AGENTVIZ_PORT` (default 8765), `CLAUDE_PROJECTS` (default `~/.claude/projects`).
