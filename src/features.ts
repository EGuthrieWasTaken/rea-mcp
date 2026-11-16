// The file-transfer and result-paging features, assembled (specs: file-transfer, result-paging). One place builds the ticket
// store, the inbox, the result store, the HTTP handlers and the gateway's own tools, so that the real gateway and the tests
// wire them identically.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createSessionGateway, type SessionGateway } from "./gateway-tools/index.js";
import type { TransferRoutes } from "./http/server.js";
import type { Logger } from "./logger.js";
import { ResultStore } from "./results/store.js";
import { createDownloadHandler } from "./transfer/download.js";
import { Inbox } from "./transfer/inbox.js";
import { TicketStore } from "./transfer/tickets.js";
import { createUploadHandler } from "./transfer/upload.js";

export interface FeatureOptions {
  logger: Logger;
  /** /work in the image. The inbox is `<workDir>/inbox` and stored results are under `<workDir>/results`. */
  workDir: string;
  publicBaseUrl: string | undefined;
  trustProxy: boolean;
  maxUploadBytes: number;
  inboxMaxBytes: number;
  ticketTtlSec: number;
  /** RESULT_INLINE_LIMIT_CHARS */
  resultInlineLimit: number;
  /** SESSION_IDLE_TIMEOUT_SEC: the messages say how long a stored result lives. */
  sessionIdleTimeoutSec: number;
  /** Test hooks. */
  stallMs?: number;
  sessionStoreLimitBytes?: number;
  now?: () => number;
}

export interface Features {
  readonly gateway: SessionGateway;
  readonly routes: TransferRoutes;
  readonly tickets: TicketStore;
  readonly inbox: Inbox;
  readonly results: ResultStore;
  readonly inboxDir: string;
  readonly resultsDir: string;
}

/**
 * Create the directories, remove what an earlier run left in them (temporary upload files, stored results), and build
 * everything. Rejects when a directory cannot be used, so the caller can say so and stop.
 */
export async function createFeatures(options: FeatureOptions): Promise<Features> {
  const inboxDir = join(options.workDir, "inbox");
  const resultsDir = join(options.workDir, "results");

  await mkdir(inboxDir, { recursive: true, mode: 0o750 });
  const inbox = new Inbox(inboxDir);
  const swept = await inbox.sweepTemporary();
  if (swept > 0) options.logger.info("removed unfinished uploads left by an earlier run", { count: swept });

  const results = new ResultStore({
    dir: resultsDir,
    ...(options.sessionStoreLimitBytes === undefined ? {} : { sessionLimitBytes: options.sessionStoreLimitBytes }),
  });
  await results.init();

  const tickets = new TicketStore({ ttlMs: options.ticketTtlSec * 1000, ...(options.now === undefined ? {} : { now: options.now }) });

  const gateway = createSessionGateway({
    tickets,
    inbox,
    results,
    logger: options.logger,
    settings: {
      publicBaseUrl: options.publicBaseUrl,
      trustProxy: options.trustProxy,
      maxUploadBytes: options.maxUploadBytes,
      inboxMaxBytes: options.inboxMaxBytes,
      resultInlineLimit: options.resultInlineLimit,
      sessionIdleTimeoutSec: options.sessionIdleTimeoutSec,
    },
  });

  const upload = createUploadHandler({
    tickets,
    inbox,
    logger: options.logger,
    ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }),
  });
  const download = createDownloadHandler({
    tickets,
    logger: options.logger,
    idleTimeoutSec: options.sessionIdleTimeoutSec,
    fileFor: (ticket) => results.get(ticket.sessionId, ticket.resultId)?.file,
  });
  const routes: TransferRoutes = {
    find: (id, secret) => tickets.find(id, secret),
    upload,
    download,
  };

  return { gateway, routes, tickets, inbox, results, inboxDir, resultsDir };
}
