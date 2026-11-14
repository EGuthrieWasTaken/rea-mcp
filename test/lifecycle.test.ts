import { describe, expect, it } from "vitest";
import { HARNESS_KEY, connectClient, startHarness, textOf } from "./helpers/gateway.js";
import { sleep } from "./helpers/fake-rea.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A raw request that carries a session id, with the headers MCP requires after initialize. */
const withSession = (
  url: string,
  sessionId: string,
  options: { key?: string | null; method?: string } = {},
): Promise<Response> => {
  const method = options.method ?? "POST";
  const key = options.key === undefined ? HARNESS_KEY : options.key;
  return fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": sessionId,
      ...(key === null ? {} : { "x-api-key": key }),
    },
    ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }) } : {}),
  });
};

/** Everything about a reply that must not differ between failure causes (not the Date). */
const shape = async (response: Response): Promise<unknown> => ({
  status: response.status,
  body: await response.text(),
  headers: Object.fromEntries([...response.headers.entries()].filter(([name]) => name !== "date")),
});

const reasonsEnded = (entries: Record<string, unknown>[]): unknown[] =>
  entries.filter((entry) => entry.message === "session ended").map((entry) => entry.reason);

describe("DELETE /mcp", () => {
  it("ends the session, stops its REA, and makes the session id unknown", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);
    const pid = Number(textOf(await client.callTool({ name: "pid" })));
    const sessionId = transport.sessionId ?? "missing";
    expect(alive(pid)).toBe(true);

    await transport.terminateSession();
    await expect.poll(() => harness.manager.size, { timeout: 5_000 }).toBe(0);
    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);

    const later = await withSession(harness.url, sessionId);
    expect(later.status).toBe(404);
    expect(await later.text()).toBe("");
    expect(reasonsEnded(harness.entries())).toEqual(["deleted by client"]);
  });

  it("does nothing for a DELETE without a valid key, and the session carries on", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);
    const response = await withSession(harness.url, transport.sessionId ?? "", { method: "DELETE", key: "not-the-key" });
    expect(response.status).toBe(401);
    expect(harness.manager.size).toBe(1);
    expect(textOf(await client.callTool({ name: "echo", arguments: { text: "alive" } }))).toBe("alive");
  });
});

describe("idle reaping (scaled time)", () => {
  it("ends a session that has been idle for the timeout, stopping its REA", async () => {
    const harness = await startHarness({ idleTimeoutMs: 400, reapIntervalMs: 30 });
    const { client, transport } = await connectClient(harness);
    const pid = Number(textOf(await client.callTool({ name: "pid" })));
    await sleep(150);
    expect(harness.manager.size).toBe(1);

    await expect.poll(() => harness.manager.size, { timeout: 5_000 }).toBe(0);
    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
    expect((await withSession(harness.url, transport.sessionId ?? "")).status).toBe(404);
    expect(reasonsEnded(harness.entries())).toEqual(["idle"]);
  });

  it("keeps a session alive as long as it is used", async () => {
    const harness = await startHarness({ idleTimeoutMs: 500, reapIntervalMs: 30 });
    const { client } = await connectClient(harness);
    for (let i = 0; i < 8; i += 1) {
      await sleep(150);
      expect(textOf(await client.callTool({ name: "echo", arguments: { text: String(i) } }))).toBe(String(i));
    }
    expect(harness.manager.size).toBe(1);
    await expect.poll(() => harness.manager.size, { timeout: 5_000 }).toBe(0);
  });

  it("does not reap a session whose call outlives the idle timeout, and restarts the timer afterwards", async () => {
    const harness = await startHarness({ idleTimeoutMs: 300, reapIntervalMs: 30 });
    const { client } = await connectClient(harness);

    const call = client.callTool({ name: "slow", arguments: { ms: 1_300 } });
    await sleep(900); // three idle timeouts, with a request in flight the whole time
    expect(harness.manager.size).toBe(1);
    expect(textOf(await call)).toBe("done");

    // The timer restarted when the answer arrived: it is not reaped at once...
    await sleep(100);
    expect(harness.manager.size).toBe(1);
    // ...but is once the idle timeout has passed again.
    await expect.poll(() => harness.manager.size, { timeout: 5_000 }).toBe(0);
    expect(reasonsEnded(harness.entries())).toEqual(["idle"]);
  });

  it("does not let a cancelled call keep the session alive for ever", async () => {
    const harness = await startHarness({ idleTimeoutMs: 300, reapIntervalMs: 30 });
    const { client } = await connectClient(harness);
    const controller = new AbortController();
    const call = client.callTool({ name: "slow", arguments: { ms: 60_000 } }, undefined, { signal: controller.signal });
    await sleep(100);
    controller.abort();
    await expect(call).rejects.toBeDefined();
    await expect.poll(() => harness.manager.size, { timeout: 5_000 }).toBe(0);
  });

  it("is not reset by a request with a wrong key, and does not reveal a live session", async () => {
    const harness = await startHarness({ idleTimeoutMs: 600, reapIntervalMs: 30 });
    const { transport } = await connectClient(harness);
    const live = transport.sessionId ?? "";

    // The same bare 401 whether the session id is live or unknown.
    const [liveReply, unknownReply] = [
      await shape(await withSession(harness.url, live, { key: "wrong-key" })),
      await shape(await withSession(harness.url, "no-such-session", { key: "wrong-key" })),
    ];
    expect(liveReply).toMatchObject({ status: 401, body: "" });
    expect(liveReply).toEqual(unknownReply);

    // Keep hammering the live session with wrong keys. If that reset the idle timer
    // the session would outlive the timeout; it must not.
    const began = Date.now();
    for (let i = 0; i < 7; i += 1) {
      await sleep(100);
      expect((await withSession(harness.url, live, { key: "still-wrong" })).status).toBe(401);
    }
    expect(Date.now() - began).toBeGreaterThanOrEqual(700);
    await expect.poll(() => harness.manager.size, { timeout: 3_000 }).toBe(0);
  });
});

describe("REA exiting by itself", () => {
  it("answers a call it dies in the middle of with an error, then ends the session", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);
    await expect(client.callTool({ name: "crash", arguments: { code: 9 } })).rejects.toMatchObject({ code: -32603 });

    await expect.poll(() => harness.manager.size, { timeout: 5_000 }).toBe(0);
    expect((await withSession(harness.url, transport.sessionId ?? "")).status).toBe(404);
    const entries = harness.entries();
    expect(entries.find((entry) => entry.message === "REA exited")).toMatchObject({ level: "warn", exitCode: 9 });
    expect(reasonsEnded(entries)).toEqual(["REA exited"]);
  });

  it("fails every call that was waiting on it, not just the one that killed it", async () => {
    const harness = await startHarness();
    const { client } = await connectClient(harness);
    const waiting = client.callTool({ name: "slow", arguments: { ms: 60_000 } });
    const alsoWaiting = client.callTool({ name: "slow", arguments: { ms: 60_000 } });
    await sleep(100);
    const crashing = client.callTool({ name: "crash", arguments: { code: 3 } });
    for (const call of [waiting, alsoWaiting, crashing]) await expect(call).rejects.toMatchObject({ code: -32603 });
  });

  it("notices a REA killed from outside while the session is idle, logging the signal", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);
    const pid = Number(textOf(await client.callTool({ name: "pid" })));
    process.kill(pid, "SIGKILL");

    await expect.poll(() => harness.manager.size, { timeout: 5_000 }).toBe(0);
    expect(harness.entries().find((entry) => entry.message === "REA exited")).toMatchObject({ signal: "SIGKILL" });
    expect((await withSession(harness.url, transport.sessionId ?? "")).status).toBe(404);
  });

  it("releases the slot, so a replacement session can start at the cap", async () => {
    const harness = await startHarness({ maxSessions: 1 });
    const { client } = await connectClient(harness);
    await expect(client.callTool({ name: "crash" })).rejects.toBeDefined();
    await expect.poll(() => harness.manager.size, { timeout: 5_000 }).toBe(0);
    const replacement = await connectClient(harness);
    expect(textOf(await replacement.client.callTool({ name: "echo", arguments: { text: "new" } }))).toBe("new");
  });
});
