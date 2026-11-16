// Receiving an upload (spec: file-transfer, "Upload endpoint", "Uploads are streamed, counted and hashed",
// "Upload hash check", "Upload commit", "A failed upload leaves nothing behind"; design D7).
//
// The request body is read chunk by chunk and written straight to a temporary file in the inbox, counted and
// hashed on the way; it is never held in memory whole. The file takes its real name only when the whole body has
// arrived and checked out. Whatever goes wrong, the temporary file is removed and the ticket is marked failed.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../logger.js";
import { InboxError, type Inbox, type Incoming } from "./inbox.js";
import type { TicketStore, UploadTicket } from "./tickets.js";

/** How long a body may make no progress before it is given up on. */
export const DEFAULT_STALL_MS = 60_000;

export interface UploadDeps {
  tickets: TicketStore;
  inbox: Inbox;
  logger: Logger;
  /** No-progress limit, injectable for tests. */
  stallMs?: number;
}

/** A JSON answer. The connection is closed after any failure, since the request body may not have been read. */
const respond = (res: ServerResponse, status: number, body: unknown, close: boolean): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...(close ? { Connection: "close" } : {}),
  });
  res.end(text);
};

const errno = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

type Chunk = { done: false; value: Buffer } | { done: true };
type Next = Chunk | { error: unknown } | "stalled";

/** `Content-Length` as a number, undefined when absent, NaN when it is not a plain integer. */
const declaredLength = (req: IncomingMessage): number | undefined => {
  const header = req.headers["content-length"];
  if (header === undefined) return undefined;
  return /^\d{1,16}$/.test(header) ? Number(header) : Number.NaN;
};

export function createUploadHandler(deps: UploadDeps): (ticket: UploadTicket, req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { tickets, inbox, logger } = deps;
  const stallMs = deps.stallMs ?? DEFAULT_STALL_MS;

  return async (ticket, req, res) => {
    const claim = tickets.claim(ticket);
    if (claim === "already-claimed") {
      return respond(res, 409, { code: "conflict", message: "This upload URL has already been used. Ask for a new one with request_upload." }, true);
    }
    if (claim === "expired") {
      return respond(res, 410, { code: "expired", message: "This upload URL has expired. Ask for a new one with request_upload." }, true);
    }

    // From here the ticket is spent, whatever happens.
    let incoming: Incoming | undefined;
    const fail = async (status: number, code: string, message: string, answer = true): Promise<void> => {
      await incoming?.abort();
      tickets.fail(ticket, code, message);
      logger.warn("upload failed", { ticket: ticket.id, bytes: ticket.transferred, reason: code });
      if (answer && !res.writableEnded && !res.destroyed) respond(res, status, { code, message }, true);
      else res.destroy();
    };

    const declared = declaredLength(req);
    if (declared !== undefined && Number.isNaN(declared)) return fail(400, "bad_request", "The Content-Length header is not valid.");
    if (declared !== undefined && declared > ticket.maxBytes) {
      return fail(413, "too_large", `The file is larger than the ${ticket.maxBytes} bytes this upload URL allows.`);
    }

    try {
      incoming = await inbox.begin();
    } catch (error) {
      const full = errno(error) === "ENOSPC";
      return fail(full ? 507 : 500, full ? "disk_full" : "io_error", full ? "The server's disk is full." : "The server could not start receiving the file.");
    }

    logger.info("upload started", { ticket: ticket.id });
    const hash = createHash("sha256");
    let received = 0;
    const iterator = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;

    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), stallMs);
      });
      const next: Next = await Promise.race([
        iterator.next().then((value): Chunk => value as Chunk, (error: unknown) => ({ error })),
        stalled,
      ]);
      clearTimeout(timer);

      if (next === "stalled") {
        void iterator.return?.().catch(() => undefined);
        return fail(408, "stalled", "The upload stopped sending data and was given up on.");
      }
      if ("error" in next) {
        // The client went away mid-body: nobody is left to answer.
        return fail(0, "interrupted", "The upload was interrupted before it finished.", false);
      }
      if (next.done) break;

      received += next.value.length;
      if (received > ticket.maxBytes) {
        void iterator.return?.().catch(() => undefined);
        return fail(413, "too_large", `The file is larger than the ${ticket.maxBytes} bytes this upload URL allows.`);
      }
      hash.update(next.value);
      try {
        await incoming.write(next.value);
      } catch (error) {
        void iterator.return?.().catch(() => undefined);
        const full = errno(error) === "ENOSPC";
        return fail(full ? 507 : 500, full ? "disk_full" : "io_error", full ? "The server's disk is full." : "The server could not write the file.");
      }
      tickets.progress(ticket, received);
    }

    const digest = hash.digest("hex");
    if (ticket.expectSha256 !== undefined && ticket.expectSha256 !== digest) {
      return fail(422, "sha_mismatch", "The uploaded bytes do not have the SHA-256 that was expected. Nothing was saved.");
    }

    try {
      await incoming.commit(ticket.name, ticket.overwrite);
    } catch (error) {
      if (error instanceof InboxError) {
        const code = error.failure === "exists" ? "conflict" : error.failure;
        return fail(409, code, error.message);
      }
      const full = errno(error) === "ENOSPC";
      return fail(full ? 507 : 500, full ? "disk_full" : "io_error", full ? "The server's disk is full." : "The server could not save the file.");
    }

    tickets.complete(ticket, received, digest);
    logger.info("upload complete", { ticket: ticket.id, bytes: received });
    respond(res, 200, { ok: true, upload_id: ticket.id, name: ticket.name, path: inbox.pathOf(ticket.name), size: received, sha256: digest }, false);
  };
}
