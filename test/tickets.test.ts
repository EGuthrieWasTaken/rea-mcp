import { describe, expect, it } from "vitest";
import { MAX_LIVE_TICKETS, TicketLimitError, TicketStore, type Ticket } from "../src/transfer/tickets.js";

const TTL = 900_000;

/** A store on a clock the test controls. */
const make = (ttlMs = TTL) => {
  let time = 1_000_000_000;
  const ended: Ticket[] = [];
  const store = new TicketStore({ ttlMs, now: () => time, onEnd: (ticket) => ended.push(ticket) });
  return {
    store,
    ended,
    advance: (ms: number): void => {
      time += ms;
    },
  };
};

const upload = (store: TicketStore, sessionId = "s1") =>
  store.createUpload({ sessionId, name: "a.bin", overwrite: false, maxBytes: 1000, expectSha256: undefined });
const download = (store: TicketStore, sessionId = "s1") =>
  store.createDownload({ sessionId, resultId: "r_1", filename: "r_1.txt", totalBytes: 10, sha256: "ab".repeat(32) });

describe("tickets: creation", () => {
  it("gives an id with a kind prefix and a 256-bit secret", () => {
    const { store } = make();
    const up = upload(store);
    const down = download(store);
    expect(up.ticket.id).toMatch(/^u_[A-Za-z0-9_-]{22}$/);
    expect(down.ticket.id).toMatch(/^d_[A-Za-z0-9_-]{22}$/);
    // 32 random bytes in base64url: 43 characters.
    expect(up.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(down.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(up.secret).not.toBe(down.secret);
  });

  it("starts pending, with the expiry one lifetime away", () => {
    const { store } = make();
    const { ticket } = upload(store);
    expect(store.effectiveState(ticket)).toBe("pending");
    expect(ticket.expiresAt - ticket.createdAt).toBe(TTL);
  });

  it("never keeps the secret, only its digest", () => {
    const { store } = make();
    const { ticket, secret } = upload(store);
    expect(JSON.stringify(ticket)).not.toContain(secret);
    for (const value of Object.values(ticket)) {
      if (typeof value === "string") expect(value).not.toContain(secret);
    }
    expect(ticket.secretDigest.length).toBe(32);
    expect(ticket.secretDigest.toString("utf8")).not.toContain(secret);
  });

  it("refuses a ticket past the cap, and counts uploads and downloads together", () => {
    const { store } = make();
    for (let i = 0; i < MAX_LIVE_TICKETS; i += 1) (i % 2 === 0 ? upload : download)(store);
    expect(() => upload(store)).toThrow(TicketLimitError);
    expect(() => download(store)).toThrow(TicketLimitError);
    expect(store.size).toBe(MAX_LIVE_TICKETS);
  });
});

describe("tickets: finding one", () => {
  it("finds a ticket by id and secret", () => {
    const { store } = make();
    const { ticket, secret } = upload(store);
    expect(store.find(ticket.id, secret)).toBe(ticket);
  });

  it("answers a wrong secret and an unknown id the same way", () => {
    const { store } = make();
    const { ticket, secret } = upload(store);
    expect(store.find(ticket.id, `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`)).toBeUndefined();
    expect(store.find(ticket.id, "")).toBeUndefined();
    expect(store.find("u_unknown", secret)).toBeUndefined();
    expect(store.find("u_unknown", "also wrong")).toBeUndefined();
  });

  it("does not accept the secret of one ticket for another", () => {
    const { store } = make();
    const a = upload(store);
    const b = upload(store);
    expect(store.find(a.ticket.id, b.secret)).toBeUndefined();
  });

  it("does not accept an id as a secret", () => {
    const { store } = make();
    const { ticket } = upload(store);
    expect(store.find(ticket.id, ticket.id)).toBeUndefined();
  });

  it("gives a ticket by id alone for status", () => {
    const { store } = make();
    const { ticket } = upload(store);
    expect(store.get(ticket.id)).toBe(ticket);
    expect(store.get("u_unknown")).toBeUndefined();
  });
});

describe("tickets: claiming", () => {
  it("claims once: an upload starts receiving, a download starts streaming", () => {
    const { store } = make();
    const up = upload(store).ticket;
    const down = download(store).ticket;
    expect(store.claim(up)).toBe("claimed");
    expect(store.claim(down)).toBe("claimed");
    expect(up.state).toBe("receiving");
    expect(down.state).toBe("streaming");
  });

  it("refuses a second claim, before and after the transfer", () => {
    const { store } = make();
    const { ticket } = upload(store);
    expect(store.claim(ticket)).toBe("claimed");
    expect(store.claim(ticket)).toBe("already-claimed");
    store.complete(ticket, 5, "00".repeat(32));
    expect(store.claim(ticket)).toBe("already-claimed");
  });

  it("refuses a ticket claimed too late, and does not claim it", () => {
    const { store, advance } = make();
    const { ticket } = upload(store);
    advance(TTL);
    expect(store.claim(ticket)).toBe("expired");
    expect(ticket.state).toBe("pending");
    expect(store.effectiveState(ticket)).toBe("expired");
  });

  it("lets a transfer that began in time finish after the expiry, and reports it as already claimed", () => {
    const { store, advance } = make();
    const { ticket } = upload(store);
    expect(store.claim(ticket)).toBe("claimed");
    advance(TTL * 2);
    expect(store.effectiveState(ticket)).toBe("receiving");
    expect(store.claim(ticket)).toBe("already-claimed");
    store.complete(ticket, 1, "00".repeat(32));
    expect(store.effectiveState(ticket)).toBe("complete");
  });
});

describe("tickets: finishing", () => {
  it("records the size and hash of a completed transfer and tells the listener", () => {
    const { store, ended } = make();
    const { ticket } = upload(store);
    store.claim(ticket);
    store.progress(ticket, 40);
    expect(ticket.transferred).toBe(40);
    store.complete(ticket, 100, "ab".repeat(32));
    expect(ticket).toMatchObject({ state: "complete", size: 100, sha256: "ab".repeat(32), transferred: 100 });
    expect(ended).toEqual([ticket]);
  });

  it("records why a transfer failed, and a failure is final", () => {
    const { store, ended } = make();
    const { ticket } = upload(store);
    store.claim(ticket);
    store.fail(ticket, "too_large", "The body is too large");
    expect(ticket).toMatchObject({ state: "failed", error: { code: "too_large", message: "The body is too large" } });
    store.fail(ticket, "other", "again");
    expect(ticket.error?.code).toBe("too_large");
    expect(ended).toHaveLength(1);
  });

  it("does not turn a completed transfer into a failure", () => {
    const { store } = make();
    const { ticket } = upload(store);
    store.claim(ticket);
    store.complete(ticket, 1, "00".repeat(32));
    store.fail(ticket, "late", "too late");
    expect(ticket.state).toBe("complete");
    expect(ticket.error).toBeUndefined();
  });

  it("survives a listener that throws", () => {
    const { store } = make();
    store.onEnd = () => {
      throw new Error("boom");
    };
    const { ticket } = upload(store);
    store.claim(ticket);
    expect(() => store.complete(ticket, 1, "00".repeat(32))).not.toThrow();
    expect(ticket.state).toBe("complete");
  });
});

describe("tickets: remembering and forgetting", () => {
  it("remembers a finished ticket for one lifetime and counts it against the cap until then", () => {
    const { store, advance } = make();
    const { ticket } = upload(store);
    store.claim(ticket);
    store.complete(ticket, 1, "00".repeat(32));
    advance(TTL - 1);
    store.sweep();
    expect(store.get(ticket.id)).toBe(ticket);
    advance(1);
    store.sweep();
    expect(store.get(ticket.id)).toBeUndefined();
  });

  it("forgets a ticket on lookup too, not only when another is minted", () => {
    const { store, advance } = make();
    const { ticket, secret } = upload(store);
    store.claim(ticket);
    store.complete(ticket, 1, "00".repeat(32));
    advance(TTL);
    expect(store.find(ticket.id, secret)).toBeUndefined();
    expect(store.get(ticket.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("forgets an unclaimed ticket one lifetime after it expired, not before", () => {
    const { store, advance } = make();
    const { ticket } = upload(store);
    advance(TTL * 2 - 1);
    store.sweep();
    expect(store.get(ticket.id)).toBe(ticket);
    advance(1);
    store.sweep();
    expect(store.get(ticket.id)).toBeUndefined();
  });

  it("never forgets a transfer that is still under way", () => {
    const { store, advance } = make();
    const { ticket } = upload(store);
    store.claim(ticket);
    advance(TTL * 10);
    store.sweep();
    expect(store.get(ticket.id)).toBe(ticket);
  });

  it("makes room by sweeping when a ticket is requested", () => {
    const { store, advance } = make();
    for (let i = 0; i < MAX_LIVE_TICKETS; i += 1) upload(store);
    advance(TTL * 2);
    expect(() => upload(store)).not.toThrow();
    expect(store.size).toBe(1);
  });
});

describe("tickets: sessions", () => {
  it("is busy only while one of the session's transfers is under way", () => {
    const { store } = make();
    const { ticket } = upload(store, "s1");
    expect(store.busy("s1")).toBe(false);
    store.claim(ticket);
    expect(store.busy("s1")).toBe(true);
    expect(store.busy("s2")).toBe(false);
    store.complete(ticket, 1, "00".repeat(32));
    expect(store.busy("s1")).toBe(false);
  });

  it("does not count a ticket nobody has used", () => {
    const { store } = make();
    upload(store, "s1");
    expect(store.busy("s1")).toBe(false);
  });

  it("revokes a session's download tickets and nothing else", () => {
    const { store } = make();
    const mine = download(store, "s1");
    const other = download(store, "s2");
    const myUpload = upload(store, "s1");
    store.revokeDownloads("s1");
    expect(store.find(mine.ticket.id, mine.secret)).toBeUndefined();
    expect(store.find(other.ticket.id, other.secret)).toBe(other.ticket);
    expect(store.find(myUpload.ticket.id, myUpload.secret)).toBe(myUpload.ticket);
  });
});

describe("tickets: the quota's view", () => {
  it("reserves the size of pending (unexpired) and receiving uploads only", () => {
    const { store, advance } = make();
    const a = upload(store).ticket;
    const b = upload(store).ticket;
    const c = upload(store).ticket;
    expect(store.reservedUploadBytes()).toBe(3000);
    store.claim(b);
    store.complete(b, 5, "00".repeat(32));
    expect(store.reservedUploadBytes()).toBe(2000);
    store.claim(a);
    expect(store.reservedUploadBytes()).toBe(2000);
    advance(TTL);
    expect(store.reservedUploadBytes()).toBe(1000); // c expired, a still receiving
    expect(store.effectiveState(c)).toBe("expired");
  });

  it("does not count downloads", () => {
    const { store } = make();
    download(store);
    expect(store.reservedUploadBytes()).toBe(0);
  });
});
