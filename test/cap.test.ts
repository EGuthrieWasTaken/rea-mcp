import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HARNESS_KEY, connectClient, startHarness, textOf } from "./helpers/gateway.js";

const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

// `key` is null for "send no key": undefined would pick up the default.
const post = (url: string, body: unknown, key: string | null = HARNESS_KEY): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(key === null ? {} : { "x-api-key": key }),
    },
    body: JSON.stringify(body),
  });

describe("MAX_SESSIONS", () => {
  it("answers 503 with Retry-After at the cap, starts no process, and evicts nobody", async () => {
    const harness = await startHarness({ maxSessions: 2 });
    const first = await connectClient(harness);
    const second = await connectClient(harness);
    expect(harness.manager.spawnAttempts).toBe(2);

    const refused = await post(harness.url, initialize(7));
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await refused.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: 7 });

    // Nothing was started, and both live sessions still work.
    expect(harness.manager.spawnAttempts).toBe(2);
    expect(harness.manager.size).toBe(2);
    expect(readdirSync(harness.sessionsDir)).toHaveLength(2);
    expect(textOf(await first.client.callTool({ name: "echo", arguments: { text: "still here" } }))).toBe("still here");
    expect(textOf(await second.client.callTool({ name: "echo", arguments: { text: "me too" } }))).toBe("me too");
    expect(harness.entries().find((entry) => entry.message === "session cap reached")).toMatchObject({ level: "warn", count: 2 });
  });

  it("lets a new session start once a live one has ended", async () => {
    const harness = await startHarness({ maxSessions: 1 });
    const first = await connectClient(harness);
    expect((await post(harness.url, initialize(2))).status).toBe(503);

    await first.transport.terminateSession(); // DELETE /mcp
    await expect.poll(() => harness.manager.size).toBe(0);

    const third = await connectClient(harness);
    expect(textOf(await third.client.callTool({ name: "echo", arguments: { text: "back" } }))).toBe("back");
  });

  it("cannot be overshot by simultaneous initialize requests", async () => {
    // A slow child keeps every start in flight while the rest of the burst arrives:
    // exactly the window in which a check-then-spawn race would let extra sessions through.
    const harness = await startHarness({ maxSessions: 3, flags: ["--startup-delay-ms=300"] });
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => post(harness.url, initialize(index + 1))));
    const statuses = responses.map((response) => response.status).sort();
    await Promise.all(responses.map((response) => response.text()));

    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 503)).toHaveLength(7);
    expect(harness.manager.spawnAttempts).toBe(3);
    expect(harness.manager.size).toBe(3);
    expect(readdirSync(harness.sessionsDir)).toHaveLength(3);
  });

  it("frees the slot of a session that failed to start", async () => {
    const harness = await startHarness({ maxSessions: 1, flags: ["--fail-start"] });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Always 502 (the start failed), never 503 (the cap): each failure released its slot.
      expect((await post(harness.url, initialize(attempt))).status).toBe(502);
    }
    expect(harness.manager.spawnAttempts).toBe(3);
    expect(harness.manager.size).toBe(0);
  });

  it("does not tell an unauthenticated caller that the cap was reached", async () => {
    const harness = await startHarness({ maxSessions: 1 });
    await connectClient(harness);
    const response = await post(harness.url, initialize(2), null);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });
});
