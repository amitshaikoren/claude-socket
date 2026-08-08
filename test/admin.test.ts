import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, authHeaders, type TestServer } from "./helpers.ts";
import { telemetry } from "../src/core/telemetry.ts";

describe("dashboard and admin API", () => {
  let server: TestServer;

  before(async () => {
    telemetry.reset();
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  const chat = (content: string) =>
    fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ model: "oracle", messages: [{ role: "user", content }] }),
    });

  test("serves the dashboard shell without a token", async () => {
    const res = await fetch(`${server.base}/ui`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /claude-socket/);
    assert.match(html, /admin\/events/);
  });

  test("stats require a token", async () => {
    assert.equal((await fetch(`${server.base}/admin/stats`)).status, 401);
  });

  test("the 401 points a loopback caller at the route that would tell it the token", async () => {
    // A token this instance generated at startup is not one the caller can
    // guess. Bootstrap already discloses it to loopback, so naming it here
    // gives away nothing and saves guessing which key is live.
    const res = await fetch(`${server.base}/admin/stats`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.match(body.error.message, /admin\/bootstrap/);
  });

  test("a proxied 401 keeps the hint to itself", async () => {
    const res = await fetch(`${server.base}/admin/stats`, {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.doesNotMatch(body.error.message, /bootstrap/);
  });

  test("bootstrap hands tokens to a local dashboard so it can self-authenticate", async () => {
    const res = await fetch(`${server.base}/admin/bootstrap`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.local, true);
    assert.equal(body.authRequired, true);
    assert.deepEqual(body.tokens, ["test-token"]);

    // The disclosed token must actually work, or auto-connect is a lie.
    const stats = await fetch(`${server.base}/admin/stats?api_key=${body.tokens[0]}`);
    assert.equal(stats.status, 200);
  });

  test("bootstrap withholds tokens from a proxied request", async () => {
    // A forwarding header means the peer address is the proxy, not the client,
    // so loopback can no longer be trusted as proof of locality.
    for (const header of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
      const res = await fetch(`${server.base}/admin/bootstrap`, {
        headers: { [header]: "203.0.113.9" },
      });
      const body = (await res.json()) as any;
      assert.equal(body.local, false, `${header} must defeat auto-auth`);
      assert.deepEqual(body.tokens, [], `${header} must withhold tokens`);
    }
  });

  test("bootstrap withholds tokens when auto-auth is switched off", async () => {
    const strict = await startTestServer(
      (() => {
        const cfg = server.cfg;
        return { ...cfg, dashboard: { localAutoAuth: false } };
      })(),
    );
    try {
      const body = (await (await fetch(`${strict.base}/admin/bootstrap`)).json()) as any;
      assert.equal(body.local, false);
      assert.deepEqual(body.tokens, []);
    } finally {
      await strict.close();
    }
  });

  test("bootstrap reports when auth is disabled entirely", async () => {
    const open = await startTestServer(
      (() => {
        const cfg = server.cfg;
        return { ...cfg, auth: { tokens: [], required: false } };
      })(),
    );
    try {
      const body = (await (await fetch(`${open.base}/admin/bootstrap`)).json()) as any;
      assert.equal(body.authRequired, false);
      assert.deepEqual(body.tokens, []);
      assert.equal((await fetch(`${open.base}/admin/stats`)).status, 200);
    } finally {
      await open.close();
    }
  });

  test("accepts the token as a query parameter, for EventSource", async () => {
    const res = await fetch(`${server.base}/admin/stats?api_key=test-token`);
    assert.equal(res.status, 200);
  });

  test("totals accumulate across turns", async () => {
    await chat("first telemetry probe");
    await chat("second telemetry probe");

    const stats = (await (await fetch(`${server.base}/admin/stats`, { headers: authHeaders() })).json()) as any;
    assert.ok(stats.totals.requests >= 2);
    assert.ok(stats.totals.turns >= 2);
    assert.ok(stats.totals.outputTokens > 0);
    assert.equal(stats.config.defaultMode, "oracle");
    assert.ok(Array.isArray(stats.sessions));
  });

  test("the event feed replays history and then streams live", async () => {
    const res = await fetch(`${server.base}/admin/events?history=50`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: any[] = [];

    // Drain the replayed history, then trigger a fresh turn and watch it arrive.
    const readSome = async (until: (list: any[]) => boolean, budgetMs: number) => {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline && !until(events)) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 500),
          ),
        ]);
        if (!chunk.value) continue;
        buffer += decoder.decode(chunk.value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
    };

    await readSome((list) => list.length > 0, 3000);
    assert.ok(events.length > 0, "history was replayed");

    const before = events.length;
    await chat("live feed probe");
    await readSome((list) => list.length > before, 5000);

    const live = events.slice(before);
    assert.ok(live.some((e) => e.type === "request" || e.type === "turn"), "a live event arrived");

    await reader.cancel();
  });

  test("a session can be killed by id", async () => {
    await chat("session to be killed");
    const listed = (await (await fetch(`${server.base}/admin/sessions`, { headers: authHeaders() })).json()) as any;
    const target = listed.sessions[0];
    assert.ok(target?.sessionId);

    const killed = await fetch(`${server.base}/admin/sessions/${target.sessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(killed.status, 200);

    const after = (await (await fetch(`${server.base}/admin/sessions`, { headers: authHeaders() })).json()) as any;
    assert.ok(!after.sessions.some((s: any) => s.sessionId === target.sessionId));

    assert.equal(
      (await fetch(`${server.base}/admin/sessions/${target.sessionId}`, {
        method: "DELETE",
        headers: authHeaders(),
      })).status,
      404,
    );
  });
});
