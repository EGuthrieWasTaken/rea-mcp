// The HTTP surface (spec: mcp-http-gateway; design D3). Plain node:http: three
// routes do not justify a framework, and a framework's default banners and request
// logging would work against the no-disclosure rules.
//
// Pipeline for /mcp, in order (later tasks add the middle steps):
//   method check -> Host allowlist -> rate limit -> authentication -> MCP handler
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../logger.js";
import { createHostCheck } from "./hosts.js";

/** Handles a /mcp request that has passed every pre-MCP check. */
export type McpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface GatewayServerOptions {
  logger: Logger;
  /** Absent until the MCP endpoint is attached; /mcp then answers 404. */
  mcp?: McpHandler | undefined;
  /** ALLOWED_HOSTS: hosts /mcp may be reached by. Empty or absent means no restriction. */
  allowedHosts?: readonly string[] | undefined;
}

const MCP_METHODS = ["POST", "GET", "DELETE"] as const;
const HEALTH_METHODS = ["GET", "HEAD"] as const;

const HEALTH_BODY = JSON.stringify({ status: "ok" });

/** What a request is logged as. Unknown paths are never logged, only counted as "other". */
type Route = "/mcp" | "/healthz" | "other";

const routeOf = (url: string | undefined): Route => {
  // Exact match on the path alone: no trailing slash, no case folding, no query.
  const path = (url ?? "").split("?", 1)[0];
  return path === "/mcp" ? "/mcp" : path === "/healthz" ? "/healthz" : "other";
};

const reply = (res: ServerResponse, status: number, headers: Record<string, string | number> = {}): void => {
  res.writeHead(status, { "Content-Length": 0, ...headers });
  res.end();
};

export function createGatewayServer(options: GatewayServerOptions): Server {
  const { logger } = options;
  const hosts = createHostCheck(options.allowedHosts ?? []);

  const server = createServer((req, res) => {
    const started = performance.now();
    const route = routeOf(req.url);
    const method = req.method ?? "";

    // One log entry per request, written when the response is over. It carries
    // only allowlisted fields: never a header, a query string or a request body.
    res.once("close", () => {
      const level = route === "/healthz" ? "debug" : "info";
      logger[level]("request", {
        method,
        path: route,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
        sourceIp: req.socket.remoteAddress ?? "",
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

    // Anything else: no detail about the service.
    reply(res, 404);
  });

  // Outlast the idle timeouts of the proxies in front (a tunnel or load balancer
  // typically holds idle upstream connections for 60 s), so they close first.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
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

/** Stop accepting connections and end open ones; resolves when the server is closed. */
export function shutdown(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
