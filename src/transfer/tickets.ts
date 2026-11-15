// One-time upload and download tickets (spec: file-transfer; design D5).
//
// A ticket is minted by a tool call and used by a plain HTTP request that carries no API key, so the
// secret in the URL is the only authorization. The store keeps tickets in memory only (a restart
// invalidates them, which is the intent) and holds only a SHA-256 digest of each secret, compared in
// constant time, so a copy of the process's memory does not yield a usable URL.
//
// Design after the maintainer's `claude-files` project (uploads.py / downloads.py): single use, a
// pending -> receiving -> complete | failed life, expiry computed on use, a cap on live tickets, and one
// indistinguishable answer for an unknown id and a wrong secret.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type TicketKind = "upload" | "download";

/** The states a ticket is stored in. `expired` is only ever reported (see `effectiveState`). */
export type TicketState = "pending" | "receiving" | "streaming" | "complete" | "failed";
export type ReportedState = TicketState | "expired";

export interface TicketError {
  readonly code: string;
  readonly message: string;
}

interface TicketBase {
  readonly id: string;
  /** The session that asked for the ticket. */
  readonly sessionId: string;
  /** SHA-256 of the secret. The secret itself is never kept. */
  readonly secretDigest: Buffer;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  readonly expiresAt: number;
  state: TicketState;
  /** Bytes received (upload) or sent (download) so far. */
  transferred: number;
  /** Final size and SHA-256, once known. */
  size: number | undefined;
  sha256: string | undefined;
  error: TicketError | undefined;
  /** When it reached `complete` or `failed`. */
  endedAt: number | undefined;
}

export interface UploadTicket extends TicketBase {
  readonly kind: "upload";
  readonly name: string;
  readonly overwrite: boolean;
  readonly maxBytes: number;
  readonly expectSha256: string | undefined;
}

export interface DownloadTicket extends TicketBase {
  readonly kind: "download";
  readonly resultId: string;
  /** A safe file name for Content-Disposition. */
  readonly filename: string;
  readonly totalBytes: number;
}

export type Ticket = UploadTicket | DownloadTicket;

export interface UploadSpec {
  sessionId: string;
  name: string;
  overwrite: boolean;
  maxBytes: number;
  expectSha256: string | undefined;
}

export interface DownloadSpec {
  sessionId: string;
  resultId: string;
  filename: string;
  totalBytes: number;
  sha256: string;
}

/** The most tickets that may be live at once, uploads and downloads together. */
export const MAX_LIVE_TICKETS = 100;

export class TicketLimitError extends Error {
  constructor() {
    super("too many tickets are live");
    this.name = "TicketLimitError";
  }
}

export type Claim = "claimed" | "already-claimed" | "expired";

export interface TicketStoreOptions {
  /** How long an unused ticket lasts, and how long a finished or expired one is remembered. */
  ttlMs: number;
  /** Clock, injectable for tests. Milliseconds since the epoch. */
  now?: () => number;
  /** Called when a transfer ends, whichever way (so the session's idle timer can restart). */
  onEnd?: (ticket: Ticket) => void;
}

const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();

/** What an unknown id is compared against, so that it takes the same path as a known id with a wrong secret. */
const NO_TICKET = digest("no such ticket");

export class TicketStore {
  private readonly tickets = new Map<string, Ticket>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Set after construction by whoever wants to hear about transfers ending. */
  onEnd: ((ticket: Ticket) => void) | undefined;

  constructor(options: TicketStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.onEnd = options.onEnd;
  }

  /** Tickets held, including finished and expired ones that are still remembered. */
  get size(): number {
    return this.tickets.size;
  }

  createUpload(spec: UploadSpec): { ticket: UploadTicket; secret: string } {
    const { id, secret, base } = this.mint("u", spec.sessionId);
    const ticket: UploadTicket = { ...base, kind: "upload", ...spec };
    this.tickets.set(id, ticket);
    return { ticket, secret };
  }

  createDownload(spec: DownloadSpec): { ticket: DownloadTicket; secret: string } {
    const { id, secret, base } = this.mint("d", spec.sessionId);
    const ticket: DownloadTicket = { ...base, kind: "download", ...spec, size: spec.totalBytes };
    this.tickets.set(id, ticket);
    return { ticket, secret };
  }

  /**
   * The ticket this id and secret name, or undefined. An unknown id and a wrong secret give the same
   * answer by the same steps; the caller must not be able to tell them apart.
   */
  find(id: string, secret: string): Ticket | undefined {
    const ticket = this.tickets.get(id);
    const matches = timingSafeEqual(digest(secret), ticket?.secretDigest ?? NO_TICKET);
    return matches && ticket !== undefined ? ticket : undefined;
  }

  /** A ticket by its public id, for `upload_status`. No secret is involved. */
  get(id: string): Ticket | undefined {
    return this.tickets.get(id);
  }

  /** `expired` is what a ticket nobody claimed in time is reported as. */
  effectiveState(ticket: Ticket): ReportedState {
    return ticket.state === "pending" && this.now() >= ticket.expiresAt ? "expired" : ticket.state;
  }

  /**
   * Take the one use a ticket has. A ticket that was already claimed stays claimed (whether or not it has
   * since expired); one that is still pending but past its expiry is refused and not claimed.
   */
  claim(ticket: Ticket): Claim {
    if (ticket.state !== "pending") return "already-claimed";
    if (this.now() >= ticket.expiresAt) return "expired";
    ticket.state = ticket.kind === "upload" ? "receiving" : "streaming";
    return "claimed";
  }

  progress(ticket: Ticket, transferred: number): void {
    ticket.transferred = transferred;
  }

  complete(ticket: Ticket, size: number, sha256: string): void {
    ticket.size = size;
    ticket.sha256 = sha256;
    ticket.transferred = size;
    this.end(ticket, "complete");
  }

  fail(ticket: Ticket, code: string, message: string): void {
    if (ticket.state === "complete" || ticket.state === "failed") return;
    ticket.error = { code, message };
    this.end(ticket, "failed");
  }

  /** Whether `sessionId` has a transfer under way. */
  busy(sessionId: string): boolean {
    for (const ticket of this.tickets.values()) {
      if (ticket.sessionId === sessionId && (ticket.state === "receiving" || ticket.state === "streaming")) return true;
    }
    return false;
  }

  /** Download tickets die with the session that asked for them: the file they name is deleted with it. */
  revokeDownloads(sessionId: string): void {
    for (const [id, ticket] of this.tickets) {
      if (ticket.kind === "download" && ticket.sessionId === sessionId) this.tickets.delete(id);
    }
  }

  /** Bytes that live upload tickets may still bring into the inbox (pending and not expired, or receiving). */
  reservedUploadBytes(): number {
    let total = 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.kind !== "upload") continue;
      const live = ticket.state === "receiving" || (ticket.state === "pending" && this.now() < ticket.expiresAt);
      if (live) total += ticket.maxBytes;
    }
    return total;
  }

  /** Forget tickets that ended or expired more than one lifetime ago. */
  sweep(): void {
    const current = this.now();
    for (const [id, ticket] of this.tickets) {
      const over = ticket.endedAt ?? (ticket.state === "pending" ? ticket.expiresAt : undefined);
      if (over !== undefined && current >= over + this.ttlMs) this.tickets.delete(id);
    }
  }

  private end(ticket: Ticket, state: "complete" | "failed"): void {
    ticket.state = state;
    ticket.endedAt = this.now();
    try {
      this.onEnd?.(ticket);
    } catch {
      // A listener that throws must not turn a finished transfer into a failure.
    }
  }

  private mint(prefix: "u" | "d", sessionId: string): { id: string; secret: string; base: TicketBase } {
    this.sweep();
    if (this.tickets.size >= MAX_LIVE_TICKETS) throw new TicketLimitError();
    const id = `${prefix}_${randomBytes(16).toString("base64url")}`;
    const secret = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    return {
      id,
      secret,
      base: {
        id,
        sessionId,
        secretDigest: digest(secret),
        createdAt,
        expiresAt: createdAt + this.ttlMs,
        state: "pending",
        transferred: 0,
        size: undefined,
        sha256: undefined,
        error: undefined,
        endedAt: undefined,
      },
    };
  }
}
