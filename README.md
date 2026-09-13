# claude-socket

**An OpenAI/Anthropic-shaped socket in front of your own Claude Code and Codex installs —
one that tells you what each tool call in an agent loop actually cost.**

Building agentic flows normally means the API: a separate key, metered per token, a bill
that grows with every tool loop and dead end. But your machine already has an
authenticated `claude` CLI sitting there — and, very likely, an authenticated `codex` one
next to it. This puts a socket in front of them, so your scripts, agents and eval
harnesses drive either like any hosted model — on the auth you already have.

And a turn is not a call. It's a model call, a tool call, another model call, a dead end,
a retry — and what you normally get back is a single usage total once the dust settles,
which tells you the loop was expensive but not *where*. The socket measures every billed
call separately and attributes tokens to the individual tool calls that caused them.
Charted, filterable, persisted.

![The usage dashboard: token charts, filters, and per-model-call drill-down](docs/dashboard.gif)

```bash
npm install && npm start
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=KEY)   # key is printed on boot

client.chat.completions.create(model="claude-sonnet-5",         # plain completion
    messages=[{"role": "user", "content": "What is 6*7?"}])

client.chat.completions.create(model="claude-sonnet-5-semi",    # read-only agent
    messages=[{"role": "user", "content": "why is the build slow?"}])

client.chat.completions.create(model="gpt-5.6-sol",             # ...or ChatGPT, same socket
    messages=[{"role": "user", "content": "What is 6*7?"}])
```

That's it. Node 24+, a working `claude` or `codex` CLI, zero runtime dependencies.

## What you get

- **Token accounting that survives a tool loop.** A turn is many billed calls; the socket
  measures each one and attributes tokens to individual tool calls. Charted, filterable,
  persisted, and drillable down to the call — on both backends. → [Token accounting](docs/token-accounting.md)
- **Two backends, one socket.** `claude-*` models go to Claude Code, `gpt-*` models to
  Codex, on whichever plan logins you already have. Same endpoints, same modes, same
  accounting; the differences between the two CLIs are documented rather than papered
  over. → [The second backend](#the-second-backend-codex)
- **A read-only agent is a first-class mode.** Not tools-on/tools-off: `semi` lets the
  agent run its own loop over a tool set you choose — read-only unless you widen it — so
  you can let it investigate without letting it act. `oracle` and `harness` sit either
  side. Pick per request; hand it tools of your own in any of them.
- **It doesn't re-pay for your history.** Stateless clients resend the whole conversation
  every turn; the socket keeps the conversation open on the CLI side and sends only the
  new message — no `session_id` for your client to track. → [Session reuse](docs/developers.md#not-wasting-tokens)
- **Both dialects, properly.** Streaming, tool calling, `response_format`, images — over
  `/v1/chat/completions` and `/v1/messages`.
- **A streamed reply says the same thing as a non-streamed one.** Reassembled deltas match
  what the same turn returns with `stream: false`, and a client that grounds on the answer
  rather than displaying it can ask for the authoritative text outright.
  → [Grounding on a streamed reply](docs/developers.md#grounding-on-a-streamed-reply)

The constraint moves rather than disappears: you spend plan capacity, so the ceiling is
your **rate limits**. The Claude CLI reports those, and the socket surfaces them at
`/health` and `/admin/stats`; Codex does not report them on this transport, so a Codex-only
socket has nothing to show there.

```
  OpenAI SDK ─┐
  Cursor    ──┤   http://host:8787/v1        ┌── claude --print --input-format stream-json
  Open WebUI ─┼──▶ claude-socket ────────────┤   (one long-lived process per conversation)
  curl      ──┤    (token auth, SSE, usage)  └── your existing Claude Code auth
  LangChain ──┘
```

<details>
<summary><b>curl, and what boot looks like</b></summary>

```
claude-socket listening on http://127.0.0.1:8787/v1
  API key      sk-socket-...          # generated if you did not supply one
  dashboard    http://127.0.0.1:8787/ui
  default      mode=oracle model=claude-sonnet-5
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"What is 6*7?"}]}'
```

PowerShell aliases `curl` to `Invoke-WebRequest`, so use that instead:

```powershell
$TOKEN = (Invoke-RestMethod http://127.0.0.1:8787/admin/bootstrap).tokens[0]
$body  = @{ model="claude-sonnet-5"; messages=@(@{role="user";content="What is 6*7?"}) } | ConvertTo-Json -Depth 5
Invoke-RestMethod http://127.0.0.1:8787/v1/chat/completions -Method Post `
  -Headers @{ authorization = "Bearer $TOKEN" } -ContentType "application/json" -Body $body
```
</details>

## The three modes

Pick with the model suffix, or the `X-Claude-Mode` header. They differ in **who owns the
loop, and how much of the agent comes with it.**

| Mode | Model id | The agent gets | Use it for |
| --- | --- | --- | --- |
| `oracle` | `claude-sonnet-5` | nothing (`--tools ""`) | text in, text out — your code owns the loop |
| `semi` | `claude-sonnet-5-semi` | a tool set you choose, read-only by default | letting it investigate, safely |
| `harness` | `claude-sonnet-5-harness` | all of Claude Code | letting it actually do the work |

`semi` is the useful middle: the agent still runs its own loop, but only over
`Read, Glob, Grep, WebFetch, WebSearch, TodoWrite` unless you say otherwise.

```bash
curl ... -H "X-Claude-Mode: semi"                             # read-only agent
curl ... -H "X-Claude-Mode: semi" -H "X-Claude-Tools: Read,Grep"   # narrower still
```

`X-Claude-Tools` can only **narrow** what the mode offers, never widen it — otherwise any
client could promote itself to a full agent by naming `Bash`. Config sets the ceiling.

Separately, you can hand the socket **your own** tools via the standard OpenAI/Anthropic
`tools` field and get calls back to run your side. That works in all three modes, and is
independent of the above.

→ [Modes, tool policy and the model catalog](docs/developers.md#models-and-disguising-the-backend)

## The second backend: Codex

Ask for a `gpt-*` model and the socket drives your `codex` CLI instead of `claude`. Same
endpoints, same three modes, same per-tool-call accounting, same session reuse.

```bash
curl ... -d '{"model":"gpt-5.6-sol","messages":[...]}'          # completion
curl ... -d '{"model":"gpt-5.6-sol-semi","messages":[...]}'     # read-only agent
```

The model id decides the backend, so nothing is ambiguous and `X-Claude-Mode` moves a
request between modes but never between CLIs. Set `defaults.provider` to `codex` to point
the bare `oracle`/`semi`/`harness` aliases at it too:

```bash
npm start                                   # both backends, if both CLIs are installed
node src/index.ts --provider codex          # ...and the bare aliases go to codex
node src/index.ts --codex-bin /path/to/codex

node src/cli.ts models     # ID / BACKEND / MODE / CONTEXT — which CLI answers for what
node src/cli.ts sessions   # live sessions; a codex one shows no pid between turns
```

A missing CLI is a warning at boot, not a failure — `claude`-only and `codex`-only installs
both work, and the half of the catalog that has a backend still serves.

**The two CLIs are not the same shape, and the socket does not pretend otherwise.**

| | `claude` | `codex` |
| --- | --- | --- |
| Tool control | an exact `--tools` allowlist | a sandbox, and nothing finer |
| `oracle` means | genuinely no tools | a read-only sandbox it rarely uses |
| System prompt | a CLI flag | folded into the first message |
| Streaming | token deltas | whole messages, one delta each |
| Thinking text | arrives redacted to nothing | actually arrives |
| Rate limits | reported | not on this transport |
| Cost in USD | reported by the CLI | not reported, so left at zero |

Two of those are worth saying twice. **`oracle` on Codex is a weaker promise**: there is no
way to strip `codex exec` of its shell, so an oracle session still has a read-only sandbox
and Codex's own coding-agent preamble underneath your system prompt. It answers like a
completion endpoint in practice, but it is not one by construction the way the Claude
oracle is. And **`X-Claude-Tools` is rejected, not ignored**, for `gpt-*` models — accepting
it silently would leave you believing you had restricted an agent that still holds
everything it started with.

Your `codex` login is used where it lives: the socket never copies `auth.json`, because
Codex rotates its refresh token on use and a second copy would eventually invalidate
whichever one refreshed second — including your own `codex`. It does pass
`--ignore-user-config` by default, so your MCP servers, plugins and model default stay out
of bridge sessions; on Windows it reads back and re-applies the one thing that discards
which you actually need, the `[windows] sandbox` setup, without which every command the
agent runs is silently refused.

Per-model-call accounting comes from the session transcript under `CODEX_HOME/sessions`,
because `codex exec --json` reports only a turn total on the wire. If that cannot be read,
a turn records as one step instead of several — coarser, never wrong.

→ [The codex backend in detail](docs/developers.md#the-codex-backend)

## Watching it work

The dashboard is at `http://127.0.0.1:8787/ui` — opened locally it authenticates itself,
no key to paste. **Live** shows totals, running sessions and a streaming activity feed.
**Usage** is the token history: filter by window, mode, model or tool, and click any turn
to see its individual model calls. That is the GIF above.

```bash
node src/cli.ts watch    # same feed, in the terminal
node src/cli.ts chat     # a REPL against your own socket
```

## Docs

- **[Token accounting](docs/token-accounting.md)** — what a turn, a model call and a tool
  call each cost, and why cache reads are excluded from the headline.
- **[Developer reference](docs/developers.md)** — endpoints and headers, the model catalog,
  session reuse, tool calling, config, security notes, limitations, tests.

## Tests

```bash
npm test          # 153 tests, no API calls, no cost
npm run typecheck
```

Driven by `test/fake-claude.mjs` and `test/fake-codex.mjs`, stand-ins speaking the same
protocols as the real CLIs — including the awkward parts they do, like restating a message
under the same id, splitting a reply across text blocks, sending a thinking block whose
text has been redacted away to nothing, or exiting after every single turn and having to
recover the conversation from a file.

`test/stream-parity.test.ts` pins the one invariant that spans both dialects: the text
deltas of a turn, reassembled, equal the authoritative reply. It cannot be proved — a CLI
record whose text never arrived as deltas is unrecoverable from the wire — but it turns a
future divergence into a failing test rather than a silently different answer.
