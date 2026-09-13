# Developer reference

Everything that did not need to be on the front page.

Back to the [README](../README.md) · token numbers live in [token-accounting.md](token-accounting.md).

**Contents** — [Models](#models-and-disguising-the-backend) · [The codex backend](#the-codex-backend) · [Session reuse](#not-wasting-tokens) · [Tool calling](#tool-calling) · [Endpoints](#endpoints) · [Configuration](#configuration) · [Security](#security) · [Limitations](#limitations) · [Tests](#tests) · [Implementation notes](#implementation-notes) · [For Claude](#for-claude)

## Models, and disguising the backend

`GET /v1/models` advertises each base model three times — bare for oracle, `-harness` for
the full agent, `-semi` for the narrowed one — plus `oracle`, `harness`, and `semi`
aliases:

```
claude-opus-5     claude-opus-5-harness     claude-opus-5-semi      oracle
claude-sonnet-5   claude-sonnet-5-harness   claude-sonnet-5-semi    harness
claude-fable-5    claude-fable-5-harness    claude-fable-5-semi     semi
claude-haiku-4-5  claude-haiku-4-5-harness  claude-haiku-4-5-semi

gpt-6-astra       gpt-6-astra-harness       gpt-6-astra-semi
gpt-5.6-sol       gpt-5.6-sol-harness       gpt-5.6-sol-semi
gpt-5.6-terra     gpt-5.6-terra-harness     gpt-5.6-terra-semi
gpt-5.5           gpt-5.5-harness           gpt-5.5-semi
```

Each entry reports its `provider` (which CLI answers), its `mode`, and then either `tools`
— the tool list the agent gets, or `null` for the CLI's own default set — or `sandbox`, for
Codex entries, which have no tool list to report.

**The catalog decides the backend.** A header can move a request between modes; nothing
moves it between CLIs, because the model id would stop meaning anything on the other side.
The three bare aliases follow `defaults.provider`.

The catalog is just config. To make the server look like something else entirely, redefine
it — the `id` is what clients see and send, `model` is what the CLI is actually told:

```json
{ "models": [
  { "id": "hermes-70b-local", "model": "claude-sonnet-5", "mode": "oracle",
    "contextWindow": 128000, "ownedBy": "local-inference" },
  { "id": "hermes-70b-reader", "model": "claude-sonnet-5", "mode": "semi",
    "tools": ["Read", "Glob", "Grep"] },
  { "id": "hermes-70b-thinker", "provider": "codex", "model": "gpt-5.6-sol",
    "mode": "oracle", "effort": "high" },
  { "id": "hermes-70b-agent", "model": "claude-opus-5", "mode": "harness" }
]}
```

`provider` may be omitted: it is inferred from the model name, so a config file written
before the second backend existed keeps working unchanged.

An unrecognized model name falls back to the default rather than erroring, because clients
tend to send whatever they were configured with and a hard 404 there helps nobody. An
unrecognized *id* that still names a known model — a bare `gpt-5.6-sol` from a client you
did not configure — goes to that model's own backend rather than to the default.

## The codex backend

Everything the socket promises holds on `codex`, but two of the mechanisms behind those
promises had to be built differently, and a third is genuinely weaker. This is the honest
account of all three.

### A session with no process behind it

`codex exec` is not a server. It runs one turn, writes its result, and exits; continuity
comes from `codex exec resume <thread>`. So where the Claude driver holds one child open
for the life of a conversation and feeds it turns over stdin, the Codex driver holds a
*thread id* and spawns a child per turn.

What a client sees is unchanged — it still sends only the new message, never the
transcript. What an operator sees is one detail: a Codex session between turns has no
process, and `/admin/stats` reports `pid: null` for it. That is the design, not a leak.
The pid registry that lets a restarted socket kill what a crashed one abandoned is told
about every child as it spawns, and pruned of the dead on each reap tick.

### Per-model-call accounting, out of the transcript

`codex exec --json` reports one usage total per turn. That is precisely the number this
project exists to get underneath — a turn that ran four tool calls is four billed requests,
and one aggregate cannot say which of them was expensive.

The per-call numbers do exist, just not on the wire: the CLI writes a `token_usage_record`
per request into the session transcript under `CODEX_HOME/sessions/YYYY/MM/DD/`, in causal
order next to the `response_item` entries for the tool calls that request asked for. The
socket reads them back from a byte watermark taken at the start of each turn, closing a
model call when its usage record appears and attributing to it the tool calls seen since
the last one. That is the same pairing the Claude driver gets for free from per-message
usage blocks, and it is what makes `attributeTools` work on both backends.

It is a private on-disk format, and it is treated as one. Nothing in the parser throws,
the read happens after the child exits (the CLI is still appending when `turn.completed`
goes out, and the last call's record is one of the things still in flight), and a turn that
yields no records falls back to its aggregate as a single step. Coarser, never wrong. Set
`codex.readRollout: false` to skip it deliberately.

One conversion matters: **Codex counts cached and cache-written tokens inside
`input_tokens`**, where this socket — and Anthropic — keep them apart. The socket subtracts
them out. Without that, every cached prefix would be billed twice over in the headline.

Cost stays at `0`. Codex reports no price, and prices are not ours to assume.

### What `oracle` can and cannot mean here

There is no `--tools ""` for `codex exec`, and no system-prompt flag either.

So `oracle` on Codex is a read-only sandbox with your system prompt folded into the opening
message, underneath Codex's own coding-agent preamble, which cannot be replaced —
`base_instructions` is an app-server protocol field that `codex exec` rejects as config,
verified against 0.153.4. In practice it answers like a completion endpoint. By
construction it is an agent that usually does not bother, which is a weaker thing.

Two consequences worth knowing:

- **`X-Claude-Tools` returns 400** for a Codex model instead of being ignored. There is no
  allowlist to narrow, and accepting the header silently would leave a caller believing it
  had restricted an agent that still holds everything it started with.
- **Codex oracle sessions get a real working directory** under the workspace root, not the
  socket's own. On Claude the oracle cwd is unreachable — there are no tools — so it never
  mattered. Here a read-only sandbox rooted wherever the socket was started would be a
  read-only sandbox over this repository, config file and API tokens included.

### Auth, and what `--ignore-user-config` costs

The socket **never copies `auth.json`.** Codex rotates its refresh token on use — the
binary has a "refresh token was already used" error to prove it — so a second copy would
eventually invalidate whichever one refreshed second, quite possibly your own `codex`.
Spawned CLIs use your real `CODEX_HOME`; set `codex.home` only if you know why.

Isolation comes from `--ignore-user-config` instead, on by default, which keeps your MCP
servers, plugins and model default out of bridge sessions — worth about 2.5k prompt tokens
a turn on a well-furnished install, plus whatever those servers cost to start.

It has one sharp edge, and the socket files it down for you. On Windows, `codex` can only
run commands after `codex sandbox setup --elevated`, and the result is recorded in
`config.toml` as `[windows] sandbox` — machine setup, not preference. `--ignore-user-config`
discards it with everything else, and the symptom is quietly terrible: the agent keeps its
tools, every command it runs is refused, and it reports back that it could not look at
anything. So that one key is read back out and re-applied. Nothing else from the file is.
`codex.configOverrides` passes arbitrary `-c key=value` settings if some other machine
turns out to need the same treatment.

### Checking it on your own machine

The socket is only as good as the CLI under it, so when something looks wrong, find out
which of the two is lying before changing code.

```bash
# Does the CLI work at all, on its own terms?
codex --version
echo "What is 6*7?" | codex exec --json --skip-git-repo-check --sandbox read-only -

# Does it still work with the flags the socket adds? If this fails and the line
# above did not, the difference is in the flags, not in the socket.
echo "Read notes.txt and tell me the passphrase." | codex exec --json --color never \
  --skip-git-repo-check --ignore-user-config --model gpt-5.6-sol \
  --sandbox read-only --cd ./workspaces/default -

# What did the socket actually run? `spawning codex` and the sandbox carry-forward
# are both logged here.
node src/index.ts --log-level debug

# Where the per-call numbers come from, for a thread id the response reported:
ls ~/.codex/sessions/*/*/*/rollout-*-<thread-id>.jsonl
grep token_usage_record <that file> | tail -3
```

Two failure modes are worth recognising by sight, because neither announces itself:

- **The agent says it could not read anything, and every command was "blocked by the
  workspace policy".** That is the Windows sandbox setup missing, not a permissions bug in
  the socket. Compare `[windows] sandbox` in your `config.toml` against what the debug log
  says it carried across.
- **A turn reports `steps: 1` when it plainly ran tools.** The transcript could not be
  read, so the aggregate was used. Check `codex.readRollout`, then that the file above
  exists.

And one that does not exist but looks like it should: a **stale socket still holding the
port**. `npm start` on a taken port exits with `EADDRINUSE` in the log while the *old*
server keeps answering your requests, so a fix appears not to work. Check
`netstat -ano | grep <port>` before concluding anything about a change.

### Smaller differences

- **Streaming is item-granular.** Codex publishes whole messages, not token deltas — there
  is no delta event in its vocabulary on this transport. A reply arrives as one delta.
  Nothing is synthesized to hide that, and stream parity still holds exactly.
- **Thinking actually arrives.** The Claude CLI emits thinking blocks with the text
  redacted to nothing; Codex fills in a reasoning summary, so the side channel that is
  empty on one backend carries text on the other. It needs
  `codex.reasoningSummary: "detailed"`, which is the default.
- **No rate-limit frames**, so `/health` and `/admin/stats` have nothing to report for a
  Codex-only socket.
- **No interrupt.** `codex exec` takes no control channel on stdin, so an aborted turn
  kills the child. The thread survives — the conversation is in the transcript, not the
  process — so the next turn resumes it normally.
- **Images** are decoded to files and passed with `--image`; a plain image *URL* is dropped,
  because `--image` takes paths.
- **`response_format`** maps to `--output-schema`.
- **The usage database is unchanged.** There is no `provider` column; `model` tells the two
  apart, and the dashboard's model filter works as it always did.

## Not wasting tokens

The problem: OpenAI-style clients are stateless and resend the **entire conversation** on
every turn. Piping that into `claude -p` each time re-pays for the whole history.

Instead, the socket keeps the conversation **open on the CLI side** and hash-chains the
incoming user messages, so a request that extends a conversation it already holds sends
only the new tail. History stays in the CLI's own context, where prompt caching covers it.

How the conversation is held open depends on the backend: `claude` keeps one process alive
and takes turns over `--input-format stream-json`; `codex exec` exits after every turn, so
the socket keeps its thread id and resumes it. Prefix matching, the chain, and what the
client has to do — nothing — are identical either way.

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

The CLI has no channel for handing a caller's tools back out, so the socket teaches the
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
the response carries `claude_socket.unparsed_tool_calls` — on the body for a non-streamed
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

A streamed reply is reassembled from deltas. The socket takes care to make that
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
{ "object": "chat.completion.chunk", "choices": [], "claude_socket": { "text": "…" } }

// Anthropic: alongside usage on message_delta
{ "type": "message_delta", "delta": {…}, "usage": {…}, "claude_socket": { "text": "…" } }
```

It is off by default because it repeats the whole reply on the wire.

## Configuration

Copy `socket.config.example.json` to `socket.config.json`, or use flags and env vars —
env overrides file, flags override env.

```
--port --host --token --no-auth --mode --provider --model --claude-bin --codex-bin
--log-level --config --usage-db --no-usage-db
SOCKET_PORT SOCKET_HOST SOCKET_TOKENS SOCKET_MODE SOCKET_PROVIDER SOCKET_MODEL
SOCKET_CLAUDE_BIN SOCKET_CODEX_BIN SOCKET_LOG_LEVEL SOCKET_NO_AUTH SOCKET_CONFIG
SOCKET_USAGE_DB SOCKET_NO_USAGE_DB
```

`--mode` takes `oracle`, `harness`, or `semi`; `--provider` takes `claude` or `codex` and
sets which backend the bare mode aliases use. A missing CLI is a warning at boot, not a
failure — half a catalog is still worth serving. Note that `node:sqlite` is still marked
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

**On `codex`, read that last sentence again.** There is no tool allowlist and no way to run
without a shell, so the exposure is set by the sandbox alone — `read-only` for `oracle` and
`semi`, `workspace-write` for `harness`. A Codex oracle session can still run read-only
commands, which a Claude oracle session cannot. It is confined to a directory under the
workspace root like every other mode, and `X-Claude-Tools` is rejected rather than silently
ignored, but "no tools at all" is not available on that backend and the socket will not
claim it is.

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
- **`reasoning_content` is always empty on `claude`**, in every mode. The socket asks for
  the model's thinking, parses it and streams it, but Claude Code 2.1.220 redacts the text
  on the way out — a thinking block arrives carrying a signature and a token estimate and
  `thinking: ""`. `MAX_THINKING_TOKENS` does not change it. Nothing in the socket can
  close that gap; it needs the CLI to start emitting the text. On `codex` the same channel
  does carry text, which is the one place that backend is more forthcoming.
- `count_tokens` is an approximation.

Codex-only, each covered in [The codex backend](#the-codex-backend): no tool allowlist, so
`oracle` is a weaker promise and `X-Claude-Tools` is refused; item-granular streaming
rather than token deltas; no rate-limit reporting; no cost in USD; no interrupt, so an
abort kills the child and resumes the thread next turn; image URLs dropped.

## Tests

```bash
npm test        # 153 tests, no API calls, no cost
npm run typecheck
```

The suite drives `test/fake-claude.mjs`, a stand-in that speaks the same stream-json
protocol and replies `echo<N>: <text>` where N counts turns within one process — which is
what lets the tests prove a session was reused rather than respawned. It emits a `usage`
block per assistant message, exactly as the real CLI does, so the per-call accounting is
exercised rather than assumed.

`test/fake-codex.mjs` is the counterpart, and it has to work harder for the same trick: a
real `codex exec` exits after every turn, so its turn counter cannot live in the process.
It recovers the count from the thread's own transcript, exactly as the real CLI recovers
the conversation — which means a test asserting `echo2` has proved the thread was resumed
and not merely that a process stayed up. It writes `token_usage_record` entries in Codex's
own accounting, with cached tokens counted *inside* `input_tokens`, so the conversion the
socket performs is exercised rather than assumed.

## Implementation notes

The two drivers sit behind one `AgentProcess` interface in `src/core/types.ts`;
`src/agent/` holds what they share (the session pool, the reaper, spawning), and
`src/claude/` and `src/codex/` hold what they do not.

Three behaviours worth knowing if you modify the process layer:

- The Claude CLI does **not** emit its `system:init` message (and therefore its session id)
  until it has received its first input message. Anything that waits for init before
  writing will deadlock. `runTurn` writes to stdin eagerly for exactly this reason — and
  the Codex driver, which waits on `thread.started` the same way, is not an async generator
  for the same reason.
- `alive` on an `AgentProcess` means *the conversation can take another turn*, not that a
  process exists. Codex sessions legitimately have no child between turns. Anything
  reconciling against the OS must use `pids()`, not `pid`, or it will sweep a live session's
  child as an orphan on one backend and see nothing at all on the other.
- Codex's rollout transcript is still being written when `turn.completed` arrives on
  stdout. Read it after the child exits, not before, or the final model call's usage is
  reliably missing.

## For Claude

### 1. Find out whether it is running

```bash
curl -s http://127.0.0.1:8787/health
```

`{"status":"ok","service":"claude-socket",...}` means it is up. If the connection is
refused, start it from the project directory and wait for the banner:

```bash
cd D:/projects/claude-socket && npm start
```

It runs in the foreground, so start it in a background shell if you need to keep working.
A different port means `--port N`; adjust every URL below to match.

### 2. Get a token — do not ask the user for one

```bash
curl -s http://127.0.0.1:8787/admin/bootstrap
```

```json
{"authRequired":true,"local":true,"tokens":["sk-socket-..."],"defaultMode":"oracle"}
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

A `gpt-*` id — `gpt-5.6-sol`, `gpt-6-astra` — answers from the user's ChatGPT plan through
the `codex` CLI instead, with the same three suffixes. Reach for one when the user asks for
it, or when a second opinion from a different model is the point. Two differences worth
holding onto: `gpt-5.6-sol` is **not** a no-tools endpoint the way `claude-sonnet-5` is (it
has a read-only sandbox it can still use), and `X-Claude-Tools` returns 400 rather than
narrowing anything. Check `provider` on the `/v1/models` entry if you are unsure which
backend an id reaches.

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

- **Never set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to this server globally.** The
  socket spawns `claude` and `codex`, which would inherit the variable and call the socket
  again, without end. The socket strips a self-referencing value from its children as a
  safety net, but do not rely on it — set such variables per-command, not in a shell
  profile or system environment.
- **`temperature`, `top_p`, `max_tokens`, `stop`, and `n` are accepted and ignored.** Do not
  tune them and do not report that you did; the CLI exposes no such controls.
- **Conversations are stateful behind the scenes.** Sending the full message history is
  correct and cheap — the socket matches it to a live session and bills only the new turn.
  Do not try to "save tokens" by trimming history; that breaks prefix matching and costs
  *more*, because it starts a fresh session.
- **The `model` you send is echoed back verbatim**, and an unknown name silently falls back
  to the default rather than erroring. Do not treat a successful response as proof that the
  model you named exists — check `/v1/models`.
- **Tool calling is prompt-driven.** `tools` and `tool_choice` work in both dialects, so
  handle a missing `tool_calls` field. A call that would not parse is dropped, but never
  silently — check `claude_socket.unparsed_tool_calls` before concluding the model just
  talked.
- **`usage.tool_call_count` is how many of Claude Code's *own* tools the turn ran**, which
  is not the same question as `tool_calls` in the response. It is counted from the CLI's
  output, so it stays accurate with `activity: "off"` — a zero means the harness did
  nothing, not that reporting is switched off.
- **Do not wait on `reasoning_content` from a `claude-*` model — it arrives empty.** The
  channel is wired end to end and the setting that governs it (`activity`) is real, but the
  CLI strips the text out of every thinking block it emits, so there is nothing to put in
  it. An empty thinking pane is the CLI's doing, not a misconfiguration; do not go hunting
  for the setting that turns it on, and do not report that you enabled thinking. A `gpt-*`
  model does fill it in, so the same empty field means different things on the two
  backends.
- **A `gpt-*` reply streams as one chunk.** Codex publishes whole messages rather than
  token deltas. Do not read a single large delta as a bug, and do not build a progress
  indicator that assumes many small ones.
- **`cost_usd` is always 0 for `gpt-*` models.** Codex reports no price and the socket does
  not invent one. Zero there means unknown, not free — read `billed_tokens` instead.
- Errors come back in the shape of whichever dialect you called, so parse
  `error.message` for `/v1/chat/completions` and `error.type` for `/v1/messages`.


