// Sending a stored result (spec: file-transfer, "Download endpoint"; design D5, D6).
//
// The ticket names a result the gateway stored for one session. The file is opened here, its size compared
// with what the ticket recorded, and streamed with a Content-Length and the SHA-256 computed when the result
// was stored, so the agent can check what it got. A ticket is single use: a failed download needs a new one.
import type { IncomingMessage, ServerResponse } from "node:http";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../logger.js";
import { SESSION_ENDED, type DownloadTicket, type TicketStore } from "./tickets.js";

export interface DownloadDeps {
  tickets: TicketStore;
  logger: Logger;
  /** The path of the stored file for this ticket, or undefined if it is no longer there. */
  fileFor(ticket: DownloadTicket): string | undefined;
}

const respond = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(text);
};

/** A file name that cannot break out of the Content-Disposition header. */
const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "result.txt";

export function createDownloadHandler(deps: DownloadDeps): (ticket: DownloadTicket, req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { tickets, logger } = deps;

  return async (ticket, _req, res) => {
    // Only someone with the right secret gets this far, so saying why the URL stopped working reveals nothing to a guesser.
    if (ticket.state === "failed" && ticket.error?.code === SESSION_ENDED) {
      return respond(res, 410, {
        code: "gone",
        message:
          "The session that made this result has ended, and its stored results were deleted with it (a session ends after a few minutes without a request). Run the analysis again and ask for a new download with request_download.",
      });
    }
    const claim = tickets.claim(ticket);
    if (claim === "already-claimed") {
      return respond(res, 409, { code: "conflict", message: "This download URL has already been used. Ask for a new one with request_download." });
    }
    if (claim === "expired") {
      return respond(res, 410, { code: "expired", message: "This download URL has expired. Ask for a new one with request_download." });
    }

    const fail = (status: number, code: string, message: string): void => {
      tickets.fail(ticket, code, message);
      logger.warn("download failed", { ticket: ticket.id, bytes: ticket.transferred, reason: code });
      if (!res.headersSent) respond(res, status, { code, message });
      else res.destroy();
    };

    const path = deps.fileFor(ticket);
    if (path === undefined) return fail(410, "gone", "The stored result is no longer available.");
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return fail(410, "gone", "The stored result is no longer available.");
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== ticket.totalBytes) {
        await handle.close();
        return fail(409, "file_changed", "The stored result changed after the download URL was issued. Ask for a new one with request_download.");
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stats.size,
        "Content-Disposition": `attachment; filename="${safeName(ticket.filename)}"`,
        "X-Content-SHA256": ticket.sha256 ?? "",
        "Cache-Control": "no-store",
      });
      logger.info("download started", { ticket: ticket.id, bytes: stats.size });
      const stream = handle.createReadStream();
      stream.on("data", (chunk: Buffer | string) => {
        tickets.progress(ticket, ticket.transferred + (typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length));
      });
      await pipeline(stream, res);
      tickets.complete(ticket, stats.size, ticket.sha256 ?? "");
      logger.info("download complete", { ticket: ticket.id, bytes: stats.size });
    } catch {
      // The client went away, or the file could not be read. Whatever was sent is already on the wire.
      await handle.close().catch(() => undefined);
      fail(0, "interrupted", "The download was interrupted before it finished.");
    }
  };
}
