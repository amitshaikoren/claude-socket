# Token accounting

How claude-socket measures what a request cost, and why the numbers look the way they do.
Back to the [README](../README.md).

A turn is not one model call. An agentic turn *loops* — ask for a tool, read the result,
ask for another — and **every lap is a separately billed request**. The CLI's final
`result` reports only the turn aggregate, so the socket reads the `usage` block on each
assistant message instead. That is the only place a per-call number exists, and it is what
makes "what did this message / turn / tool call cost" answerable at all.

Three granularities, all from measured usage rather than estimation:

| Level | What it is |
|---|---|
| **turn** | one HTTP request; the sum of its calls |
| **model call** (`step`) | one billed request to the API, deduped by `message.id` |
| **tool call** | attributed from the calls around it — see below |

### The vocabulary

These follow the same conventions as the `token-bench` skill, so numbers from the two agree:

- **Billed** (the headline) = `input + cache_creation + output`.
- **`cache_read` is excluded from it.** It is replayed history priced at roughly a tenth,
  and it is re-sent on every lap of a loop — summing it counts the same prefix once per
  lap, which is how a 20k-token conversation reports 400k of "usage". It is still
  recorded, because it is the number that proves session reuse is working.
- **Peak context** = the largest single call's `cache_read + cache_creation`. A high-water
  mark of how full the window got — never a sum.

### What a tool call costs

Two halves: the **output tokens spent writing the request**, charged to the call that
emitted it, and the **input tokens on the next call**, which is where the result is read
back. When a step asks for several tools at once both halves are split evenly across them
— the API bills a call, not a content block, so there is no per-block breakdown to read.
It is an apportionment, and the totals always reconcile with the turn's billed figure:
nothing is invented and nothing goes missing.

### Reading it

Every response carries the breakdown, as non-standard fields alongside the usual ones:

```jsonc
"usage": {
  "prompt_tokens": 4231, "completion_tokens": 118,   // unchanged, what clients expect
  "billed_tokens": 1204,          // input + cache creation + output
  "peak_context_tokens": 24118,   // fullest single call
  "steps": 3,                     // model calls in this turn
  "tool_call_count": 3,           // tools the harness itself ran
  "step_usage": [
    { "index": 1, "output_tokens": 62, "billed_tokens": 812, "tools": ["Read"] },
    { "index": 2, "output_tokens": 34, "billed_tokens": 210, "tools": ["Grep", "Glob"] },
    { "index": 3, "output_tokens": 22, "billed_tokens": 182, "tools": [] }
  ]
}
```

`tool_call_count` is the sum of the `tools` arrays, hoisted out so that auditing what the
agent was allowed to do does not require summing them — and so that "it took no action" is
a value you can assert on rather than an absence you have to infer. It comes from the CLI's
own output, not from the activity stream, so `activity: "off"` does not zero it: a zero
means the harness ran nothing.

On a streamed turn the usage frame is opt-in (`stream_options.include_usage` for OpenAI);
without it, nothing in this block reaches the client.

### History, and the graphs

Turn records are persisted to SQLite (`node:sqlite`, so the project stays
zero-dependency) at `./data/usage.db` — one row per turn, one per model call, one per tool
call. Writes are queued and flushed on a timer, so a finished turn never waits on disk and
a bookkeeping failure never fails a request that already succeeded.

The dashboard's **Usage** tab reads it: filter by window, mode, model, tool, status, or a
search over prompts and replies; see billed tokens over time bucketed by minute / hour /
day; see which tools cost the most; and click any turn to drill into its individual model
calls and what each one ran.

```
GET /admin/usage         summary + filter facets
GET /admin/usage/turns   the turn list
GET /admin/usage/turns/{id}/steps   one turn's model calls and their tools
GET /admin/usage/series?bucket=hour time buckets, for the chart
GET /admin/usage/tools   per-tool rollup
```

All of them take the same filters: `window=24h` (or `from`/`to`), `mode`, `model`,
`session`, `dialect`, `tool`, `status`, `q`, `limit`, `offset`.

Set `usage.persist: false` (or `--no-usage-db`) to keep history in a memory ring buffer
instead; the tab still works, it just resets on restart. Failed turns are recorded too —
they burned tokens, and leaving them out would make the totals quietly optimistic.
