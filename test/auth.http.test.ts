import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyVerifier, type KeyVerifier } from "../src/auth.js";
import { createFailureLimiter, type FailureLimiter } from "../src/http/ratelimit.js";
import { createGatewayServer, listen, shutdown, type McpHandler } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import { randomKey } from "./helpers/keys.js";

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];
const limiters: FailureLimiter[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => shutdown(server)));
  for (const limiter of limiters.splice(0)) limiter.close();
});

const [KEY, ROTATED_KEY] = [randomKey(), randomKey(48)];

/** A gateway whose clock, trust setting and MCP handler the test controls. */
const start = async (options: { trustProxy?: boolean; mcp?: McpHandler } = {}) => {
  const lines: string[] = [];
  let time = 1_000_000;
  const real = createKeyVerifier([KEY, ROTATED_KEY]);
  const evaluated = { count: 0 };
  const verifier: KeyVerifier = {
    verify: (presented) => {
      evaluated.count += 1;
      return real.verify(presented);
    },
  };
  const limiter = createFailureLimiter({ now: () => time });
  limiters.push(limiter);
  const reached = { count: 0 };
  const mcp: McpHandler =
    options.mcp ??
    ((_req, res) => {
      reached.count += 1;
      res.writeHead(204).end();
    });
  const server = createGatewayServer({
    logger: createLogger("debug", (line) => lines.push(line)),
    verifier,
    limiter,
    mcp,
    trustProxy: options.trustProxy,
  });
  servers.push(server);
  await listen(server, 0);
  return {
    port: (server.address() as AddressInfo).port,
    lines,
    evaluated,
    reached,
    advance: (ms: number): void => {
      time += ms;
    },
  };
};

const send = (
  port: number,
  method: string,
  headers: Record<string, string | string[]> = {},
  path = "/mcp",
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end();
  });

/** Everything about a reply that must not differ between failure causes (not the Date). */
const shape = (reply: Reply): unknown => ({
  status: reply.status,
  body: reply.body,
  headers: Object.fromEntries(Object.entries(reply.headers).filter(([name]) => name !== "date")),
});

describe("authentication of /mcp", () => {
  it.each(["POST", "GET", "DELETE"])("lets a %s with a correct key through to the handler", async (method) => {
    const { port, reached } = await start();
    expect((await send(port, method, { "x-api-key": KEY })).status).toBe(204);
    expect(reached.count).toBe(1);
  });

  it("accepts either of two configured keys, for rotation", async () => {
    const { port } = await start();
    expect((await send(port, "POST", { "x-api-key": KEY })).status).toBe(204);
    expect((await send(port, "POST", { "x-api-key": ROTATED_KEY })).status).toBe(204);
  });

  it("accepts the header name in any case", async () => {
    const { port } = await start();
    expect((await send(port, "POST", { "X-Api-Key": KEY })).status).toBe(204);
  });

  it.each(["POST", "GET", "DELETE"])("answers a %s with no key with a bare 401, without reaching the handler", async (method) => {
    const { port, reached } = await start();
    const reply = await send(port, method);
    expect(reply.status).toBe(401);
    expect(reply.body).toBe("");
    expect(reached.count).toBe(0);
  });

  it("answers a wrong key exactly as it answers a missing one", async () => {
    const { port, reached } = await start();
    const missing = await send(port, "POST");
    const wrong = await send(port, "POST", { "x-api-key": randomKey() });
    const wrongLength = await send(port, "POST", { "x-api-key": "short" });
    expect(shape(wrong)).toEqual(shape(missing));
    expect(shape(wrongLength)).toEqual(shape(missing));
    expect(reached.count).toBe(0);
  });

  it("refuses a repeated key header", async () => {
    const { port } = await start();
    expect((await send(port, "POST", { "x-api-key": [KEY, KEY] })).status).toBe(401);
  });

  it("does not authenticate /healthz, and checks the method before the key", async () => {
    const { port } = await start();
    expect((await send(port, "GET", {}, "/healthz")).status).toBe(200);
    expect((await send(port, "PUT")).status).toBe(405);
  });
});

describe("authentication comes before any session lookup", () => {
  // Stand-in for the session manager: it looks a session up by header and touches it
  // (the way a live request resets the idle timer).
  const registry = () => {
    const touched: string[] = [];
    const handler: McpHandler = (req, res) => {
      const id = req.headers["mcp-session-id"];
      if (typeof id === "string") touched.push(id);
      res.writeHead(id === "live-session" ? 200 : 404).end();
    };
    return { handler, touched };
  };

  it("answers a wrong key with a live session ID exactly as with an unknown one, and touches nothing", async () => {
    const { handler, touched } = registry();
    const { port } = await start({ mcp: handler });
    const live = await send(port, "POST", { "x-api-key": randomKey(), "mcp-session-id": "live-session" });
    const unknown = await send(port, "POST", { "x-api-key": randomKey(), "mcp-session-id": "no-such-session" });
    const none = await send(port, "POST", { "x-api-key": randomKey() });
    expect(live.status).toBe(401);
    expect(shape(live)).toEqual(shape(unknown));
    expect(shape(live)).toEqual(shape(none));
    expect(touched).toEqual([]);
  });

  it("does reach the session lookup with a correct key", async () => {
    const { handler, touched } = registry();
    const { port } = await start({ mcp: handler });
    expect((await send(port, "POST", { "x-api-key": KEY, "mcp-session-id": "live-session" })).status).toBe(200);
    expect((await send(port, "POST", { "x-api-key": KEY, "mcp-session-id": "no-such-session" })).status).toBe(404);
    expect(touched).toEqual(["live-session", "no-such-session"]);
  });
});

describe("failed-authentication rate limiting", () => {
  const fail = async (port: number, times: number, headers: Record<string, string> = {}): Promise<void> => {
    for (let i = 0; i < times; i += 1) {
      expect((await send(port, "POST", { "x-api-key": randomKey(), ...headers })).status).toBe(401);
    }
  };

  it("answers 429 once a source has failed ten times, even with a correct key", async () => {
    const { port, reached } = await start();
    await fail(port, 10);
    const limited = await send(port, "POST", { "x-api-key": KEY });
    expect(limited.status).toBe(429);
    expect(limited.body).toBe("");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(reached.count).toBe(0);
  });

  it("does not look at the key while limited", async () => {
    const { port, evaluated } = await start();
    await fail(port, 10);
    const before = evaluated.count;
    await send(port, "POST", { "x-api-key": KEY });
    await send(port, "GET", { "x-api-key": randomKey() });
    expect(evaluated.count).toBe(before);
  });

  it("lets the source in again once the window has ended", async () => {
    const { port, advance } = await start();
    await fail(port, 10);
    expect((await send(port, "POST", { "x-api-key": KEY })).status).toBe(429);
    advance(60_000);
    expect((await send(port, "POST", { "x-api-key": KEY })).status).toBe(204);
  });

  it("does not count successful requests", async () => {
    const { port } = await start();
    for (let i = 0; i < 50; i += 1) expect((await send(port, "POST", { "x-api-key": KEY })).status).toBe(204);
    await fail(port, 10);
    expect((await send(port, "POST", { "x-api-key": KEY })).status).toBe(429);
  });

  it("ignores forwarding headers by default, so rotating them does not evade the limit", async () => {
    const { port } = await start();
    for (let i = 0; i < 10; i += 1) {
      await send(port, "POST", { "x-api-key": randomKey(), "cf-connecting-ip": `198.51.100.${i + 1}` });
    }
    expect((await send(port, "POST", { "x-api-key": KEY, "cf-connecting-ip": "198.51.100.200" })).status).toBe(429);
  });

  it("honours CF-Connecting-IP behind a trusted proxy: one source is limited, another is not", async () => {
    const { port } = await start({ trustProxy: true });
    await fail(port, 10, { "cf-connecting-ip": "198.51.100.1" });
    expect((await send(port, "POST", { "x-api-key": KEY, "cf-connecting-ip": "198.51.100.1" })).status).toBe(429);
    expect((await send(port, "POST", { "x-api-key": KEY, "cf-connecting-ip": "198.51.100.2" })).status).toBe(204);
  });

  it("counts each forwarded source separately when the proxy is trusted", async () => {
    const { port } = await start({ trustProxy: true });
    for (let i = 0; i < 15; i += 1) {
      expect((await send(port, "POST", { "x-api-key": randomKey(), "cf-connecting-ip": `203.0.113.${i + 1}` })).status).toBe(401);
    }
  });
});

describe("what a failed authentication logs", () => {
  it("records the event and the source address, and neither the key nor any header", async () => {
    const attempt = randomKey();
    const { port, lines } = await start();
    await send(port, "POST", {
      "x-api-key": attempt,
      authorization: `Bearer ${attempt}`,
      "user-agent": "marker-agent/1.0",
      "x-custom-header": "marker-header-value",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const failed = entries.find((entry) => entry.message === "authentication failed");
    expect(Object.keys(failed ?? {}).sort()).toEqual(["level", "message", "sourceIp", "time"]);
    expect(failed).toMatchObject({ level: "warn" });
    for (const needle of [attempt, "marker-agent", "marker-header-value", "x-api-key", "authorization"]) {
      expect(lines.join("")).not.toContain(needle);
    }
  });

  it("does not log the key of a rate-limited request either", async () => {
    const { port, lines } = await start();
    for (let i = 0; i < 10; i += 1) await send(port, "POST", { "x-api-key": randomKey() });
    await send(port, "POST", { "x-api-key": KEY });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines.join("")).not.toContain(KEY);
  });
});
