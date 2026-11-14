import { connect, createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { randomKey } from "./helpers/keys.js";
import { freePort, GatewayProcess } from "./helpers/process.js";
import { tempDir } from "./helpers/tmp.js";

const running: GatewayProcess[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.kill()));
});

const start = (env: Record<string, string>): GatewayProcess => {
  const gateway = GatewayProcess.start({ REA_MCP_WORK_DIR: tempDir(), ...env });
  running.push(gateway);
  return gateway;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const connects = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

describe("the running gateway process", () => {
  it("serves /healthz, writes only JSON log lines, and exits 0 on SIGTERM", async () => {
    const [port, key] = [await freePort(), randomKey()];
    const gateway = start({ REA_MCP_API_KEY: key, PORT: String(port) });
    await gateway.waitForLog((line) => line.message === "listening");

    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ok"}');

    expect(await gateway.stop("SIGTERM")).toEqual({ code: 0, signal: null });
    expect(gateway.invalid).toEqual([]);
    expect(gateway.lines.length).toBeGreaterThan(0);
    for (const line of gateway.lines) {
      expect(typeof line.time).toBe("string");
      expect(typeof line.level).toBe("string");
      expect(typeof line.message).toBe("string");
    }
    expect(JSON.stringify(gateway.lines)).not.toContain(key);
    expect(gateway.stderr).toBe("");
  });

  it("requires the API key on /mcp and rate-limits failures, in the real process", async () => {
    const [port, key] = [await freePort(), randomKey()];
    const gateway = start({ REA_MCP_API_KEY: key, PORT: String(port) });
    await gateway.waitForLog((line) => line.message === "listening");
    const call = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers });

    expect((await call({})).status).toBe(401);
    expect((await call({ "x-api-key": randomKey() })).status).toBe(401);
    // Authenticated: the request reaches the MCP handler, which rejects the empty body (not a 401).
    expect((await call({ "x-api-key": key })).status).toBe(400);

    for (let i = 0; i < 8; i += 1) await call({ "x-api-key": randomKey() });
    const limited = await call({ "x-api-key": key });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(gateway.lines)).not.toContain(key);
  });

  it("stops the real REA of every live session, then exits 0 well inside the 10 second budget", async () => {
    const [port, key] = [await freePort(), randomKey()];
    const gateway = start({ REA_MCP_API_KEY: key, PORT: String(port) });
    await gateway.waitForLog((line) => line.message === "listening");

    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shutdown-test", version: "0" } },
    };
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).not.toBeNull();
    await response.text();

    const started = gateway.lines.find((line) => line.message === "session started");
    const pid = started?.pid;
    expect(typeof pid).toBe("number");
    expect(alive(pid as number)).toBe(true);

    const began = Date.now();
    expect(await gateway.stop("SIGTERM")).toEqual({ code: 0, signal: null });
    expect(Date.now() - began).toBeLessThan(8_000);
    await expect.poll(() => alive(pid as number), { timeout: 5_000 }).toBe(false);
    expect(gateway.lines.map((line) => line.message)).toEqual(expect.arrayContaining(["shutting down", "REA stopped"]));
    expect(JSON.stringify(gateway.lines)).not.toContain(key);
  }, 30_000);

  it("exits 0 on SIGINT too", async () => {
    const [port, key] = [await freePort(), randomKey()];
    const gateway = start({ REA_MCP_API_KEY: key, PORT: String(port) });
    await gateway.waitForLog((line) => line.message === "listening");
    expect(await gateway.stop("SIGINT")).toEqual({ code: 0, signal: null });
  });

  it("does not open the port when startup is refused for want of a key", async () => {
    const port = await freePort();
    const gateway = start({ PORT: String(port) });
    expect((await gateway.exited).code).toBe(1);
    expect(gateway.lines.map((line) => line.message)).not.toContain("listening");
    expect(await connects(port)).toBe(false);
  });

  it("exits non-zero and says why when the port is already taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const gateway = start({ REA_MCP_API_KEY: randomKey(), PORT: String(port) });
      expect((await gateway.exited).code).toBe(1);
      expect(gateway.lines.at(-1)).toMatchObject({ level: "error", message: "cannot listen", reason: "EADDRINUSE", port });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
