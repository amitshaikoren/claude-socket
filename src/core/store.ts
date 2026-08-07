/**
 * Durable token accounting.
 *
 * Telemetry is a window onto a running server — 500 events, gone on restart.
 * That is the right shape for a live feed and the wrong shape for "what did last
 * week cost", so usage records go here instead: one row per turn, one per model
 * call inside it, one per tool call.
 *
 * Writes are queued and flushed on a timer. A turn that has just finished should
 * not pay a disk round-trip before its response is sent, and a bookkeeping
 * failure must never fail a request that already succeeded.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../util/log.ts";
import { attributeTools, billed, peakContext, type Step } from "./usage.ts";
import type { Mode, Usage } from "./types.ts";

/** One completed turn, as persisted. */
export interface TurnRecord {
  id: string;
  at: number;
  durationMs: number;
  sessionId: string;
  dialect: "openai" | "anthropic";
  mode: Mode;
  /** What the CLI was told. */
  model: string;
  /** What the client asked for. */
  advertisedModel: string;
  stream: boolean;
  cwd: string;
  reused: boolean;
  ok: boolean;
  errorMessage: string | null;
  usage: Usage;
  headline: number;
  peakContext: number;
  /** Tool calls the caller's own tools were asked for, via the tagged protocol. */
  clientToolCalls: number;
  prompt: string;
  reply: string;
  steps: Step[];
}

export interface UsageFilter {
  from?: number;
  to?: number;
  mode?: string;
  model?: string;
  sessionId?: string;
  dialect?: string;
  tool?: string;
  /** Substring match over the prompt and reply previews. */
  q?: string;
  status?: "ok" | "error";
  limit?: number;
  offset?: number;
}

export interface UsageSummary {
  turns: number;
  errors: number;
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  headline: number;
  peakContext: number;
  costUsd: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface SeriesPoint {
  bucket: number;
  turns: number;
  headline: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  peakContext: number;
}

export interface ToolRollup {
  name: string;
  calls: number;
  requestTokens: number;
  resultTokens: number;
  totalTokens: number;
  turns: number;
}

export type Bucket = "minute" | "hour" | "day";

const BUCKET_MS: Record<Bucket, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export function parseBucket(raw: string | null | undefined): Bucket {
  return raw === "minute" || raw === "day" ? raw : "hour";
}

export interface UsageStore {
  record(turn: TurnRecord): void;
  summary(filter: UsageFilter): UsageSummary;
  turns(filter: UsageFilter): TurnRecord[];
  steps(turnId: string): Array<Step & { turnId: string }>;
  series(filter: UsageFilter, bucket: Bucket): SeriesPoint[];
  tools(filter: UsageFilter): ToolRollup[];
  /** Distinct values for the dashboard's filter dropdowns. */
  facets(): { modes: string[]; models: string[]; dialects: string[]; tools: string[] };
  flush(): void;
  close(): void;
}

/** Build the TurnRecord for a turn that has just finished. */
export function buildTurnRecord(input: {
  startedAt: number;
  sessionId: string;
  dialect: "openai" | "anthropic";
  mode: Mode;
  model: string;
  advertisedModel: string;
  stream: boolean;
  cwd: string;
  reused: boolean;
  ok: boolean;
  errorMessage?: string | null;
  usage: Usage;
  steps: Step[];
  clientToolCalls: number;
  prompt: string;
  reply: string;
}): TurnRecord {
  return {
    id: randomUUID(),
    at: input.startedAt,
    durationMs: Date.now() - input.startedAt,
    sessionId: input.sessionId,
    dialect: input.dialect,
    mode: input.mode,
    model: input.model,
    advertisedModel: input.advertisedModel,
    stream: input.stream,
    cwd: input.cwd,
    reused: input.reused,
    ok: input.ok,
    errorMessage: input.errorMessage ?? null,
    usage: input.usage,
    headline: billed(input.usage),
    peakContext: peakContext(input.steps),
    clientToolCalls: input.clientToolCalls,
    prompt: input.prompt,
    reply: input.reply,
    steps: input.steps,
  };
}

// ── filtering, shared by both backends ────────────────────────────────────────

interface Where {
  sql: string;
  params: unknown[];
}

function buildWhere(filter: UsageFilter, alias = "t"): Where {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.from != null) {
    clauses.push(`${alias}.at >= ?`);
    params.push(filter.from);
  }
  if (filter.to != null) {
    clauses.push(`${alias}.at <= ?`);
    params.push(filter.to);
  }
  if (filter.mode) {
    clauses.push(`${alias}.mode = ?`);
    params.push(filter.mode);
  }
  if (filter.model) {
    clauses.push(`(${alias}.model = ? OR ${alias}.advertised_model = ?)`);
    params.push(filter.model, filter.model);
  }
  if (filter.sessionId) {
    clauses.push(`${alias}.session_id = ?`);
    params.push(filter.sessionId);
  }
  if (filter.dialect) {
    clauses.push(`${alias}.dialect = ?`);
    params.push(filter.dialect);
  }
  if (filter.status === "ok") clauses.push(`${alias}.ok = 1`);
  if (filter.status === "error") clauses.push(`${alias}.ok = 0`);
  if (filter.q) {
    clauses.push(`(${alias}.prompt LIKE ? OR ${alias}.reply LIKE ?)`);
    const like = `%${filter.q}%`;
    params.push(like, like);
  }
  if (filter.tool) {
    clauses.push(
      `EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.turn_id = ${alias}.id AND tc.name = ?)`,
    );
    params.push(filter.tool);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function matches(turn: TurnRecord, filter: UsageFilter): boolean {
  if (filter.from != null && turn.at < filter.from) return false;
  if (filter.to != null && turn.at > filter.to) return false;
  if (filter.mode && turn.mode !== filter.mode) return false;
  if (filter.model && turn.model !== filter.model && turn.advertisedModel !== filter.model) {
    return false;
  }
  if (filter.sessionId && turn.sessionId !== filter.sessionId) return false;
  if (filter.dialect && turn.dialect !== filter.dialect) return false;
  if (filter.status === "ok" && !turn.ok) return false;
  if (filter.status === "error" && turn.ok) return false;
  if (filter.q) {
    const needle = filter.q.toLowerCase();
    const hay = (turn.prompt + " " + turn.reply).toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (filter.tool && !turn.steps.some((s) => s.tools.some((t) => t.name === filter.tool))) {
    return false;
  }
  return true;
}

function emptySummary(): UsageSummary {
  return {
    turns: 0,
    errors: 0,
    steps: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    headline: 0,
    peakContext: 0,
    costUsd: 0,
    firstAt: null,
    lastAt: null,
  };
}

// ── in-memory backend ─────────────────────────────────────────────────────────

/**
 * Ring-buffered fallback. Used when persistence is off, and when opening the
 * database fails — losing history is a far smaller problem than a server that
 * will not start because a directory is read-only.
 */
export class MemoryUsageStore implements UsageStore {
  #turns: TurnRecord[] = [];
  #max: number;

  constructor(max = 5000) {
    this.#max = max;
  }

  record(turn: TurnRecord): void {
    this.#turns.push(turn);
    if (this.#turns.length > this.#max) this.#turns.shift();
  }

  #select(filter: UsageFilter): TurnRecord[] {
    return this.#turns.filter((t) => matches(t, filter));
  }

  summary(filter: UsageFilter): UsageSummary {
    const out = emptySummary();
    for (const turn of this.#select(filter)) {
      out.turns += 1;
      if (!turn.ok) out.errors += 1;
      out.steps += turn.steps.length;
      out.toolCalls += turn.steps.reduce((a, s) => a + s.tools.length, 0);
      out.inputTokens += turn.usage.inputTokens;
      out.outputTokens += turn.usage.outputTokens;
      out.cacheReadTokens += turn.usage.cacheReadTokens;
      out.cacheCreationTokens += turn.usage.cacheCreationTokens;
      out.headline += turn.headline;
      out.costUsd += turn.usage.costUsd;
      if (turn.peakContext > out.peakContext) out.peakContext = turn.peakContext;
      if (out.firstAt === null || turn.at < out.firstAt) out.firstAt = turn.at;
      if (out.lastAt === null || turn.at > out.lastAt) out.lastAt = turn.at;
    }
    return out;
  }

  turns(filter: UsageFilter): TurnRecord[] {
    const rows = this.#select(filter).sort((a, b) => b.at - a.at);
    const offset = filter.offset ?? 0;
    return rows.slice(offset, offset + (filter.limit ?? 200));
  }

  steps(turnId: string): Array<Step & { turnId: string }> {
    const turn = this.#turns.find((t) => t.id === turnId);
    return turn ? turn.steps.map((s) => ({ ...s, turnId })) : [];
  }

  series(filter: UsageFilter, bucket: Bucket): SeriesPoint[] {
    const size = BUCKET_MS[bucket];
    const points = new Map<number, SeriesPoint>();
    for (const turn of this.#select(filter)) {
      const key = Math.floor(turn.at / size) * size;
      let point = points.get(key);
      if (!point) {
        point = {
          bucket: key,
          turns: 0,
          headline: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          peakContext: 0,
        };
        points.set(key, point);
      }
      point.turns += 1;
      point.headline += turn.headline;
      point.inputTokens += turn.usage.inputTokens;
      point.outputTokens += turn.usage.outputTokens;
      point.cacheReadTokens += turn.usage.cacheReadTokens;
      point.cacheCreationTokens += turn.usage.cacheCreationTokens;
      point.costUsd += turn.usage.costUsd;
      if (turn.peakContext > point.peakContext) point.peakContext = turn.peakContext;
    }
    return [...points.values()].sort((a, b) => a.bucket - b.bucket);
  }

  tools(filter: UsageFilter): ToolRollup[] {
    const rollups = new Map<string, ToolRollup & { turnIds: Set<string> }>();
    for (const turn of this.#select(filter)) {
      for (const call of attributeTools(turn.steps)) {
        let entry = rollups.get(call.name);
        if (!entry) {
          entry = {
            name: call.name,
            calls: 0,
            requestTokens: 0,
            resultTokens: 0,
            totalTokens: 0,
            turns: 0,
            turnIds: new Set(),
          };
          rollups.set(call.name, entry);
        }
        entry.calls += 1;
        entry.requestTokens += call.requestTokens;
        entry.resultTokens += call.resultTokens;
        entry.totalTokens += call.totalTokens;
        entry.turnIds.add(turn.id);
      }
    }
    return [...rollups.values()]
      .map(({ turnIds, ...rest }) => ({ ...rest, turns: turnIds.size }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  facets(): { modes: string[]; models: string[]; dialects: string[]; tools: string[] } {
    const modes = new Set<string>();
    const models = new Set<string>();
    const dialects = new Set<string>();
    const tools = new Set<string>();
    for (const turn of this.#turns) {
      modes.add(turn.mode);
      models.add(turn.advertisedModel);
      dialects.add(turn.dialect);
      for (const step of turn.steps) for (const tool of step.tools) tools.add(tool.name);
    }
    const sorted = (s: Set<string>) => [...s].filter(Boolean).sort();
    return {
      modes: sorted(modes),
      models: sorted(models),
      dialects: sorted(dialects),
      tools: sorted(tools),
    };
  }

  flush(): void {
    /* nothing buffered */
  }

  close(): void {
    this.#turns = [];
  }
}

// ── SQLite backend ────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id               TEXT PRIMARY KEY,
  at               INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  session_id       TEXT NOT NULL,
  dialect          TEXT NOT NULL,
  mode             TEXT NOT NULL,
  model            TEXT NOT NULL,
  advertised_model TEXT NOT NULL,
  stream           INTEGER NOT NULL,
  cwd              TEXT NOT NULL,
  reused           INTEGER NOT NULL,
  ok               INTEGER NOT NULL,
  error_message    TEXT,
  input            INTEGER NOT NULL,
  output           INTEGER NOT NULL,
  cache_read       INTEGER NOT NULL,
  cache_creation   INTEGER NOT NULL,
  headline         INTEGER NOT NULL,
  peak_context     INTEGER NOT NULL,
  cost_usd         REAL    NOT NULL,
  step_count       INTEGER NOT NULL,
  tool_call_count  INTEGER NOT NULL,
  client_tool_calls INTEGER NOT NULL,
  prompt           TEXT NOT NULL,
  reply            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_at      ON turns(at);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS turns_mode    ON turns(mode);
CREATE INDEX IF NOT EXISTS turns_model   ON turns(advertised_model);

CREATE TABLE IF NOT EXISTS steps (
  turn_id        TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  message_id     TEXT NOT NULL,
  model          TEXT NOT NULL,
  at             INTEGER NOT NULL,
  input          INTEGER NOT NULL,
  output         INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cache_creation INTEGER NOT NULL,
  PRIMARY KEY (turn_id, idx)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  turn_id        TEXT NOT NULL,
  step_idx       INTEGER NOT NULL,
  seq            INTEGER NOT NULL,
  name           TEXT NOT NULL,
  summary        TEXT NOT NULL,
  request_tokens INTEGER NOT NULL,
  result_tokens  INTEGER NOT NULL,
  total_tokens   INTEGER NOT NULL,
  PRIMARY KEY (turn_id, step_idx, seq)
);
CREATE INDEX IF NOT EXISTS tool_calls_name ON tool_calls(name);
CREATE INDEX IF NOT EXISTS tool_calls_turn ON tool_calls(turn_id);
`;

/** Minimal shape of the bits of node:sqlite this file uses. */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0;
}

export class SqliteUsageStore implements UsageStore {
  #db: SqliteDatabase;
  #pending: TurnRecord[] = [];
  #timer: NodeJS.Timeout;
  #insertTurn: SqliteStatement;
  #insertStep: SqliteStatement;
  #insertTool: SqliteStatement;

  constructor(db: SqliteDatabase, flushMs: number, retentionDays: number) {
    this.#db = db;
    db.exec(SCHEMA);

    this.#insertTurn = db.prepare(`
      INSERT OR REPLACE INTO turns VALUES
      (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    this.#insertStep = db.prepare(
      `INSERT OR REPLACE INTO steps VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    this.#insertTool = db.prepare(
      `INSERT OR REPLACE INTO tool_calls VALUES (?,?,?,?,?,?,?,?)`,
    );

    if (retentionDays > 0) this.#prune(retentionDays);

    this.#timer = setInterval(() => this.flush(), flushMs);
    this.#timer.unref?.();
  }

  /**
   * Open the database, falling back to memory rather than refusing to boot.
   * `node:sqlite` is imported here and nowhere else, so a server running without
   * persistence never loads it — and never prints its experimental warning.
   */
  static async open(
    path: string,
    flushMs: number,
    retentionDays: number,
  ): Promise<UsageStore> {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const { DatabaseSync } = (await import("node:sqlite")) as {
        DatabaseSync: new (p: string) => SqliteDatabase;
      };
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      log.info(`usage history: ${path}`);
      return new SqliteUsageStore(db, flushMs, retentionDays);
    } catch (err) {
      log.warn(
        `usage history disabled: could not open ${path} ` +
          `(${err instanceof Error ? err.message : String(err)}); keeping it in memory`,
      );
      return new MemoryUsageStore();
    }
  }

  #prune(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    try {
      this.#db.prepare(`DELETE FROM steps WHERE turn_id IN (SELECT id FROM turns WHERE at < ?)`).run(cutoff);
      this.#db.prepare(`DELETE FROM tool_calls WHERE turn_id IN (SELECT id FROM turns WHERE at < ?)`).run(cutoff);
      this.#db.prepare(`DELETE FROM turns WHERE at < ?`).run(cutoff);
    } catch (err) {
      log.debug("usage prune failed", { error: String(err) });
    }
  }

  record(turn: TurnRecord): void {
    this.#pending.push(turn);
    // A burst of traffic should not sit in memory until the next tick.
    if (this.#pending.length >= 64) this.flush();
  }

  flush(): void {
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];

    try {
      this.#db.exec("BEGIN");
      for (const turn of batch) this.#write(turn);
      this.#db.exec("COMMIT");
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* the transaction was never opened */
      }
      // Bookkeeping is not worth crashing a working server over.
      log.warn(`could not persist ${batch.length} usage record(s): ${String(err)}`);
    }
  }

  #write(turn: TurnRecord): void {
    const toolCount = turn.steps.reduce((a, s) => a + s.tools.length, 0);
    this.#insertTurn.run(
      turn.id,
      turn.at,
      turn.durationMs,
      turn.sessionId,
      turn.dialect,
      turn.mode,
      turn.model,
      turn.advertisedModel,
      turn.stream ? 1 : 0,
      turn.cwd,
      turn.reused ? 1 : 0,
      turn.ok ? 1 : 0,
      turn.errorMessage,
      turn.usage.inputTokens,
      turn.usage.outputTokens,
      turn.usage.cacheReadTokens,
      turn.usage.cacheCreationTokens,
      turn.headline,
      turn.peakContext,
      turn.usage.costUsd,
      turn.steps.length,
      toolCount,
      turn.clientToolCalls,
      turn.prompt,
      turn.reply,
    );

    for (const step of turn.steps) {
      this.#insertStep.run(
        turn.id,
        step.index,
        step.messageId,
        step.model,
        step.at,
        step.usage.inputTokens,
        step.usage.outputTokens,
        step.usage.cacheReadTokens,
        step.usage.cacheCreationTokens,
      );
    }

    // Attribution is computed once, on write: it depends on the whole step
    // sequence, so recomputing it per query would mean re-reading every step.
    const attributed = attributeTools(turn.steps);
    const seqByStep = new Map<number, number>();
    for (const call of attributed) {
      const seq = seqByStep.get(call.step) ?? 0;
      seqByStep.set(call.step, seq + 1);
      this.#insertTool.run(
        turn.id,
        call.step,
        seq,
        call.name,
        call.summary,
        call.requestTokens,
        call.resultTokens,
        call.totalTokens,
      );
    }
  }

  summary(filter: UsageFilter): UsageSummary {
    this.flush();
    const where = buildWhere(filter);
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) turns, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) errors,
                SUM(step_count) steps, SUM(tool_call_count) toolCalls,
                SUM(input) input, SUM(output) output,
                SUM(cache_read) cacheRead, SUM(cache_creation) cacheCreation,
                SUM(headline) headline, MAX(peak_context) peakContext,
                SUM(cost_usd) costUsd, MIN(at) firstAt, MAX(at) lastAt
         FROM turns t ${where.sql}`,
      )
      .get(...where.params);

    if (!row || n(row["turns"]) === 0) return emptySummary();
    return {
      turns: n(row["turns"]),
      errors: n(row["errors"]),
      steps: n(row["steps"]),
      toolCalls: n(row["toolCalls"]),
      inputTokens: n(row["input"]),
      outputTokens: n(row["output"]),
      cacheReadTokens: n(row["cacheRead"]),
      cacheCreationTokens: n(row["cacheCreation"]),
      headline: n(row["headline"]),
      peakContext: n(row["peakContext"]),
      costUsd: n(row["costUsd"]),
      firstAt: row["firstAt"] == null ? null : n(row["firstAt"]),
      lastAt: row["lastAt"] == null ? null : n(row["lastAt"]),
    };
  }

  turns(filter: UsageFilter): TurnRecord[] {
    this.flush();
    const where = buildWhere(filter);
    const rows = this.#db
      .prepare(`SELECT * FROM turns t ${where.sql} ORDER BY t.at DESC LIMIT ? OFFSET ?`)
      .all(...where.params, filter.limit ?? 200, filter.offset ?? 0);
    return rows.map((r) => this.#hydrate(r));
  }

  /**
   * Rows come back without their steps: a turn list is a table, and loading
   * every model call for every row to render it would be pure waste. The steps
   * endpoint fills them in for the one row a user expands.
   */
  #hydrate(row: Record<string, unknown>): TurnRecord {
    return {
      id: String(row["id"]),
      at: n(row["at"]),
      durationMs: n(row["duration_ms"]),
      sessionId: String(row["session_id"] ?? ""),
      dialect: (row["dialect"] === "anthropic" ? "anthropic" : "openai") as "openai" | "anthropic",
      mode: String(row["mode"]) as Mode,
      model: String(row["model"] ?? ""),
      advertisedModel: String(row["advertised_model"] ?? ""),
      stream: n(row["stream"]) === 1,
      cwd: String(row["cwd"] ?? ""),
      reused: n(row["reused"]) === 1,
      ok: n(row["ok"]) === 1,
      errorMessage: row["error_message"] == null ? null : String(row["error_message"]),
      usage: {
        inputTokens: n(row["input"]),
        outputTokens: n(row["output"]),
        cacheReadTokens: n(row["cache_read"]),
        cacheCreationTokens: n(row["cache_creation"]),
        costUsd: n(row["cost_usd"]),
      },
      headline: n(row["headline"]),
      peakContext: n(row["peak_context"]),
      clientToolCalls: n(row["client_tool_calls"]),
      prompt: String(row["prompt"] ?? ""),
      reply: String(row["reply"] ?? ""),
      steps: [],
    };
  }

  steps(turnId: string): Array<Step & { turnId: string }> {
    this.flush();
    const stepRows = this.#db
      .prepare(`SELECT * FROM steps WHERE turn_id = ? ORDER BY idx`)
      .all(turnId);
    const toolRows = this.#db
      .prepare(`SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY step_idx, seq`)
      .all(turnId);

    const toolsByStep = new Map<number, Array<{ id: string; name: string; summary: string }>>();
    for (const row of toolRows) {
      const idx = n(row["step_idx"]);
      const list = toolsByStep.get(idx) ?? [];
      // Block ids are not persisted — they matter only while a turn is being
      // assembled, and the row's position already identifies it afterwards.
      list.push({ id: "", name: String(row["name"]), summary: String(row["summary"] ?? "") });
      toolsByStep.set(idx, list);
    }

    return stepRows.map((row) => ({
      turnId,
      messageId: String(row["message_id"]),
      index: n(row["idx"]),
      model: String(row["model"] ?? ""),
      at: n(row["at"]),
      usage: {
        inputTokens: n(row["input"]),
        outputTokens: n(row["output"]),
        cacheReadTokens: n(row["cache_read"]),
        cacheCreationTokens: n(row["cache_creation"]),
        costUsd: 0,
      },
      tools: toolsByStep.get(n(row["idx"])) ?? [],
    }));
  }

  series(filter: UsageFilter, bucket: Bucket): SeriesPoint[] {
    this.flush();
    const size = BUCKET_MS[bucket];
    const where = buildWhere(filter);
    const rows = this.#db
      .prepare(
        `SELECT (t.at / ${size}) * ${size} AS bucket,
                COUNT(*) turns, SUM(headline) headline,
                SUM(input) input, SUM(output) output,
                SUM(cache_read) cacheRead, SUM(cache_creation) cacheCreation,
                SUM(cost_usd) costUsd, MAX(peak_context) peakContext
         FROM turns t ${where.sql}
         GROUP BY bucket ORDER BY bucket`,
      )
      .all(...where.params);

    return rows.map((row) => ({
      bucket: n(row["bucket"]),
      turns: n(row["turns"]),
      headline: n(row["headline"]),
      inputTokens: n(row["input"]),
      outputTokens: n(row["output"]),
      cacheReadTokens: n(row["cacheRead"]),
      cacheCreationTokens: n(row["cacheCreation"]),
      costUsd: n(row["costUsd"]),
      peakContext: n(row["peakContext"]),
    }));
  }

  tools(filter: UsageFilter): ToolRollup[] {
    this.flush();
    const where = buildWhere(filter);
    const rows = this.#db
      .prepare(
        `SELECT tc.name name, COUNT(*) calls,
                SUM(tc.request_tokens) requestTokens,
                SUM(tc.result_tokens)  resultTokens,
                SUM(tc.total_tokens)   totalTokens,
                COUNT(DISTINCT tc.turn_id) turns
         FROM tool_calls tc JOIN turns t ON t.id = tc.turn_id
         ${where.sql}
         GROUP BY tc.name ORDER BY totalTokens DESC`,
      )
      .all(...where.params);

    return rows.map((row) => ({
      name: String(row["name"]),
      calls: n(row["calls"]),
      requestTokens: n(row["requestTokens"]),
      resultTokens: n(row["resultTokens"]),
      totalTokens: n(row["totalTokens"]),
      turns: n(row["turns"]),
    }));
  }

  facets(): { modes: string[]; models: string[]; dialects: string[]; tools: string[] } {
    this.flush();
    const column = (sql: string) =>
      this.#db
        .prepare(sql)
        .all()
        .map((r) => String(Object.values(r)[0] ?? ""))
        .filter(Boolean);
    return {
      modes: column(`SELECT DISTINCT mode FROM turns ORDER BY mode`),
      models: column(`SELECT DISTINCT advertised_model FROM turns ORDER BY advertised_model`),
      dialects: column(`SELECT DISTINCT dialect FROM turns ORDER BY dialect`),
      tools: column(`SELECT DISTINCT name FROM tool_calls ORDER BY name`),
    };
  }

  close(): void {
    clearInterval(this.#timer);
    this.flush();
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Build the store the config asks for. */
export async function createUsageStore(options: {
  enabled: boolean;
  path: string;
  flushMs: number;
  retentionDays: number;
  memoryMax: number;
}): Promise<UsageStore> {
  if (!options.enabled) return new MemoryUsageStore(options.memoryMax);
  return SqliteUsageStore.open(options.path, options.flushMs, options.retentionDays);
}
