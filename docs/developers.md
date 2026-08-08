# Developer reference

Everything that did not need to be on the front page.

Back to the [README](../README.md) · token numbers live in [token-accounting.md](token-accounting.md).

**Contents** — [Models](#models-and-disguising-the-backend) · [Session reuse](#not-wasting-tokens) · [Tool calling](#tool-calling) · [Endpoints](#endpoints) · [Configuration](#configuration) · [Security](#security) · [Limitations](#limitations) · [Tests](#tests) · [Implementation notes](#implementation-notes) · [For Claude](#for-claude)

## Models, and disguising the backend

`GET /v1/models` advertises each base model three times — bare for oracle, `-harness` for
the full agent, `-semi` for the narrowed one — plus `oracle`, `harness`, and `semi`
aliases:

```
claude-opus-5     claude-opus-5-harness     claude-opus-5-semi      oracle
claude-sonnet-5   claude-sonnet-5-harness   claude-sonnet-5-semi    harness
claude-fable-5    claude-fable-5-harness    claude-fable-5-semi     semi
claude-haiku-4-5  claude-haiku-4-5-harness  claude-haiku-4-5-semi
```

Each entry reports its `mode` and its `tools` — the tool list the agent gets, or `null`
for the CLI's own default set.

The catalog is just config. To make the server look like something else entirely, redefine
it — the `id` is what clients see and send, `model` is what the CLI is actually told:

```json
{ "models": [
  { "id": "hermes-70b-local", "model": "claude-sonnet-5", "mode": "oracle",
    "contextWindow": 128000, "ownedBy": "local-inference" },
  { "id": "hermes-70b-reader", "model": "claude-sonnet-5", "mode": "semi",
    "tools": ["Read", "Glob", "Grep"] },
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
`tools` — and in **all three modes**. In oracle your tools are the only ones there are; in
harness and semi they sit alongside whatever the agent can already run. The full loop
behaves the way an OpenAI client expects:

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
it reliably in testing, but a call whose JSON does not parse cannot become a `tool_call`.
Emitting a broken one would be worse, so the region is dropped — and because the tags were
already stripped out of the prose, the reply comes back looking like an ordinary answer.
An unterminated tag is worse still: everything after it is gone, so the reply reads as
complete when it is not.

So the count is reported. Whenever a turn consumed call-shaped markup that yielded no call,
the response carries `claude_bridge.unparsed_tool_calls` — on the body for a non-streamed
turn, on the terminal frame for a streamed one (`chat.completion.chunk` with no choices for
OpenAI, `message_delta` for Anthropic). It is unconditional; you do not opt in, and its
absence means it did not happen. If you are debugging a reply that seems to have ignored
your tools or stopped mid-thought, look there first — it is the difference between a
protocol failure and a hallucination.

Note that none of this applies unless the request declared `tools`. With no tools, nothing
scans, and text containing `<tool_call>` — a conversation about this protocol, say — passes
through untouched.

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
| `GET /admin/usage` | Token summary for a filter, plus the facet values for filter menus. |
| `GET /admin/usage/turns` | Turn history, newest first. |
| `GET /admin/usage/turns/{id}/steps` | One turn's model calls, with the tools each ran. |
| `GET /admin/usage/series` | Time buckets; `?bucket=minute\|hour\|day`. |
| `GET /admin/usage/tools` | Per-tool token rollup. |
| `GET /admin/bootstrap` | Dashboard self-auth; returns tokens only to a direct loopback request. |
| `GET /ui` | Dashboard. |
| `GET /health` | No auth required. |

Auth accepts `Authorization: Bearer`, `x-api-key`, or `?api_key=`, compared in constant time.

### Per-request headers

| Header | Effect |
| --- | --- |
| `X-Claude-Mode` | `oracle`, `harness`, or `semi`, overriding the model's default. |
| `X-Claude-Effort` | `low`…`max`. Also settable as a model suffix: `claude-opus-5:high`. |
| `X-Claude-Cwd` | Agent working directory, confined to the workspace root. |
| `X-Claude-Tools` | Comma-separated. **Narrows** the agent's tool set; never widens it. |
| `X-Claude-Disallowed-Tools` | Comma-separated tools to remove on top of the configured set. |
| `X-Claude-Session` | Pin a specific CLI session, bypassing prefix matching. |
| `X-Claude-Max-Budget-Usd` | Per-turn spend ceiling. |
| `X-Claude-Authoritative-Text` | Streaming only: add the authoritative reply text to the terminal frame. See below. |

Streaming responses echo `x-claude-session`, so a client can pin follow-ups explicitly.

### Grounding on a streamed reply

A streamed reply is reassembled from deltas. The bridge takes care to make that
reassembly match what the same turn returns non-streamed — block separators are
restored, partial `<tool_call>` tags are withheld and released at the end — but
the two can only ever be *aligned*, not proven equal: a CLI record whose text
never arrived as deltas is unrecoverable from the wire. `test/stream-parity.test.ts`
pins the alignment so a future CLI change fails a test instead of silently
shipping a different string.

If you are grounding or auditing the output rather than displaying it, ask for
the authoritative text instead of reassembling one. Set
`X-Claude-Authoritative-Text: 1` (or, for OpenAI clients,
`stream_options.include_authoritative_text`) and the terminal frame carries it:

```jsonc
// OpenAI: a trailer frame with no choices, like the usage frame
{ "object": "chat.completion.chunk", "choices": [], "claude_bridge": { "text": "…" } }

// Anthropic: alongside usage on message_delta
{ "type": "message_delta", "delta": {…}, "usage": {…}, "claude_bridge": { "text": "…" } }
```

It is off by default because it repeats the whole reply on the wire.

## Configuration

Copy `bridge.config.example.json` to `bridge.config.json`, or use flags and env vars —
env overrides file, flags override env.

```
--port --host --token --no-auth --mode --model --claude-bin --log-level --config
--usage-db --no-usage-db
BRIDGE_PORT BRIDGE_HOST BRIDGE_TOKENS BRIDGE_MODE BRIDGE_MODEL BRIDGE_CLAUDE_BIN
BRIDGE_LOG_LEVEL BRIDGE_NO_AUTH BRIDGE_CONFIG BRIDGE_USAGE_DB BRIDGE_NO_USAGE_DB
```

`--mode` takes `oracle`, `harness`, or `semi`. Note that `node:sqlite` is still marked
experimental, so enabling usage persistence (the default) prints one
`ExperimentalWarning` at startup; `--no-usage-db` avoids loading the module at all.

## Security

Auth is on by default and a token is generated if you do not supply one. The server binds
`127.0.0.1` unless told otherwise, and warns when it does not.

**Harness mode executes tools on this machine on behalf of whoever holds the token.** Treat
the token as shell access. Defaults are chosen accordingly: `permissionMode: acceptEdits`
(not `bypassPermissions`), work confined to `workspaces/`, and `X-Claude-Cwd` rejected
unless the path is under the workspace root or an explicit entry in `harness.allowedCwds`.
`dangerouslySkipPermissions` exists in config and is off. Oracle mode has no tools at all,
so it does not carry this exposure.

**Semi mode is the middle ground, and its ceiling is the operator's to set.** The default
tool list is read-only, so the mode grants read access to the workspace and outbound
network fetches, but no writes and no shell. `X-Claude-Tools` can only intersect that list
— a request naming `Bash` does not get `Bash`, it gets a 400 — so a client cannot promote
itself to a full agent. That guarantee is only as good as the list: putting `Bash` or
`Write` in `semi.tools` makes it a full agent for every caller. Set
`semi.allowRequestTools: false` if you want the tool set fixed entirely by config.

Usage history at `data/usage.db` holds **prompt and reply previews** (400 characters each)
alongside the token counts. It is a plain file with no separate access control, so treat it
with the same care as the conversations themselves; set `usage.persist: false` if that is
not acceptable.

## Limitations

- **`temperature`, `top_p`, `max_tokens`, `stop`, `n` are ignored** — the CLI exposes no
  knobs for them. They are accepted rather than rejected so clients that always send them work.
- Tool calling is prompt-driven rather than a constrained decode (see above).
- Cold conversations with prior history are seeded by rendering the transcript into the
  opening message, since assistant turns cannot be injected into a fresh CLI session.
- `count_tokens` is an approximation.

## Tests

```bash
npm test        # 87 tests, no API calls, no cost
npm run typecheck
```

The suite drives `test/fake-claude.mjs`, a stand-in that speaks the same stream-json
protocol and replies `echo<N>: <text>` where N counts turns within one process — which is
what lets the tests prove a session was reused rather than respawned. It emits a `usage`
block per assistant message, exactly as the real CLI does, so the per-call accounting is
exercised rather than assumed.

## Implementation notes

One behaviour worth knowing if you modify the process layer: the CLI does **not** emit its
`system:init` message (and therefore its session id) until it has received its first input
message. Anything that waits for init before writing will deadlock. `runTurn` writes to
stdin eagerly for exactly this reason.

## For Claude

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
- `claude-sonnet-5-semi` — **read-only agent**. It runs its own loop but can only
  `Read`/`Glob`/`Grep`/`WebFetch`/`WebSearch`. The right choice when you want the model to
  go and *find out* something, and nothing on the machine should change.
- `claude-sonnet-5-harness` — **full agent**. Real tools, edits files, runs commands, confined to
  `workspaces/`. Use only when the caller genuinely wants work performed, and say so plainly
  to the user, because it executes on their machine.

Default to oracle; prefer `-semi` over `-harness` whenever the task is investigation rather
than change. Swap `sonnet` for `opus`, `fable`, or `haiku-4-5` as needed, or append
`:high` for more effort (`claude-opus-5:high`).

### 5. Confirm it actually worked

```bash
curl -s "http://127.0.0.1:8787/admin/stats?api_key=$TOKEN"
```

`totals.turns` should have increased and `totals.costUsd` should be non-zero. Report the
token counts back to the user — they are the point of this server. Quote **`headline`**
(input + cache creation + output); it is what the run cost at full rate. Do not add
`cacheReadTokens` into it: those are replayed history billed at roughly a tenth, and
summing them across an agent's tool loop counts the same prefix once per lap.

For per-turn and per-tool detail, `GET /admin/usage` and `/admin/usage/tools` take a
`window=24h` filter. For a live view, tell the user to open `http://127.0.0.1:8787/ui`,
which authenticates itself; the **Usage** tab has the charts and the drill-down.

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
- **Tool calling is prompt-driven.** `tools` and `tool_choice` work in both dialects, so
  handle a missing `tool_calls` field. A call that would not parse is dropped, but never
  silently — check `claude_bridge.unparsed_tool_calls` before concluding the model just
  talked.
- **`usage.tool_call_count` is how many of Claude Code's *own* tools the turn ran**, which
  is not the same question as `tool_calls` in the response. It is counted from the CLI's
  output, so it stays accurate with `activity: "off"` — a zero means the harness did
  nothing, not that reporting is switched off.
- Errors come back in the shape of whichever dialect you called, so parse
  `error.message` for `/v1/chat/completions` and `error.type` for `/v1/messages`.


