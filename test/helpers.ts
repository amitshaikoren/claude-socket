import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { defaultConfig, type Config } from "../src/core/config.ts";
import { SessionManager } from "../src/claude/sessions.ts";
import { createBridgeServer } from "../src/http/server.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLI = join(here, "fake-claude.mjs");

/** A config wired to the fake CLI instead of the real one. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const cfg = defaultConfig();
  cfg.claude.binary = process.execPath;
  cfg.claude.binaryArgs = [FAKE_CLI];
  cfg.auth.tokens = ["test-token"];
  cfg.logLevel = "error";
  cfg.harness.workspaceRoot = mkdtempSync(join(tmpdir(), "bridge-test-ws-"));
  cfg.sessions.turnTimeoutMs = 15_000;
  return { ...cfg, ...overrides };
}

export interface TestServer {
  base: string;
  cfg: Config;
  sessions: SessionManager;
  close(): Promise<void>;
}

export async function startTestServer(cfg = testConfig()): Promise<TestServer> {
  const sessions = new SessionManager(cfg);
  const server = createBridgeServer(cfg, sessions);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    cfg,
    sessions,
    close: async () => {
      sessions.shutdown();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export function authHeaders(token = "test-token"): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

/** Collect an SSE body into its `data:` payloads. */
export async function readSse(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
}

export const fixturesDir = resolve(here, "fixtures");
