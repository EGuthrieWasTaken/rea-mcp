import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyVerifier } from "../src/auth.js";
import { createFailureLimiter, type FailureLimiter } from "../src/http/ratelimit.js";
import { createGatewayServer, listen, shutdown, type TransferRoutes } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import { TicketStore } from "../src/transfer/tickets.js";
import { randomKey } from "./helpers/keys.js";

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const TEST_KEY = randomKey();

const servers: Server[] = [];
const limiters: FailureLimiter[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => shutdown(server)));
  for (const limiter of limiters.splice(0)) limiter.close();
});

/** A server whose transfer handlers just say which ticket they were given. */
const start = async (options: { allowedHosts?: string[]; trustProxy?: boolean; withTransfer?: boolean } = {}) => {
  const lines: string[] = [];
  const logger = createLogger("debug", (line) => lines.push(line));
  const limiter = createFailureLimiter();
  limiters.push(limiter);
  const store = new TicketStore({ ttlMs: 900_000 });
  const handled: string[] = [];
  const transfer: TransferRoutes = {
    find: (id, secret) => store.find(id, secret),
    upload: (ticket, _req, res) => {
      handled.push(`upload ${ticket.id}`);
      res.writeHead(200, { "Content-Type": "text/plain" }).end("uploaded");
    },
    download: (ticket, _req, res) => {
      handled.push(`download ${ticket.id}`);
      res.writeHead(200, { "Content-Type": "text/plain" }).end("downloaded");
    },
  };
  const server = createGatewayServer({
    logger,
    verifier: createKeyVerifier([TEST_KEY]),
    limiter,
    mcp: (_req, res) => void res.writeHead(200).end("mcp"),
    ...(options.withTransfer === false ? {} : { transfer }),
    allowedHosts: options.allowedHosts,
    trustProxy: options.trustProxy,
  });
  servers.push(server);
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  const up = store.createUpload({ sessionId: "s", name: "a.bin", overwrite: false, maxBytes: 100, expectSha256: undefined });
  const down = store.createDownload({ sessionId: "s", resultId: "r_1", filename: "r_1.txt", totalBytes: 5, sha256: "00".repeat(32) });
  return { port, server, lines, handled, store, up, down, entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
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

/** A response without the per-request noise, for comparing two responses. */
const shape = (reply: Reply) => {
  const headers = Object.fromEntries(Object.entries(reply.headers).filter(([name]) => name !== "date"));
  return { status: reply.status, headers, body: reply.body };
};

const uploadPath = (t: { up: { ticket: { id: string }; secret: string } }): string => `/upload/${t.up.ticket.id}/${t.up.secret}`;
const downloadPath = (t: { down: { ticket: { id: string }; secret: string } }): string =>
  `/download/${t.down.ticket.id}/${t.down.secret}`;

describe("transfer routes: reaching the handler", () => {
  it("passes a correct upload ticket to the upload handler, with PUT or POST and no API key", async () => {
    const t = await start();
    for (const method of ["PUT", "POST"]) {
      const reply = await send(t.port, method, uploadPath(t));
      expect(reply).toMatchObject({ status: 200, body: "uploaded" });
    }
    expect(t.handled).toEqual([`upload ${t.up.ticket.id}`, `upload ${t.up.ticket.id}`]);
  });

  it("passes a correct download ticket to the download handler with GET", async () => {
    const t = await start();
    expect(await send(t.port, "GET", downloadPath(t))).toMatchObject({ status: 200, body: "downloaded" });
    expect(t.handled).toEqual([`download ${t.down.ticket.id}`]);
  });

  it("ignores a query string when matching, and never gives it to the lookup", async () => {
    const t = await start();
    expect((await send(t.port, "PUT", `${uploadPath(t)}?x=1`)).status).toBe(200);
  });

  it("does not count correct tickets against the failure limit", async () => {
    const t = await start();
    for (let i = 0; i < 40; i += 1) expect((await send(t.port, "PUT", uploadPath(t))).status).toBe(200);
  });
});

describe("transfer routes: refusing", () => {
  it.each([
    "/upload",
    "/upload/",
    "/upload/u_only-an-id",
    "/upload/u_id/secret/extra",
    "/upload//secret",
    "/download",
    "/download/",
    "/download/d_only-an-id",
    "/download/d_id/secret/extra",
    "/uploads/u_id/secret",
    "/Upload/u_id/secret",
    "/x/upload/u_id/secret",
  ])("answers a malformed path %s with a bare 404 and records no failure", async (path) => {
    const t = await start();
    const reply = await send(t.port, "PUT", path);
    expect(reply.status).toBe(404);
    expect(reply.body).toBe("");
    // Nothing was counted: a long run of such requests does not lock the source out.
    for (let i = 0; i < 25; i += 1) await send(t.port, "PUT", path);
    expect((await send(t.port, "PUT", uploadPath(t))).status).toBe(200);
  });

  it("answers the wrong method with 405 and an Allow header, without claiming or counting anything", async () => {
    const t = await start();
    const get = await send(t.port, "GET", uploadPath(t));
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("PUT, POST");
    const put = await send(t.port, "PUT", downloadPath(t));
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe("GET");
    expect((await send(t.port, "DELETE", uploadPath(t))).status).toBe(405);
    expect(t.handled).toEqual([]);
    expect(t.up.ticket.state).toBe("pending");
  });

  it("answers a disallowed Host with 403 even for a live ticket, and does not claim it", async () => {
    const t = await start({ allowedHosts: ["rea.example"] });
    expect((await send(t.port, "PUT", uploadPath(t), { Host: "other.example" })).status).toBe(403);
    expect((await send(t.port, "GET", downloadPath(t), { Host: "other.example" })).status).toBe(403);
    expect(t.handled).toEqual([]);
    expect(t.up.ticket.state).toBe("pending");
    expect((await send(t.port, "PUT", uploadPath(t), { Host: "rea.example" })).status).toBe(200);
  });

  it("answers an unknown id and a wrong secret with the same bare 404", async () => {
    const t = await start();
    const unknown = await send(t.port, "PUT", `/upload/u_${"x".repeat(22)}/${t.up.secret}`);
    const wrong = await send(t.port, "PUT", `/upload/${t.up.ticket.id}/${"y".repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe("");
    expect(shape(unknown)).toEqual(shape(wrong));
  });

  it("treats a ticket of the other kind as unknown", async () => {
    const t = await start();
    const upload = await send(t.port, "PUT", `/upload/${t.down.ticket.id}/${t.down.secret}`);
    const download = await send(t.port, "GET", `/download/${t.up.ticket.id}/${t.up.secret}`);
    expect(upload.status).toBe(404);
    expect(download.status).toBe(404);
    expect(t.handled).toEqual([]);
  });

  it("answers 404 when file transfer is not attached", async () => {
    const t = await start({ withTransfer: false });
    expect((await send(t.port, "PUT", uploadPath(t))).status).toBe(404);
  });

  it("does not accept an API key as a ticket secret, nor a ticket secret as an API key", async () => {
    const t = await start();
    expect((await send(t.port, "PUT", `/upload/${t.up.ticket.id}/${TEST_KEY}`)).status).toBe(404);
    expect((await send(t.port, "POST", "/mcp", { "x-api-key": t.up.secret })).status).toBe(401);
    expect((await send(t.port, "POST", "/mcp", { "x-api-key": TEST_KEY })).status).toBe(200);
  });
});

describe("transfer routes: guessing is limited like key guessing", () => {
  it("answers 429 after ten failures, even to a request with the right secret, and with Retry-After", async () => {
    const t = await start();
    for (let i = 0; i < 10; i += 1) expect((await send(t.port, "PUT", `/upload/u_wrong${i}/guess`)).status).toBe(404);
    const limited = await send(t.port, "PUT", uploadPath(t));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(t.handled).toEqual([]);
    expect(t.up.ticket.state).toBe("pending");
  });

  it("shares the budget with failed API keys, in both directions", async () => {
    const t = await start();
    for (let i = 0; i < 10; i += 1) await send(t.port, "POST", "/mcp", { "x-api-key": "wrong" });
    expect((await send(t.port, "PUT", uploadPath(t))).status).toBe(429);

    const u = await start();
    for (let i = 0; i < 10; i += 1) await send(u.port, "PUT", `/upload/u_wrong${i}/guess`);
    expect((await send(u.port, "POST", "/mcp", { "x-api-key": TEST_KEY })).status).toBe(429);
  });

  it("attributes failures to the forwarded address only when the proxy is trusted", async () => {
    const t = await start({ trustProxy: true });
    for (let i = 0; i < 10; i += 1) await send(t.port, "PUT", `/upload/u_wrong${i}/guess`, { "CF-Connecting-IP": "203.0.113.9" });
    expect((await send(t.port, "PUT", uploadPath(t), { "CF-Connecting-IP": "203.0.113.9" })).status).toBe(429);
    expect((await send(t.port, "PUT", uploadPath(t), { "CF-Connecting-IP": "203.0.113.10" })).status).toBe(200);
  });
});

describe("transfer routes: logging", () => {
  it("logs the route label and the source, never the path, the id or the secret", async () => {
    const t = await start();
    await send(t.port, "PUT", uploadPath(t));
    await send(t.port, "GET", downloadPath(t));
    await send(t.port, "PUT", `/upload/u_unknown/${"z".repeat(43)}`);
    const text = t.lines.join("");
    for (const needle of [t.up.secret, t.down.secret, t.up.ticket.id, t.down.ticket.id, "u_unknown", "zzzzzzzz"]) {
      expect(text, needle).not.toContain(needle);
    }
    const requests = t.entries().filter((entry) => entry.message === "request");
    expect(requests.map((entry) => entry.path)).toEqual(["/upload", "/download", "/upload"]);
    const refused = t.entries().filter((entry) => entry.message === "transfer refused");
    expect(refused).toHaveLength(1);
    expect(Object.keys(refused[0] as object).sort()).toEqual(["level", "message", "path", "sourceIp", "time"]);
  });
});

describe("the server's own timeouts", () => {
  it("has no whole-request limit, so a slow upload is not cut off, and keeps the header limit", async () => {
    const t = await start();
    expect(t.server.requestTimeout).toBe(0);
    expect(t.server.headersTimeout).toBeGreaterThan(0);
  });
});
