import { mkdirSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { createKeyVerifier } from "../../src/auth.js";
import { createFailureLimiter, type FailureLimiter } from "../../src/http/ratelimit.js";
import { createGatewayServer, listen, shutdown, type TransferRoutes } from "../../src/http/server.js";
import { createLogger } from "../../src/logger.js";
import { Inbox } from "../../src/transfer/inbox.js";
import { TicketStore, type DownloadTicket, type UploadTicket } from "../../src/transfer/tickets.js";
import { createUploadHandler } from "../../src/transfer/upload.js";
import { randomKey } from "./keys.js";
import { tempDir } from "./tmp.js";

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];
const limiters: FailureLimiter[] = [];
export const closeTransferHarnesses = async (): Promise<void> => {
  await Promise.all(servers.splice(0).map((server) => shutdown(server)));
  for (const limiter of limiters.splice(0)) limiter.close();
};

export interface TransferHarnessOptions {
  stallMs?: number;
  ttlMs?: number;
  /** Extra routes, merged over the upload handler (for the download tests). */
  routes?: (parts: { store: TicketStore; inbox: Inbox }) => Partial<TransferRoutes>;
}

/** A gateway server with the real ticket store, inbox and upload handler on a clock the test controls. */
export const startTransfer = async (options: TransferHarnessOptions = {}) => {
  let time = 1_700_000_000_000;
  const lines: string[] = [];
  const logger = createLogger("debug", (line) => lines.push(line));
  const limiter = createFailureLimiter();
  limiters.push(limiter);
  const store = new TicketStore({ ttlMs: options.ttlMs ?? 900_000, now: () => time });
  const inboxDir = join(tempDir("rea-mcp-inbox-"), "inbox");
  mkdirSync(inboxDir);
  const inbox = new Inbox(inboxDir);
  const upload = createUploadHandler({ tickets: store, inbox, logger, ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }) });
  const extra = options.routes?.({ store, inbox }) ?? {};
  const transfer: TransferRoutes = {
    find: (id, secret) => store.find(id, secret),
    upload,
    download: () => undefined,
    ...extra,
  };
  const server = createGatewayServer({ logger, verifier: createKeyVerifier([randomKey()]), limiter, transfer });
  servers.push(server);
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    store,
    inbox,
    inboxDir,
    lines,
    advance: (ms: number): void => {
      time += ms;
    },
    issue: (spec: Partial<Parameters<TicketStore["createUpload"]>[0]> = {}) => {
      const { ticket, secret } = store.createUpload({
        sessionId: "s1",
        name: "sample.bin",
        overwrite: false,
        maxBytes: 10 * 1024 * 1024,
        expectSha256: undefined,
        ...spec,
      });
      return { ticket, secret, path: `/upload/${ticket.id}/${secret}` } satisfies { ticket: UploadTicket; secret: string; path: string };
    },
    issueDownload: (spec: Partial<Parameters<TicketStore["createDownload"]>[0]> = {}) => {
      const { ticket, secret } = store.createDownload({
        sessionId: "s1",
        resultId: "r_test",
        filename: "r_test.txt",
        totalBytes: 0,
        sha256: "00".repeat(32),
        ...spec,
      });
      return { ticket, secret, path: `/download/${ticket.id}/${secret}` } satisfies { ticket: DownloadTicket; secret: string; path: string };
    },
  };
};

/** Send a request with a body given as chunks, honouring back-pressure, and collect the reply. */
export const send = (
  port: number,
  method: string,
  path: string,
  chunks: Iterable<Buffer> | AsyncIterable<Buffer> = [],
  headers: Record<string, string | number> = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
      res.on("error", reject);
    });
    req.once("error", reject);
    void (async () => {
      try {
        for await (const chunk of chunks) {
          if (!req.write(chunk)) await new Promise<void>((done) => req.once("drain", done));
        }
        req.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("send failed"));
      }
    })();
  });

/** Like `send`, but resolves with the error when the connection is cut instead of rejecting. */
export const sendOrError = async (...args: Parameters<typeof send>): Promise<Reply | Error> =>
  send(...args).catch((error: unknown) => (error instanceof Error ? error : new Error("send failed")));

/**
 * Open a connection, send a request line, headers and `part` of a body that claims to be `length` bytes, then do whatever
 * `then` says. Returns the socket and what the server sends back.
 */
export const partialPut = (port: number, path: string, length: number, part: Buffer) => {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  socket.on("data", (data: Buffer) => (received += data.toString("latin1")));
  socket.on("error", () => undefined);
  socket.write(`PUT ${path} HTTP/1.1\r\nHost: t\r\nContent-Length: ${length}\r\n\r\n`);
  socket.write(part);
  return { socket, received: () => received, closed: new Promise<void>((resolve) => socket.once("close", () => resolve())) };
};
