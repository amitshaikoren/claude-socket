# claude-bridge

An OpenAI- and Anthropic-compatible API server that looks like an LLM running on your
hardware. Clients point at a base URL, present an API token, and get back the responses,
streaming, and usage accounting they expect. Behind it there is no model server — every
request is handed to the `claude` CLI already installed on the machine.

```
  OpenAI SDK ─┐
  Cursor    ──┤   http://host:8787/v1        ┌── claude --print --input-format stream-json
  Open WebUI ─┼──▶ claude-bridge ────────────┤   (one long-lived process per conversation)
  curl      ──┤    (token auth, SSE, usage)  └── your existing Claude Code auth
  LangChain ──┘
```

## Quick start

Requires Node 24+ (TypeScript runs natively, no build step) and a working `claude` CLI.

```bash
npm install          # dev-only: typescript + @types/node. Zero runtime dependencies.
npm start            # or: node src/index.ts --port 8787 --token my-secret
```

On boot it prints the base URL and key:

```
claude-bridge listening on http://127.0.0.1:8787/v1
  API key      sk-bridge-...          # generated if you did not supply one
  default      mode=oracle model=claude-sonnet-5
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"What is 6*7?"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=KEY)
client.chat.completions.create(model="claude-sonnet-5",
                               messages=[{"role": "user", "content": "hello"}])
```

## The two modes

Every request runs in one of two modes, picked by the model name or the `X-Claude-Mode`
header.

**`oracle`** — a plain completion endpoint. Tools disabled (`--tools ""`), MCP servers
ignored, skills disabled, settings sources and `CLAUDE.md` discovery switched off, and the
Claude Code system prompt *replaced* by the client's system message. Prompt in, text out,
nothing agentic, minimal system-prompt overhead.

**`harness`** — Claude Code itself, unmodified. Tools, file edits, bash, subagents. The
client's system message is *appended* to the agent's own prompt rather than replacing it.
The agent's intermediate activity is streamed as `reasoning_content` (OpenAI) or `thinking`
blocks (Anthropic), so a client sees the work as it happens:

```
reasoning_content:  → Write(workspaces/default/hello.txt)
content:            done
```

This is not a reimplementation of Claude Code. It drives the installed binary, so the
harness is whatever your CLI version does, including your settings, plugins, and MCP config.

## Models, and disguising the backend

`GET /v1/models` advertises each base model twice — bare for oracle, `-harness` suffixed
for the agent — plus `oracle` and `harness` aliases:

```
claude-opus-5     claude-opus-5-harness     oracle
claude-sonnet-5   claude-sonnet-5-harness   harness
claude-fable-5    claude-fable-5-harness
claude-haiku-4-5  claude-haiku-4-5-harness
```

The catalog is just config. To make the server look like something else entirely, redefine
it — the `id` is what clients see and send, `model` is what the CLI is actually told:

```json
{ "models": [
  { "id": "hermes-70b-local", "model": "claude-sonnet-5", "mode": "oracle",
    "contextWindow": 128000, "ownedBy": "local-inference" },
  { "id": "hermes-70b-agent", "model": "claude-opus-5", "mode": "harness" }
]}
```

An unrecognized model name falls back to the default rather than erroring, because clients
tend to send whatever they were configured with and a hard 404 there helps nobody.

## Not wasting tokens

The problem: OpenAI-style clients are stateless and resend the **entire conversation** on
every turn. Piping that into `claude -p` each time re-pays for the whole history.

Instead, the bridge keeps the CLI process **alive** per conversation and talks to it over
`--input-format stream-json`. It hash-chains the incoming user messages, so a request that
extends a conversation it already holds sends only the new tail. History stays in the CLI's
own context, where prompt caching covers it.

Measured against the real CLI — a second turn on a live conversation:

```
turn 1  "What is 6*7?"        prompt_tokens 186   → "42"
turn 2  "Now double it."      prompt_tokens 200   → "84"     (+14, not +189)
```

The chain is built over *user* messages only. Assistant turns already live in the CLI's
context, and clients do not always echo them back byte-for-byte (whitespace trimming,
injected metadata), so ignoring them keeps matching stable. Editing an earlier user message
correctly branches to a fresh session instead of corrupting the old one.

Also on by default:

- `DISABLE_NON_ESSENTIAL_MODEL_CALLS=1` — stops the CLI's background Haiku calls for
  titles and side work, which cost ~530 tokens per session and produce nothing a client sees.
- `--exclude-dynamic-system-prompt-sections` (harness) — moves cwd/env/git status out of the
  system prompt so the cached prefix stays stable.
- Client disconnect aborts the in-flight turn rather than paying for output nobody reads.
- Idle sessions are reaped (15 min default), and the process pool is LRU-capped at 16.

Set `sessions.reuse: false` to disable prefix matching and give every request a cold session.

## Tool calling

Client-defined tools work in both dialects — OpenAI `tools` / `tool_choice`, Anthropic
`tools`. The full loop behaves the way an OpenAI client expects:

```
→ {"tools":[get_weather], "messages":[{"user":"weather in Oslo?"}]}
← finish_reason: "tool_calls", tool_calls:[get_weather({"city":"Oslo"})]
→ ... + {"role":"tool","tool_call_id":"...","content":"{\"temp_c\":3}"}
← "Right now in Oslo it's about 3°C with light rain."
```

The CLI has no channel for handing a caller's tools back out, so the bridge teaches the
model a tagged protocol in the system prompt and parses the tags out of the reply. Tags are
stripped before anything reaches the client, using an incremental scanner that holds back
any text that might turn out to be a partial `<tool_call>` — so **streaming still works**,
which a JSON-schema-constrained response would have cost. `tool_choice` of `none`,
`required`, and a named function are all honoured; `none` omits the protocol entirely.

Tool results sent back as `role: "tool"` extend the *same* live session, so the follow-up
turn costs only the result, not the whole conversation. Because the protocol lives in the
system prompt, a conversation with tools is its own session class and never shares a process
with one without them.

Caveat worth knowing: this is prompted behaviour, not a constrained decode. Claude follows
it reliably in testing, but a malformed call is dropped rather than surfaced as a broken
`tool_call`.

## Watching it work

**Dashboard** — `http://127.0.0.1:8787/ui`. Totals, live sessions with per-session turn and
cost counts, and a streaming activity feed showing each turn's prompt, reply, token split,
and tool use. Sessions can be killed from the table.

Opened locally it **connects on its own** — no key to paste. The page asks
`GET /admin/bootstrap`, which discloses the tokens the server accepts, and it authenticates
itself; a picker lists every configured token if there is more than one. The disclosure is
narrow on purpose: only for a request that arrived directly on the loopback interface and
carries no `X-Forwarded-For`, `X-Real-IP`, or `Forwarded` header, since a proxy hop would
make every remote request look local. A remote browser still gets the manual token prompt.
Set `dashboard.localAutoAuth: false` to require typing the key even locally.

**CLI** — `node src/cli.ts <command>`, or `npm run cli --`. Reads `BRIDGE_URL` and
`BRIDGE_TOKEN`, or takes `--url` / `--token`.

```bash
node src/cli.ts status            # health, totals, token counts, cost, rate limit
node src/cli.ts sessions          # live sessions table
node src/cli.ts watch             # follow the activity feed
node src/cli.ts chat              # interactive; /reset clears, /exit quits
node src/cli.ts chat --harness "create hello.txt and say done"
node src/cli.ts models
node src/cli.ts kill <session-id>
```

`watch` in one terminal while a client works in another is the quickest way to see the
proxy operating:

```
22:42:21 request harness stream
22:42:22 session create d20dbcb2 harness
22:42:25 tool    → Write(workspaces/default/cli-test.txt)
22:42:26 turn    Create a file called cli-test.txt... → Done.
                 harness · in 4 (+25,143 cached) · out 103 · $0.16
```

That `in 4 (+25,143 cached)` is the point of the whole design: the turn billed four fresh
input tokens because everything else was a cache hit.

## Endpoints

| Endpoint | Notes |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI. Streaming, `stream_options.include_usage`, `response_format`. |
| `POST /v1/messages` | Anthropic. Streaming emits exactly one well-formed message envelope. |
| `POST /v1/messages/count_tokens` | Estimate — the CLI offers no exact count without a round trip. |
| `GET /v1/models`, `/v1/models/{id}` | Advertised catalog. |
| `GET /admin/sessions` | Live sessions: turns, cost, idle time, busy state. |
| `DELETE /admin/sessions/{id}` | Terminate one session. |
| `GET /admin/stats` | Totals, sessions, config, rate-limit state. |
| `GET /admin/events` | SSE activity feed; `?history=N` replays recent events first. |
| `GET /admin/bootstrap` | Dashboard self-auth; returns tokens only to a direct loopback request. |
| `GET /ui` | Dashboard. |
| `GET /health` | No auth required. |

Auth accepts `Authorization: Bearer`, `x-api-key`, or `?api_key=`, compared in constant time.

### Per-request headers

| Header | Effect |
| --- | --- |
| `X-Claude-Mode` | `oracle` or `harness`, overriding the model's default. |
| `X-Claude-Effort` | `low`…`max`. Also settable as a model suffix: `claude-opus-5:high`. |
| `X-Claude-Cwd` | Harness working directory, confined to the workspace root. |
| `X-Claude-Session` | Pin a specific CLI session, bypassing prefix matching. |
| `X-Claude-Max-Budget-Usd` | Per-turn spend ceiling. |

Streaming responses echo `x-claude-session`, so a client can pin follow-ups explicitly.

## For Claude

*Instructions for an AI agent asked to "connect to claude-bridge". Follow them in order.*

### 1. Find out whether it is running

```bash
curl -s http://127.0.0.1:8787/health
```

`{"status":"ok","service":"claude-bridge",...}` means it is up. If the connection is
refused, start it from the project directory and wait for the banner:

```bash
cd D:/projects/claude-bridge && npm start
```

It runs in the foreground, so start it in a background shell if you need to keep working.
A different port means `--port N`; adjust every URL below to match.

### 2. Get a token — do not ask the user for one

```bash
curl -s http://127.0.0.1:8787/admin/bootstrap
```

```json
{"authRequired":true,"local":true,"tokens":["sk-bridge-..."],"defaultMode":"oracle"}
```

Use `tokens[0]`. This works because you are on the same machine; it returns an empty list
for remote callers. If `authRequired` is `false`, no credential is needed at all. If the
list is empty but auth is required, then ask the user for the key.

Capture it into a variable. Do not reach for `jq` — it is frequently absent, whereas Node is
a prerequisite of this project and therefore always present:

```bash
# bash
TOKEN=$(curl -s http://127.0.0.1:8787/admin/bootstrap \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).tokens[0]")
```

```powershell
# PowerShell
$TOKEN = (Invoke-RestMethod http://127.0.0.1:8787/admin/bootstrap).tokens[0]
```

### 3. Call it

The base URL is `http://127.0.0.1:8787/v1` and the token is a normal bearer key. Both
dialects work — use whichever suits the client you are configuring.

```bash
# OpenAI-compatible
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"say hi"}]}'

# Anthropic-compatible
curl -s http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $TOKEN" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":64,"messages":[{"role":"user","content":"say hi"}]}'
```

For an SDK or a tool that takes environment variables:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=$TOKEN
```

### 4. Pick the right model

`GET /v1/models` lists them. The choice that matters is the suffix:

- `claude-sonnet-5` — **oracle**. No tools, no filesystem. Use this for anything that is
  just text in, text out: classification, summarizing, generation, an LLM inside a script.
- `claude-sonnet-5-harness` — **agent**. Real tools, edits files, runs commands, confined to
  `workspaces/`. Use only when the caller genuinely wants work performed, and say so plainly
  to the user, because it executes on their machine.

Default to oracle. Swap `sonnet` for `opus`, `fable`, or `haiku-4-5` as needed, or append
`:high` for more effort (`claude-opus-5:high`).

### 5. Confirm it actually worked

```bash
curl -s "http://127.0.0.1:8787/admin/stats?api_key=$TOKEN"
```

`totals.turns` should have increased and `totals.costUsd` should be non-zero. Report the
token counts back to the user — they are the point of this server. For a live view, tell
them to open `http://127.0.0.1:8787/ui`, which authenticates itself.

### Things that will otherwise surprise you

- **Never set `ANTHROPIC_BASE_URL` to this server globally.** The bridge spawns `claude`,
  which would inherit the variable and call the bridge again, without end. The bridge strips
  a self-referencing value from its children as a safety net, but do not rely on it — set
  such variables per-command, not in a shell profile or system environment.
- **`temperature`, `top_p`, `max_tokens`, `stop`, and `n` are accepted and ignored.** Do not
  tune them and do not report that you did; the CLI exposes no such controls.
- **Conversations are stateful behind the scenes.** Sending the full message history is
  correct and cheap — the bridge matches it to a live session and bills only the new turn.
  Do not try to "save tokens" by trimming history; that breaks prefix matching and costs
  *more*, because it starts a fresh session.
- **The `model` you send is echoed back verbatim**, and an unknown name silently falls back
  to the default rather than erroring. Do not treat a successful response as proof that the
  model you named exists — check `/v1/models`.
- **Tool calling is prompt-driven.** `tools` and `tool_choice` work in both dialects, but a
  malformed call is dropped rather than surfaced, so handle a missing `tool_calls` field.
- Errors come back in the shape of whichever dialect you called, so parse
  `error.message` for `/v1/chat/completions` and `error.type` for `/v1/messages`.

## Configuration

Copy `bridge.config.example.json` to `bridge.config.json`, or use flags and env vars —
env overrides file, flags override env.

```
--port --host --token --no-auth --mode --model --claude-bin --log-level --config
BRIDGE_PORT BRIDGE_HOST BRIDGE_TOKENS BRIDGE_MODE BRIDGE_MODEL BRIDGE_CLAUDE_BIN
BRIDGE_LOG_LEVEL BRIDGE_NO_AUTH BRIDGE_CONFIG
```

## Security

Auth is on by default and a token is generated if you do not supply one. The server binds
`127.0.0.1` unless told otherwise, and warns when it does not.

**Harness mode executes tools on this machine on behalf of whoever holds the token.** Treat
the token as shell access. Defaults are chosen accordingly: `permissionMode: acceptEdits`
(not `bypassPermissions`), work confined to `workspaces/`, and `X-Claude-Cwd` rejected
unless the path is under the workspace root or an explicit entry in `harness.allowedCwds`.
`dangerouslySkipPermissions` exists in config and is off. Oracle mode has no tools at all,
so it does not carry this exposure.

## Limitations

- **`temperature`, `top_p`, `max_tokens`, `stop`, `n` are ignored** — the CLI exposes no
  knobs for them. They are accepted rather than rejected so clients that always send them work.
- Tool calling is prompt-driven rather than a constrained decode (see above).
- Cold conversations with prior history are seeded by rendering the transcript into the
  opening message, since assistant turns cannot be injected into a fresh CLI session.
- `count_tokens` is an approximation.

## Tests

```bash
npm test        # 48 tests, no API calls, no cost
npm run typecheck
```

The suite drives `test/fake-claude.mjs`, a stand-in that speaks the same stream-json
protocol and replies `echo<N>: <text>` where N counts turns within one process — which is
what lets the tests prove a session was reused rather than respawned.

## Implementation notes

One behaviour worth knowing if you modify the process layer: the CLI does **not** emit its
`system:init` message (and therefore its session id) until it has received its first input
message. Anything that waits for init before writing will deadlock. `runTurn` writes to
stdin eagerly for exactly this reason.
