// The HTTP surface (spec: mcp-http-gateway; design D3). Plain node:http: a handful of
// routes do not justify a framework, and a framework's default banners and request
// logging would work against the no-disclosure rules.
//
// Pipeline for /mcp, in order:
//   method check -> Host allowlist -> rate limit -> authentication -> MCP handler
// Authentication comes before the MCP handler, which is where sessions are looked
// up, so an invalid key can neither probe for session IDs nor touch a session.
//
// /upload/<id>/<secret> and /download/<id>/<secret> (spec: file-transfer) carry no API key: the
// secret in the path is the authorization. They run the same pipeline with the ticket in place
// of the key: method check -> Host allowlist -> rate limit -> ticket lookup -> handler. An unknown
// id and a wrong secret are the same bare 404 and count as the same failure.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { KeyVerifier } from "../auth.js";
import type { Logger } from "../logger.js";
import { createHostCheck } from "./hosts.js";
import type { FailureLimiter } from "./ratelimit.js";
import { sourceIp } from "./source.js";
import type { DownloadTicket, Ticket, UploadTicket } from "../transfer/tickets.js";

/** Handles a /mcp request that has passed every pre-MCP check. */
export type McpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** What the transfer routes need from the file-transfer module. */
export interface TransferRoutes {
  /** The ticket this id and secret name, or undefined. An unknown id and a wrong secret must be indistinguishable. */
  find(id: string, secret: string): Ticket | undefined;
  /** Receive an upload for a ticket that was found. The handler claims it and writes the whole response. */
  upload(ticket: UploadTicket, req: IncomingMessage, res: ServerResponse): void | Promise<void>;
  /** Send a stored result for a ticket that was found. The handler claims it and writes the whole response. */
  download(ticket: DownloadTicket, req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}

export interface GatewayServerOptions {
  logger: Logger;
  /** Decides whether a presented API key is accepted. Required: /mcp is never open. */
  verifier: KeyVerifier;
  /** Counts failed attempts and refuses sources that fail too often. */
  limiter: FailureLimiter;
  /** Absent until the MCP endpoint is attached; /mcp then answers 404. */
  mcp?: McpHandler | undefined;
  /** Absent when file transfer is not attached; the transfer routes then answer 404. */
  transfer?: TransferRoutes | undefined;
  /** ALLOWED_HOSTS: hosts /mcp may be reached by. Empty or absent means no restriction. */
  allowedHosts?: readonly string[] | undefined;
  /** TRUST_PROXY: take the client address from CF-Connecting-IP / X-Forwarded-For. */
  trustProxy?: boolean | undefined;
}

const MCP_METHODS = ["POST", "GET", "DELETE"] as const;
const HEALTH_METHODS = ["GET", "HEAD"] as const;
const UPLOAD_METHODS = ["PUT", "POST"] as const;
const DOWNLOAD_METHODS = ["GET"] as const;

const HEALTH_BODY = JSON.stringify({ status: "ok" });

/**
 * What a request is logged as. Unknown paths are never logged, only counted as "other", and a transfer
 * path is logged only as its label: the path holds the ticket's secret.
 */
type Route = "/mcp" | "/healthz" | "/upload" | "/download" | "other";

interface Matched {
  readonly route: Route;
  readonly id?: string;
  readonly secret?: string;
}

// Exactly an id and a secret after the prefix, nothing more. The lengths only keep absurd paths out of the lookup.
const TRANSFER_PATH = /^\/(upload|download)\/([^/]{1,100})\/([^/]{1,200})$/;

const match = (url: string | undefined): Matched => {
  // Exact match on the path alone: no trailing slash, no case folding, no query.
  const path = (url ?? "").split("?", 1)[0] ?? "";
  if (path === "/mcp") return { route: "/mcp" };
  if (path === "/healthz") return { route: "/healthz" };
  const transfer = TRANSFER_PATH.exec(path);
  if (transfer !== null) {
    return { route: transfer[1] === "upload" ? "/upload" : "/download", id: transfer[2], secret: transfer[3] };
  }
  return { route: "other" };
};

const reply = (res: ServerResponse, status: number, headers: Record<string, string | number> = {}): void => {
  res.writeHead(status, { "Content-Length": 0, ...headers });
  res.end();
};

/** A refusal of a transfer request: the body (which may be large) is not read, so the connection is closed after it. */
const refuse = (res: ServerResponse, status: number, headers: Record<string, string | number> = {}): void =>
  reply(res, status, { Connection: "close", ...headers });

export function createGatewayServer(options: GatewayServerOptions): Server {
  const { logger } = options;
  const hosts = createHostCheck(options.allowedHosts ?? []);
  const trustProxy = options.trustProxy ?? false;

  const server = createServer((req, res) => {
    const started = performance.now();
    const { route, id, secret } = match(req.url);
    const method = req.method ?? "";
    const source = sourceIp(req, trustProxy);

    // One log entry per request, written when the response is over. It carries
    // only allowlisted fields: never a header, a query string or a request body.
    res.once("close", () => {
      const level = route === "/healthz" ? "debug" : "info";
      logger[level]("request", {
        method,
        path: route,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
        sourceIp: source,
      });
    });

    if (route === "/healthz") {
      if (!(HEALTH_METHODS as readonly string[]).includes(method)) {
        reply(res, 405, { Allow: HEALTH_METHODS.join(", ") });
        return;
      }
      // Exactly {"status":"ok"} and nothing that identifies the service.
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(HEALTH_BODY),
        "Cache-Control": "no-store",
      });
      res.end(method === "HEAD" ? undefined : HEALTH_BODY);
      return;
    }

    if (route === "/mcp") {
      if (!(MCP_METHODS as readonly string[]).includes(method)) {
        reply(res, 405, { Allow: MCP_METHODS.join(", ") });
        return;
      }
      // /healthz is exempt from this check so in-container health checks work.
      if (!hosts.allows(req.headers.host)) {
        reply(res, 403);
        return;
      }

      // A source that keeps failing is refused without its key being looked at.
      const wait = options.limiter.retryAfter(source);
      if (wait !== undefined) {
        reply(res, 429, { "Retry-After": wait });
        return;
      }
      // The same bare 401 whether the key is missing, wrong, or sent with a live,
      // unknown or absent session ID: nothing here depends on a session.
      if (!options.verifier.verify(req.headers["x-api-key"])) {
        options.limiter.recordFailure(source);
        logger.warn("authentication failed", { sourceIp: source });
        reply(res, 401);
        return;
      }
      const mcp = options.mcp;
      if (mcp === undefined) {
        reply(res, 404);
        return;
      }
      void Promise.resolve()
        .then(() => mcp(req, res))
        .catch((error: unknown) => {
          // Name the failure, never its message: it could echo request content.
          logger.error("request handler failed", {
            path: route,
            reason: error instanceof Error ? error.name : "unknown error",
          });
          if (!res.headersSent) reply(res, 500);
          else res.destroy();
        });
      return;
    }

    if ((route === "/upload" || route === "/download") && id !== undefined && secret !== undefined) {
      const allowed = route === "/upload" ? UPLOAD_METHODS : DOWNLOAD_METHODS;
      if (!(allowed as readonly string[]).includes(method)) {
        refuse(res, 405, { Allow: allowed.join(", ") });
        return;
      }
      if (!hosts.allows(req.headers.host)) {
        refuse(res, 403);
        return;
      }
      const wait = options.limiter.retryAfter(source);
      if (wait !== undefined) {
        refuse(res, 429, { "Retry-After": wait });
        return;
      }
      const transfer = options.transfer;
      if (transfer === undefined) {
        refuse(res, 404);
        return;
      }
      // The same bare 404 for an id nobody holds, a wrong secret and a ticket of the other kind. Each
      // counts against the source like a wrong API key does, so guessing is limited the same way.
      const ticket = transfer.find(id, secret);
      if (ticket === undefined || ticket.kind !== (route === "/upload" ? "upload" : "download")) {
        options.limiter.recordFailure(source);
        logger.warn("transfer refused", { path: route, sourceIp: source });
        refuse(res, 404);
        return;
      }
      void Promise.resolve()
        .then(() => (ticket.kind === "upload" ? transfer.upload(ticket, req, res) : transfer.download(ticket, req, res)))
        .catch((error: unknown) => {
          logger.error("request handler failed", { path: route, reason: error instanceof Error ? error.name : "unknown error" });
          if (!res.headersSent) reply(res, 500);
          else res.destroy();
        });
      return;
    }

    // Anything else: no detail about the service.
    reply(res, 404);
  });

  // Outlast the idle timeouts of the proxies in front (a tunnel or load balancer
  // typically holds idle upstream connections for 60 s), so they close first.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // Node's default limit on receiving a whole request is 300 s, which would cut a large upload from a
  // slow uplink. Turn it off (the header limit above still applies) and let the transfer handler stop a
  // body that makes no progress. /mcp checks the key before it reads a body, so only an authenticated
  // caller can hold one open. See docs/DESIGN.md 18.2.
  server.requestTimeout = 0;
  return server;
}

/** Listen on all interfaces; rejects with the listen error (for example EADDRINUSE). */
export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ port }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Stop accepting connections at once, run `drain` (which ends the sessions that hold
 * streams open), then end every remaining connection. Resolves when the server is closed.
 */
export async function shutdown(server: Server, drain?: () => Promise<void>): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await drain?.();
  server.closeAllConnections();
  await closed;
}
