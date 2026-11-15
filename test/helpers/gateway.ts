import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createKeyVerifier } from "../../src/auth.js";
import { createFeatures, type Features } from "../../src/features.js";
import type { SessionGateway } from "../../src/gateway-tools/index.js";
import { createFailureLimiter, type FailureLimiter } from "../../src/http/ratelimit.js";
import { createGatewayServer, listen, shutdown } from "../../src/http/server.js";
import { createLogger } from "../../src/logger.js";
import { childEnvironment, type ReaLaunch } from "../../src/rea/launch.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { randomKey } from "./keys.js";
import { FAKE_REA } from "./paths.js";
import { tempDir } from "./tmp.js";

/** The key every harness gateway accepts. */
export const HARNESS_KEY = randomKey();

export interface HarnessOptions {
  /** Flags for the fake REA (see test/fixtures/fake-rea.ts). */
  flags?: string[];
  /** Replace the launch entirely, for example to point at a command that does not exist. */
  launch?: ReaLaunch;
  sessionsDir?: string;
  initializeTimeoutMs?: number;
  maxBodyBytes?: number;
  keepAliveMs?: number;
  maxSessions?: number;
  /** How long REA gets to exit after its stdin closes (default 5 s). */
  terminationGraceMs?: number;
  /** How long REA gets after SIGTERM before SIGKILL (default 2 s). */
  termSignalWaitMs?: number;
  idleTimeoutMs?: number;
  reapIntervalMs?: number;
  /** Variables the gateway's own environment holds, from which the child env is built. */
  gatewayEnv?: Record<string, string>;
  /** Turn on file transfer and result paging, with these settings (the defaults are the gateway's own). */
  files?: {
    resultInlineLimit?: number;
    publicBaseUrl?: string;
    trustProxy?: boolean;
    maxUploadBytes?: number;
    inboxMaxBytes?: number;
    ticketTtlSec?: number;
    stallMs?: number;
    sessionStoreLimitBytes?: number;
    allowedHosts?: string[];
  };
  /** A hand-made gateway in place of the real one, for tests of the relay alone. */
  gateway?: SessionGateway;
}

export interface Harness {
  readonly url: string;
  /** `http://127.0.0.1:<port>`, where the transfer routes are too. */
  readonly origin: string;
  /** The file-transfer features, when the harness was started with `files`. */
  readonly features: Features | undefined;
  readonly sessionsDir: string;
  readonly manager: SessionManager;
  readonly lines: string[];
  entries(): Record<string, unknown>[];
  close(): Promise<void>;
}

const open: Harness[] = [];

/** A real gateway server in this process, wired to the fake REA. */
export const startHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const lines: string[] = [];
  const logger = createLogger("debug", (line) => lines.push(line));
  const sessionsDir = options.sessionsDir ?? tempDir("rea-mcp-sessions-");
  const launch: ReaLaunch = options.launch ?? {
    command: process.execPath,
    args: [FAKE_REA, ...(options.flags ?? [])],
    env: childEnvironment({ PATH: process.env.PATH, ...options.gatewayEnv }),
  };
  const features =
    options.files === undefined
      ? undefined
      : await createFeatures({
          logger,
          workDir: tempDir("rea-mcp-work-"),
          publicBaseUrl: options.files.publicBaseUrl,
          trustProxy: options.files.trustProxy ?? false,
          maxUploadBytes: options.files.maxUploadBytes ?? 268_435_456,
          inboxMaxBytes: options.files.inboxMaxBytes ?? 4_294_967_296,
          ticketTtlSec: options.files.ticketTtlSec ?? 900,
          resultInlineLimit: options.files.resultInlineLimit ?? 40_000,
          ...(options.files.stallMs === undefined ? {} : { stallMs: options.files.stallMs }),
          ...(options.files.sessionStoreLimitBytes === undefined ? {} : { sessionStoreLimitBytes: options.files.sessionStoreLimitBytes }),
        });
  const manager = new SessionManager({
    logger,
    launch,
    sessionsDir,
    ...(options.gateway !== undefined ? { gateway: options.gateway } : features === undefined ? {} : { gateway: features.gateway }),
    ...(options.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: options.initializeTimeoutMs }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.terminationGraceMs === undefined ? {} : { terminationGraceMs: options.terminationGraceMs }),
    ...(options.termSignalWaitMs === undefined ? {} : { termWaitMs: options.termSignalWaitMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.reapIntervalMs === undefined ? {} : { reapIntervalMs: options.reapIntervalMs }),
  });
  const limiter: FailureLimiter = createFailureLimiter();
  if (features !== undefined) features.tickets.onEnd = (ticket) => manager.touch(ticket.sessionId);
  const server: Server = createGatewayServer({
    logger,
    verifier: createKeyVerifier([HARNESS_KEY]),
    limiter,
    mcp: manager.handler,
    ...(features === undefined ? {} : { transfer: features.routes }),
    ...(options.files?.allowedHosts === undefined ? {} : { allowedHosts: options.files.allowedHosts }),
  });
  await listen(server, 0);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const harness: Harness = {
    url: `${origin}/mcp`,
    origin,
    features,
    sessionsDir,
    manager,
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: async () => {
      await manager.closeAll();
      await shutdown(server);
      limiter.close();
    },
  };
  open.push(harness);
  return harness;
};

export const closeHarnesses = async (): Promise<void> => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
};

/** A real MCP client (the SDK's) connected to the harness gateway. */
export const connectClient = async (
  harness: { url: string },
  headers: Record<string, string> = { "x-api-key": HARNESS_KEY },
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
  const transport = new StreamableHTTPClientTransport(new URL(harness.url), { requestInit: { headers } });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
};

/** The text of the first content item of a tool result. */
export const textOf = (result: unknown): string => {
  const content = (result as { content?: { text?: string }[] }).content;
  return content?.[0]?.text ?? "";
};
