const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

let current: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] > LEVELS[current]) return;
  const time = new Date().toISOString().slice(11, 23);
  const tail = extra && Object.keys(extra).length > 0 ? " " + JSON.stringify(extra) : "";
  // stdout is reserved for nothing in particular, but keeping logs on stderr
  // means `claude-socket > file` stays clean if we ever pipe output.
  process.stderr.write(`${time} ${level.padEnd(5)} ${msg}${tail}\n`);
}

export const log = {
  error: (m: string, e?: Record<string, unknown>) => emit("error", m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit("warn", m, e),
  info: (m: string, e?: Record<string, unknown>) => emit("info", m, e),
  debug: (m: string, e?: Record<string, unknown>) => emit("debug", m, e),
};
