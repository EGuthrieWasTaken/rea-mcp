import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer, listen, shutdown, type McpHandler } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import { randomKey } from "./helpers/keys.js";

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => shutdown(server)));
});

/** Start a gateway server on an ephemeral port, capturing its log lines. */
const start = async (mcp?: McpHandler) => {
  const lines: string[] = [];
  const logger = createLogger("debug", (line) => lines.push(line));
  const server = createGatewayServer({ logger, mcp });
  servers.push(server);
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { port, lines, entries };
};

const send = (port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end();
  });

// Nothing in a response may say what produced it.
const IDENTIFYING = ["server", "x-powered-by", "via", "x-version", "x-request-id"];
const expectAnonymous = (reply: Reply): void => {
  for (const name of IDENTIFYING) expect(reply.headers[name]).toBeUndefined();
};

describe("GET /healthz", () => {
  it("answers 200 with exactly {\"status\":\"ok\"} and no key", async () => {
    const { port } = await start();
    const reply = await send(port, "GET", "/healthz");
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"status":"ok"}');
    expect(reply.headers["content-type"]).toBe("application/json");
    expectAnonymous(reply);
  });

  it("carries no version, framework banner, session count or configuration", async () => {
    const { port } = await start();
    const reply = await send(port, "GET", "/healthz");
    expect(Object.keys(JSON.parse(reply.body) as object)).toEqual(["status"]);
    expect(Object.keys(reply.headers).sort()).toEqual(
      ["cache-control", "connection", "content-length", "content-type", "date", "keep-alive"].filter(
        (name) => name in reply.headers,
      ),
    );
  });

  it("ignores a query string", async () => {
    const { port } = await start();
    expect((await send(port, "GET", "/healthz?probe=1")).status).toBe(200);
  });

  it("answers HEAD with the headers only", async () => {
    const { port } = await start();
    const reply = await send(port, "HEAD", "/healthz");
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("");
    expect(reply.headers["content-length"]).toBe("15");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("rejects %s with 405", async (method) => {
    const { port } = await start();
    const reply = await send(port, method, "/healthz");
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("GET, HEAD");
  });
});

describe("unknown paths", () => {
  it.each(["/", "/other", "/mcp/", "/MCP", "//mcp", "/healthz/", "/healthz/x", "/.env", "/mcp%2f", "/admin"])(
    "answer %s with an empty 404",
    async (path) => {
      const { port } = await start(() => undefined);
      const reply = await send(port, "GET", path);
      expect(reply.status).toBe(404);
      expect(reply.body).toBe("");
      expectAnonymous(reply);
    },
  );
});

describe("/mcp", () => {
  it.each(["POST", "GET", "DELETE"])("hands %s to the MCP handler", async (method) => {
    const seen: string[] = [];
    const { port } = await start((req, res) => {
      seen.push(req.method ?? "");
      res.writeHead(204).end();
    });
    expect((await send(port, method, "/mcp")).status).toBe(204);
    expect(seen).toEqual([method]);
  });

  it("ignores a query string when routing", async () => {
    const { port } = await start((_req, res) => void res.writeHead(204).end());
    expect((await send(port, "POST", "/mcp?x=1")).status).toBe(204);
  });

  it.each(["PUT", "PATCH", "OPTIONS", "HEAD", "PROPFIND"])("answers %s with 405 without calling the handler", async (method) => {
    let called = false;
    const { port } = await start(() => {
      called = true;
    });
    const reply = await send(port, method, "/mcp");
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("POST, GET, DELETE");
    expect(called).toBe(false);
  });

  it("answers 404 while no MCP handler is attached", async () => {
    const { port } = await start();
    expect((await send(port, "POST", "/mcp")).status).toBe(404);
  });

  it("turns a failing handler into a bare 500 and keeps serving", async () => {
    const { port, lines } = await start(() => {
      throw new Error("detail that must not be echoed");
    });
    const reply = await send(port, "POST", "/mcp");
    expect(reply.status).toBe(500);
    expect(reply.body).toBe("");
    expect((await send(port, "GET", "/healthz")).status).toBe(200);
    expect(lines.join("")).not.toContain("detail that must not be echoed");
  });

  it("turns a rejecting async handler into a bare 500", async () => {
    const { port } = await start(() => Promise.reject(new Error("nope")));
    expect((await send(port, "POST", "/mcp")).status).toBe(500);
  });
});

describe("request logging", () => {
  it("logs method, route, status, duration and source address, and nothing else", async () => {
    const { port, entries } = await start((_req, res) => void res.writeHead(204).end());
    await send(port, "POST", "/mcp");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = entries().find((candidate) => candidate.message === "request");
    expect(entry).toMatchObject({ level: "info", method: "POST", path: "/mcp", status: 204 });
    expect(typeof entry?.durationMs).toBe("number");
    expect(String(entry?.sourceIp)).toMatch(/127\.0\.0\.1/);
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ["durationMs", "level", "message", "method", "path", "sourceIp", "status", "time"],
    );
  });

  it("logs health checks only at debug", async () => {
    const { port, entries } = await start();
    await send(port, "GET", "/healthz");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entries().find((candidate) => candidate.path === "/healthz")).toMatchObject({ level: "debug" });
  });

  it("never logs an unknown path, a query string or a header, even at debug", async () => {
    const key = randomKey();
    const { port, lines } = await start((_req, res) => void res.writeHead(204).end());
    await send(port, "GET", `/attacker-chosen-path?token=${key}`, { "x-api-key": key, authorization: `Bearer ${key}` });
    await send(port, "POST", `/mcp?token=${key}`, { "x-api-key": key });
    await send(port, "GET", `/healthz?token=${key}`, { "x-api-key": key });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const output = lines.join("");
    expect(output).not.toContain(key);
    expect(output).not.toContain("attacker-chosen-path");
    expect(output).not.toContain("x-api-key");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ path: "other" });
  });
});
