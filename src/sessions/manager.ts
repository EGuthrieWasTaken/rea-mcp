// Per-session REA child processes and the stdio <-> streamable HTTP relay
// (spec: session-management; design D1, D2, D6, D13).
//
// Each MCP session owns exactly one REA child, started in its own working directory
// /work/sessions/<session-id>, and an SDK streamable HTTP transport towards the
// client. Messages are relayed between the two without being interpreted.
//
// Session start is a handshake done by this module BEFORE the SDK transport sees the
// request: the child is spawned and answers `initialize` first. A child that cannot
// start, or dies or stalls during that exchange, therefore produces a plain HTTP
// error and no session. Only after the child has answered is the session registered,
// and the SDK transport is handed the answer we already hold, so that it writes the
// session header and the response itself.
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpHandler } from "../http/server.js";
import type { Logger } from "../logger.js";
import { ReaChild, TERM_WAIT_MS, type ChildExit } from "../rea/child.js";
import type { ReaLaunch } from "../rea/launch.js";

export interface SessionManagerOptions {
  logger: Logger;
  launch: ReaLaunch;
  /** Each session's working directory is created as <sessionsDir>/<session-id>. */
  sessionsDir: string;
  /** How long REA gets to exit after its stdin closes before it is signalled. Default 5 s; 30 s with checkpointing. */
  terminationGraceMs?: number;
  /** How long REA gets after SIGTERM before SIGKILL. Default 2 s. */
  termWaitMs?: number;
  /** SESSION_IDLE_TIMEOUT_SEC in milliseconds. A session with no activity and nothing in flight this long is ended. Default 900 000. */
  idleTimeoutMs?: number;
  /** How often idle sessions are looked for. Default a tenth of the timeout, between 1 s and 30 s. */
  reapIntervalMs?: number;
  /** MAX_SESSIONS: most sessions live at once, counting those still starting. Default 4. */
  maxSessions?: number;
  /** Retry-After, in seconds, sent when the cap is reached. Default 30. */
  retryAfterSec?: number;
  /** SSE keep-alive interval for the SDK transport. Default 15 s (spec: about 15 s). */
  keepAliveMs?: number;
  /** How long REA may take to answer `initialize`. Default 30 s. */
  initializeTimeoutMs?: number;
  /** Largest request body accepted. Default 16 MiB, REA's own request ceiling. */
  maxBodyBytes?: number;
}

interface Session {
  readonly id: string;
  readonly child: ReaChild;
  readonly transport: StreamableHTTPServerTransport;
  /** Requests the client has sent that REA has not answered yet, each with the progress token it sent, if any. */
  readonly inFlight: Map<RequestId, string | number | undefined>;
  /**
   * progressToken -> the request it belongs to. REA's progress notifications carry only
   * the token, and the SDK puts a notification on a request's stream only when told which
   * request it relates to: without this they would be dropped.
   */
  readonly progressTokens: Map<string | number, RequestId>;
  /** performance.now() of the last request or answer; the idle timer counts from here. */
  lastActivity: number;
  ended: boolean;
}

const errorCode = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown error";

/** A JSON-RPC error body with a generic message: it must never carry detail. */
const jsonError = (
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  id: RequestId | null = null,
  headers: Record<string, string | number> = {},
): void => {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id });
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
};

const notFound = (res: ServerResponse): void => {
  res.writeHead(404, { "Content-Length": 0 });
  res.end();
};

type Body = { kind: "ok"; text: string } | { kind: "too-large" };

const readBody = (req: IncomingMessage, limit: number): Promise<Body> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0; // stop holding it; keep reading so the client is not left hanging
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(tooLarge ? { kind: "too-large" } : { kind: "ok", text: Buffer.concat(chunks).toString("utf8") }));
    req.once("error", reject);
  });

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly options: Required<Omit<SessionManagerOptions, "logger" | "launch" | "sessionsDir">>;
  private readonly logger: Logger;
  private readonly launch: ReaLaunch;
  private readonly sessionsDir: string;
  private attempts = 0;
  /** Sessions whose slot is reserved but which are not registered yet (still starting). */
  private starting = 0;
  private readonly reaper: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(options: SessionManagerOptions) {
    this.logger = options.logger;
    this.launch = options.launch;
    this.sessionsDir = options.sessionsDir;
    this.options = {
      terminationGraceMs: options.terminationGraceMs ?? 5_000,
      termWaitMs: options.termWaitMs ?? TERM_WAIT_MS,
      idleTimeoutMs: options.idleTimeoutMs ?? 900_000,
      reapIntervalMs: 0,
      maxSessions: options.maxSessions ?? 4,
      retryAfterSec: options.retryAfterSec ?? 30,
      keepAliveMs: options.keepAliveMs ?? 15_000,
      initializeTimeoutMs: options.initializeTimeoutMs ?? 30_000,
      maxBodyBytes: options.maxBodyBytes ?? 16 * 1024 * 1024,
    };
    this.options.reapIntervalMs =
      options.reapIntervalMs ?? Math.min(30_000, Math.max(1_000, Math.round(this.options.idleTimeoutMs / 10)));
    // One timer for every session. Unref'd so it never keeps the process alive.
    this.reaper = setInterval(() => this.reapIdle(), this.options.reapIntervalMs);
    this.reaper.unref();
  }

  /** The /mcp handler: call it only for requests that have passed authentication. */
  readonly handler: McpHandler = (req, res) => this.handle(req, res);

  /** Live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** How many REA processes this manager has tried to start. */
  get spawnAttempts(): number {
    return this.attempts;
  }

  /** From now on no new session is started; sessions already live are unaffected until closeAll. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** Stop looking for idle sessions, then end every session, in parallel, stopping its REA process. */
  async closeAll(): Promise<void> {
    this.beginShutdown();
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.values()].map((session) => this.end(session, "gateway shutdown")));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers["mcp-session-id"];
    const session = typeof header === "string" ? this.sessions.get(header) : undefined;

    if (req.method !== "POST") {
      // GET (the standalone SSE stream) and DELETE both need a session.
      if (header === undefined) return jsonError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
      if (session === undefined) return notFound(res);
      // Reaching here means the request was authenticated: only then does it count as
      // activity. (An open GET stream is not activity beyond the request that opened it.)
      session.lastActivity = performance.now();
      return session.transport.handleRequest(req, res);
    }

    const body = await readBody(req, this.options.maxBodyBytes);
    if (body.kind === "too-large") return jsonError(res, 413, -32000, "Payload too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return jsonError(res, 400, -32700, "Parse error");
    }

    if (header === undefined) {
      // Both guards: the first checks the shape of an initialize request, the second that it
      // is a JSON-RPC request with an id, which the handshake needs.
      if (isJSONRPCRequest(parsed) && isInitializeRequest(parsed)) return this.create(req, res, parsed, parsed);
      return jsonError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
    }
    if (session === undefined) return notFound(res);
    session.lastActivity = performance.now();
    return session.transport.handleRequest(req, res, parsed);
  }

  private async create(req: IncomingMessage, res: ServerResponse, request: JSONRPCRequest, parsed: unknown): Promise<void> {
    // Shutting down: refuse, and start nothing.
    if (this.shuttingDown) {
      return jsonError(res, 503, -32000, "Service unavailable", request.id, { "Retry-After": this.options.retryAfterSec });
    }
    // Reserve the slot BEFORE anything asynchronous (and so before spawning): this check
    // and the increment form one synchronous step, so concurrent initialize requests
    // cannot overshoot the cap. Over the cap there is no eviction: the newcomer waits.
    if (this.sessions.size + this.starting >= this.options.maxSessions) {
      this.logger.warn("session cap reached", { count: this.options.maxSessions });
      return jsonError(res, 503, -32000, "Service unavailable", request.id, { "Retry-After": this.options.retryAfterSec });
    }
    this.starting += 1;
    let reserved = true;
    // Called exactly once: when the session is registered (it then counts as live) or
    // when starting it failed.
    const release = (): void => {
      if (!reserved) return;
      reserved = false;
      this.starting -= 1;
    };
    try {
      await this.start(req, res, request, parsed, release);
    } finally {
      release();
    }
  }

  private async start(
    req: IncomingMessage,
    res: ServerResponse,
    request: JSONRPCRequest,
    parsed: unknown,
    release: () => void,
  ): Promise<void> {
    const sessionId = randomUUID();
    const dir = join(this.sessionsDir, sessionId);

    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      this.logger.error("cannot create the session directory", { sessionId, reason: errorCode(error) });
      return jsonError(res, 500, -32603, "Internal error", request.id);
    }

    let child: ReaChild;
    this.attempts += 1;
    try {
      child = await ReaChild.start(this.launch, dir, this.logger, sessionId);
    } catch (error) {
      this.logger.error("cannot start REA", { sessionId, reason: errorCode(error) });
      await rm(dir, { recursive: true, force: true });
      return jsonError(res, 502, -32603, "Bad gateway", request.id);
    }

    let answer: JSONRPCMessage;
    try {
      answer = await this.handshake(child, request);
    } catch (error) {
      this.logger.warn("REA did not complete initialization", {
        sessionId,
        pid: child.pid,
        reason: error instanceof Error ? error.message : "unknown error",
      });
      // The moment diagnostics matter: show what REA said before it failed.
      for (const line of child.stderrLines) {
        this.logger.warn("REA stderr", { sessionId, pid: child.pid, stream: "stderr", line });
      }
      // REA never finished starting, so there is nothing for it to save: no grace.
      await child.terminate(0, this.options.termWaitMs);
      await rm(dir, { recursive: true, force: true });
      return jsonError(res, 502, -32603, "Bad gateway", request.id);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      keepAliveMs: this.options.keepAliveMs,
      // The transport reports a client's DELETE here; look the session up by id.
      onsessionclosed: () => {
        const live = this.sessions.get(sessionId);
        if (live !== undefined) void this.end(live, "deleted by client");
      },
    });
    const session: Session = {
      id: sessionId,
      child,
      transport,
      inFlight: new Map(),
      progressTokens: new Map(),
      lastActivity: performance.now(),
      ended: false,
    };

    // The first message the transport hands us is the initialize request we have
    // already put to REA: answer it with what REA said, and relay everything else.
    let answered = false;
    transport.onmessage = (message) => {
      if (!answered && isInitializeRequest(message)) {
        answered = true;
        this.deliver(session, answer);
        return;
      }
      this.track(session, message);
      this.forward(session, message);
    };
    transport.onclose = () => void this.end(session, "transport closed");
    child.onmessage = (message) => {
      // An answer from REA ends its request, and the idle timer restarts from here.
      if (
        (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
        message.id !== undefined &&
        this.finish(session, message.id)
      ) {
        session.lastActivity = performance.now();
      }
      this.deliver(session, message);
    };
    child.onexit = (exit) => void this.childExited(session, exit);

    this.sessions.set(sessionId, session);
    release(); // now it is counted as a live session, not as one that is starting
    this.logger.info("session started", { sessionId, pid: child.pid });
    try {
      await transport.start();
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      this.logger.error("starting the session's transport failed", {
        sessionId,
        reason: error instanceof Error ? error.name : "unknown error",
      });
      await this.end(session, "transport failed to start");
      if (!res.headersSent) jsonError(res, 500, -32603, "Internal error", request.id);
    }
  }

  /** Put `initialize` to REA and wait for its answer, or for REA to fail or stall. */
  private handshake(child: ReaChild, request: JSONRPCRequest): Promise<JSONRPCMessage> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, message?: JSONRPCMessage): void => {
        clearTimeout(timer);
        child.onmessage = undefined;
        child.onexit = undefined;
        if (error !== undefined) reject(error);
        else if (message !== undefined) resolve(message);
      };
      const timer = setTimeout(() => finish(new Error("initialize timed out")), this.options.initializeTimeoutMs);
      child.onmessage = (message) => {
        if (isJSONRPCResultResponse(message) && message.id === request.id) finish(undefined, message);
        else if (isJSONRPCErrorResponse(message) && message.id === request.id) finish(new Error("REA refused initialize"));
        // Anything else before the answer is dropped.
      };
      child.onexit = (exit) => finish(new Error(`REA exited during initialize (${describeExit(exit)})`));
      try {
        child.send(request);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("could not write to REA"));
      }
    });
  }

  /** A message from REA, towards the client. */
  private deliver(session: Session, message: JSONRPCMessage): void {
    // Progress goes to the stream of the request that asked for it, found by its token.
    // Anything else (logging, list changes) has no request and goes to the standalone stream.
    let related: RequestId | undefined;
    if (isJSONRPCNotification(message) && message.method === "notifications/progress") {
      const token = message.params?.progressToken;
      if (typeof token === "string" || typeof token === "number") related = session.progressTokens.get(token);
    }
    session.transport.send(message, related === undefined ? undefined : { relatedRequestId: related }).catch((error: unknown) => {
      // The client has gone away (its stream is closed): there is nobody to tell.
      this.logger.debug("dropped a message for a closed stream", {
        sessionId: session.id,
        reason: error instanceof Error ? error.name : "unknown error",
      });
    });
  }

  /** Note what a message from the client does to the session's activity and in-flight requests. */
  private track(session: Session, message: JSONRPCMessage): void {
    session.lastActivity = performance.now();
    if (isJSONRPCRequest(message)) {
      const token = message.params?._meta?.progressToken;
      session.inFlight.set(message.id, token);
      if (token !== undefined) session.progressTokens.set(token, message.id);
    } else if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
      // The client has given up on that request and REA need not answer it, so it must
      // not keep the session from being idle forever. The notification itself is still
      // relayed to REA (see forward), which can then stop the work.
      const requestId = message.params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") this.finish(session, requestId);
    }
  }

  /** A request is over (answered or cancelled): forget it and its progress token. */
  private finish(session: Session, id: RequestId): boolean {
    if (!session.inFlight.has(id)) return false;
    const token = session.inFlight.get(id);
    session.inFlight.delete(id);
    if (token !== undefined) session.progressTokens.delete(token);
    return true;
  }

  /** End every session that has had no activity and nothing in flight for the idle timeout. */
  private reapIdle(): void {
    const now = performance.now();
    for (const session of this.sessions.values()) {
      if (session.inFlight.size === 0 && now - session.lastActivity >= this.options.idleTimeoutMs) {
        void this.end(session, "idle");
      }
    }
  }

  /** A message from the client, towards REA. */
  private forward(session: Session, message: JSONRPCMessage): void {
    try {
      session.child.send(message);
    } catch {
      this.logger.warn("REA is not accepting input", { sessionId: session.id, pid: session.child.pid });
      void this.end(session, "REA not accepting input");
    }
  }

  private async childExited(session: Session, exit: ChildExit): Promise<void> {
    if (session.ended) return;
    this.logger.warn("REA exited", {
      sessionId: session.id,
      pid: session.child.pid,
      exitCode: exit.code,
      signal: exit.signal,
    });
    for (const line of session.child.stderrLines) {
      this.logger.warn("REA stderr", { sessionId: session.id, stream: "stderr", line });
    }
    // Every call still waiting for REA gets an error, not silence, before the session goes.
    const pending = [...session.inFlight.keys()];
    session.inFlight.clear();
    session.progressTokens.clear();
    await Promise.allSettled(
      pending.map((id) => session.transport.send({ jsonrpc: "2.0", id, error: { code: -32603, message: "REA exited" } })),
    );
    await this.end(session, "REA exited");
  }

  /** Remove a session and stop everything it owns. Safe to call more than once. */
  private async end(session: Session, reason: string): Promise<void> {
    if (session.ended) return;
    session.ended = true;
    this.sessions.delete(session.id);
    this.logger.info("session ended", { sessionId: session.id, reason });
    await Promise.allSettled([session.transport.close(), this.stopChild(session)]);
  }

  /** The graceful stop of a session's REA: see ReaChild.terminate. */
  private async stopChild(session: Session): Promise<void> {
    const how = await session.child.terminate(this.options.terminationGraceMs, this.options.termWaitMs);
    const exit = session.child.exitStatus;
    this.logger.info("REA stopped", {
      sessionId: session.id,
      pid: session.child.pid,
      reason: how,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
    });
  }
}

const describeExit = (exit: ChildExit): string => (exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal ?? "unknown"}`);
