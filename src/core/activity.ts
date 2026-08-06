/** Compact one-line renderings of agent activity, for harness streaming. */

const PRIMARY_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "prompt",
  "description",
  "notebook_path",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function summarizeInput(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const key of PRIMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const flat = value.replace(/\s+/g, " ").trim();
      return flat.length > 80 ? flat.slice(0, 77) + "..." : flat;
    }
  }
  const keys = Object.keys(input);
  return keys.length > 0 ? keys.join(", ") : "";
}

export function formatToolUse(name: string, input: unknown): string {
  const summary = summarizeInput(input);
  return summary ? `\n→ ${name}(${summary})\n` : `\n→ ${name}\n`;
}

export function formatToolResult(name: string, isError: boolean, preview: string): string {
  if (!isError) return "";
  const flat = preview.replace(/\s+/g, " ").trim();
  return `\n✗ ${name || "tool"} failed: ${flat.slice(0, 200)}\n`;
}
