import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_KEY, connectClient, startHarness, textOf } from "./helpers/gateway.js";
import { sleep } from "./helpers/fake-rea.js";
import { tempDir } from "./helpers/tmp.js";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};

/** A POST /mcp with the harness key and the headers MCP requires. */
const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": HARNESS_KEY,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a session through the gateway, with a real MCP client", () => {
  it("initializes, lists REA's tools, and calls one", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);

    expect(client.getServerVersion()).toMatchObject({ name: "fake-rea" });
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "slow", "crash", "env", "cwd", "pid", "grandchild", "log", "stats"]);

    expect(textOf(await client.callTool({ name: "echo", arguments: { text: "hello through the gateway" } }))).toBe(
      "hello through the gateway",
    );
    expect(harness.manager.size).toBe(1);
    await client.close();
  });

  it("starts the child in /work/sessions/<session-id>, created for it", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);
    const expected = join(harness.sessionsDir, transport.sessionId ?? "missing");
    expect(textOf(await client.callTool({ name: "cwd" }))).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    await client.close();
  });

  it("gives two concurrent sessions their own process and working directory", async () => {
    const harness = await startHarness();
    const [a, b] = await Promise.all([connectClient(harness), connectClient(harness)]);
    expect(harness.manager.size).toBe(2);

    const pids = [textOf(await a.client.callTool({ name: "pid" })), textOf(await b.client.callTool({ name: "pid" }))];
    expect(pids[0]).not.toBe(pids[1]);
    const dirs = [textOf(await a.client.callTool({ name: "cwd" })), textOf(await b.client.callTool({ name: "cwd" }))];
    expect(dirs[0]).not.toBe(dirs[1]);
    expect(dirs.every((dir) => dir.startsWith(harness.sessionsDir))).toBe(true);

    // Each client's requests reach only its own process: A makes more calls than B.
    for (let i = 0; i < 3; i += 1) await a.client.callTool({ name: "echo", arguments: { text: "a" } });
    const seen = async (c: typeof a): Promise<number> =>
      (JSON.parse(textOf(await c.client.callTool({ name: "stats" }))) as { requests: number }).requests;
    expect((await seen(a)) - (await seen(b))).toBeGreaterThanOrEqual(3);
    await Promise.all([a.client.close(), b.client.close()]);
  });

  it("starts the child with only the environment it is allowed", async () => {
    const harness = await startHarness({
      gatewayEnv: {
        REA_MCP_API_KEY: "key-one-should-never-be-inherited-by-the-child",
        REA_MCP_API_KEYS: "key-two-should-never-be-inherited-by-the-child",
        REA_MCP_API_KEY_FILE: "/run/secrets/key",
        UNRELATED_SECRET: "also-not-passed",
        GHIDRA_INSTALL_DIR: "/opt/ghidra",
      },
    });
    const { client } = await connectClient(harness);
    const names = ["REA_MCP_API_KEY", "REA_MCP_API_KEYS", "REA_MCP_API_KEY_FILE", "UNRELATED_SECRET", "GHIDRA_INSTALL_DIR"];
    const seen = JSON.parse(textOf(await client.callTool({ name: "env", arguments: { names } }))) as Record<string, string>;
    expect(seen).toEqual({ GHIDRA_INSTALL_DIR: "/opt/ghidra" });
    await client.close();
  });

  it("passes the startup timeout through and maps the heap onto the variable REA reads", async () => {
    const harness = await startHarness({
      gatewayEnv: {
        REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000",
        GHIDRA_MAX_HEAP: "8G",
        GHIDRA_HEADLESS_MAXMEM: "1G", // set directly: must not get through
      },
    });
    const { client } = await connectClient(harness);
    const names = ["REA_GHIDRA_STARTUP_TIMEOUT_MS", "GHIDRA_MAX_HEAP", "GHIDRA_HEADLESS_MAXMEM"];
    const seen = JSON.parse(textOf(await client.callTool({ name: "env", arguments: { names } }))) as Record<string, string>;
    expect(seen).toEqual({ REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000", GHIDRA_HEADLESS_MAXMEM: "8G" });
    await client.close();
  });

  it("passes neither setting when neither is configured", async () => {
    const harness = await startHarness();
    const { client } = await connectClient(harness);
    const names = ["REA_GHIDRA_STARTUP_TIMEOUT_MS", "GHIDRA_MAX_HEAP", "GHIDRA_HEADLESS_MAXMEM"];
    expect(textOf(await client.callTool({ name: "env", arguments: { names } }))).toBe("{}");
    await client.close();
  });

  it("captures the child's stderr into the gateway's log, tagged with the session", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);
    await client.callTool({ name: "log", arguments: { text: "a line REA wrote to stderr" } });
    await sleep(50);
    const entry = harness.entries().find((candidate) => candidate.line === "a line REA wrote to stderr");
    expect(entry).toMatchObject({ level: "debug", stream: "stderr", sessionId: transport.sessionId });
    await client.close();
  });

  it("logs the session's start with its id and process", async () => {
    const harness = await startHarness();
    const { transport, client } = await connectClient(harness);
    const started = harness.entries().find((entry) => entry.message === "session started");
    expect(started).toMatchObject({ level: "info", sessionId: transport.sessionId });
    expect(typeof started?.pid).toBe("number");
    await client.close();
  });
});

describe("a child that cannot start", () => {
  it("answers 502, registers no session, removes the directory, and logs why", async () => {
    const harness = await startHarness({
      launch: { command: "/nonexistent/rea-binary", args: [], env: {} },
    });
    const response = await post(harness.url, INITIALIZE);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32603 }, id: 1 });
    expect(harness.manager.size).toBe(0);
    expect(readdirSync(harness.sessionsDir)).toEqual([]);
    expect(harness.entries().find((entry) => entry.message === "cannot start REA")).toMatchObject({
      level: "error",
      reason: "ENOENT",
    });
  });

  it("answers 502 when REA exits before completing initialization, and logs what it said", async () => {
    const harness = await startHarness({ flags: ["--fail-start"] });
    const response = await post(harness.url, INITIALIZE);
    expect(response.status).toBe(502);
    expect(harness.manager.size).toBe(0);
    expect(readdirSync(harness.sessionsDir)).toEqual([]);
    const entries = harness.entries();
    expect(entries.find((entry) => entry.message === "REA did not complete initialization")).toMatchObject({ level: "warn" });
    expect(entries.some((entry) => entry.line === "fake-rea: refusing to start")).toBe(true);
  });

  it("answers 502 when REA does not answer initialize in time, and stops that REA", async () => {
    const harness = await startHarness({ flags: ["--startup-delay-ms=5000"], initializeTimeoutMs: 300 });
    const began = Date.now();
    const response = await post(harness.url, INITIALIZE);
    expect(response.status).toBe(502);
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(harness.manager.size).toBe(0);
    const pid = harness.entries().find((entry) => entry.message === "REA did not complete initialization")?.pid;
    expect(typeof pid).toBe("number");
    expect(alive(pid as number)).toBe(false);
  });

  it("does not leak detail about the failure in the response", async () => {
    const harness = await startHarness({ launch: { command: "/nonexistent/rea-binary", args: [], env: {} } });
    const body = await (await post(harness.url, INITIALIZE)).text();
    expect(body).not.toContain("ENOENT");
    expect(body).not.toContain("nonexistent");
  });
});

describe("a working directory that cannot be created", () => {
  it("answers 500, starts no REA process, registers no session, and logs it", async () => {
    // A path below a regular file can never be created.
    const parent = tempDir();
    const blocker = join(parent, "a-file");
    writeFileSync(blocker, "x");
    const harness = await startHarness({ sessionsDir: join(blocker, "sessions") });
    const response = await post(harness.url, INITIALIZE);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: -32603 }, id: 1 });
    expect(harness.manager.spawnAttempts).toBe(0);
    expect(harness.manager.size).toBe(0);
    expect(harness.entries().find((entry) => entry.message === "cannot create the session directory")).toMatchObject({
      level: "error",
      reason: "ENOTDIR",
    });
  });
});

describe("requests that do not belong to a session", () => {
  it("rejects a POST with no session header that is not initialize, with 400", async () => {
    const harness = await startHarness();
    const response = await post(harness.url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(400);
    expect(harness.manager.spawnAttempts).toBe(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const harness = await startHarness();
    expect((await post(harness.url, "{ not json")).status).toBe(400);
  });

  it("answers an unknown session id with an empty 404, on every method", async () => {
    const harness = await startHarness();
    const headers = { "mcp-session-id": "no-such-session", "mcp-protocol-version": "2025-06-18" };
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await fetch(harness.url, {
        method,
        headers: { "x-api-key": HARNESS_KEY, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) } : {}),
      });
      expect(response.status, method).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  it("answers GET and DELETE without a session header with 400", async () => {
    const harness = await startHarness();
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(harness.url, { method, headers: { "x-api-key": HARNESS_KEY, accept: "text/event-stream" } });
      expect(response.status, method).toBe(400);
    }
  });

  it("rejects a body over the limit with 413 and starts nothing", async () => {
    const harness = await startHarness({ maxBodyBytes: 1_000 });
    const big = { ...INITIALIZE, params: { ...INITIALIZE.params, padding: "x".repeat(5_000) } };
    expect((await post(harness.url, big)).status).toBe(413);
    expect(harness.manager.spawnAttempts).toBe(0);
  });
});
