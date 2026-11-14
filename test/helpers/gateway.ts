import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createKeyVerifier } from "../../src/auth.js";
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
  /** Variables the gateway's own environment holds, from which the child env is built. */
  gatewayEnv?: Record<string, string>;
}

export interface Harness {
  readonly url: string;
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
  const manager = new SessionManager({
    logger,
    launch,
    sessionsDir,
    ...(options.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: options.initializeTimeoutMs }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
  });
  const limiter: FailureLimiter = createFailureLimiter();
  const server: Server = createGatewayServer({
    logger,
    verifier: createKeyVerifier([HARNESS_KEY]),
    limiter,
    mcp: manager.handler,
  });
  await listen(server, 0);
  const harness: Harness = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
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
  harness: Harness,
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
