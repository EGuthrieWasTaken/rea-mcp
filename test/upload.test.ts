import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeTransferHarnesses, partialPut, send, sendOrError, startTransfer, type Reply } from "./helpers/transfer.js";
import { tempDir } from "./helpers/tmp.js";

afterEach(closeTransferHarnesses);

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const json = (reply: Reply): Record<string, unknown> => JSON.parse(reply.body) as Record<string, unknown>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `data` as chunks of at most 64 KiB. */
function* chunked(data: Buffer, size = 64 * 1024): Generator<Buffer> {
  for (let offset = 0; offset < data.length; offset += size) yield data.subarray(offset, offset + size);
}

describe("upload: success", () => {
  it("stores a multi-megabyte body under its name and reports its size, hash and path", async () => {
    const t = await startTransfer();
    const body = randomBytes(5 * 1024 * 1024 + 123);
    const { ticket, path } = t.issue({ name: "big.bin" });
    const reply = await send(t.port, "PUT", path, chunked(body), { "Content-Length": body.length });
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({
      ok: true,
      upload_id: ticket.id,
      name: "big.bin",
      path: join(t.inboxDir, "big.bin"),
      size: body.length,
      sha256: sha256(body),
    });
    expect(readFileSync(join(t.inboxDir, "big.bin")).equals(body)).toBe(true);
    expect(readdirSync(t.inboxDir)).toEqual(["big.bin"]);
    expect(statSync(join(t.inboxDir, "big.bin")).mode & 0o111).toBe(0);
    expect(ticket).toMatchObject({ state: "complete", size: body.length, sha256: sha256(body) });
  });

  it("accepts POST as well as PUT", async () => {
    const t = await startTransfer();
    const { path } = t.issue({ name: "post.bin" });
    const reply = await send(t.port, "POST", path, [Buffer.from("via post")], { "Content-Length": 8 });
    expect(reply.status).toBe(200);
    expect(readFileSync(join(t.inboxDir, "post.bin"), "utf8")).toBe("via post");
  });

  it("accepts a body with no Content-Length (chunked)", async () => {
    const t = await startTransfer();
    const { path } = t.issue({ name: "chunked.bin" });
    const reply = await send(t.port, "PUT", path, [Buffer.from("one "), Buffer.from("two")]);
    expect(reply.status).toBe(200);
    expect(readFileSync(join(t.inboxDir, "chunked.bin"), "utf8")).toBe("one two");
  });

  it("accepts an empty file", async () => {
    const t = await startTransfer();
    const { path } = t.issue({ name: "empty.bin" });
    const reply = await send(t.port, "PUT", path, [], { "Content-Length": 0 });
    expect(reply.status).toBe(200);
    expect(json(reply).sha256).toBe(sha256(Buffer.alloc(0)));
    expect(statSync(join(t.inboxDir, "empty.bin")).size).toBe(0);
  });

  it("accepts a hash that matches", async () => {
    const t = await startTransfer();
    const body = Buffer.from("known content");
    const { path } = t.issue({ name: "ok.bin", expectSha256: sha256(body) });
    expect((await send(t.port, "PUT", path, [body])).status).toBe(200);
  });

  it("reports progress while the body is arriving", async () => {
    const t = await startTransfer();
    const { ticket, path } = t.issue({ name: "slow.bin" });
    const first = Buffer.alloc(100_000, 1);
    const pending = partialPut(t.port, path, 200_000, first);
    for (let i = 0; i < 100 && ticket.transferred === 0; i += 1) await sleep(20);
    expect(t.store.effectiveState(ticket)).toBe("receiving");
    expect(ticket.transferred).toBeGreaterThan(0);
    pending.socket.destroy();
    await pending.closed;
  });

  it("is not cut off when the body keeps arriving for longer than the stall limit", async () => {
    const t = await startTransfer({ stallMs: 150 });
    const { path } = t.issue({ name: "steady.bin" });
    async function* trickle(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 12; i += 1) {
        yield Buffer.from("0123456789");
        await sleep(40);
      }
    }
    const reply = await send(t.port, "PUT", path, trickle());
    expect(reply.status).toBe(200);
    expect(statSync(join(t.inboxDir, "steady.bin")).size).toBe(120);
  });

  it("writes the body to disk as it arrives instead of holding it until the end", async () => {
    const t = await startTransfer();
    const { path } = t.issue({ name: "large.bin", maxBytes: 100 * 1024 * 1024 });
    const half = 8 * 1024 * 1024;
    const pending = partialPut(t.port, path, 2 * half, randomBytes(half));
    let written = 0;
    for (let i = 0; i < 200 && written < half; i += 1) {
      await sleep(25);
      written = Math.max(0, ...readdirSync(t.inboxDir).map((name) => statSync(join(t.inboxDir, name)).size));
    }
    // Half the body has arrived and is in the temporary file; the other half has not been sent.
    expect(written).toBe(half);
    expect(readdirSync(t.inboxDir).filter((name) => !name.startsWith(".upload-"))).toEqual([]);
    pending.socket.destroy();
    await pending.closed;
  });
});

describe("upload: tickets are spent once", () => {
  it("refuses a second use with 409 and leaves the first file alone", async () => {
    const t = await startTransfer();
    const { path } = t.issue({ name: "once.bin" });
    expect((await send(t.port, "PUT", path, [Buffer.from("first")])).status).toBe(200);
    const again = await send(t.port, "PUT", path, [Buffer.from("second")]);
    expect(again.status).toBe(409);
    expect(json(again).code).toBe("conflict");
    expect(String(json(again).message)).toContain("request_upload");
    expect(readFileSync(join(t.inboxDir, "once.bin"), "utf8")).toBe("first");
  });

  it("refuses an expired ticket with 410, writes nothing and does not claim it", async () => {
    const t = await startTransfer({ ttlMs: 60_000 });
    const { ticket, path } = t.issue({ name: "late.bin" });
    t.advance(60_000);
    const reply = await send(t.port, "PUT", path, [Buffer.from("too late")]);
    expect(reply.status).toBe(410);
    expect(json(reply).code).toBe("expired");
    expect(String(json(reply).message)).toContain("request_upload");
    expect(readdirSync(t.inboxDir)).toEqual([]);
    expect(ticket.state).toBe("pending");
    expect(t.store.effectiveState(ticket)).toBe("expired");
  });

  it("spends a ticket even when the upload fails: a retry needs a new ticket", async () => {
    const t = await startTransfer();
    const { path } = t.issue({ name: "retry.bin", maxBytes: 4 });
    expect((await sendOrError(t.port, "PUT", path, [Buffer.from("way too large")], { "Content-Length": 13 })) instanceof Error).toBe(false);
    expect((await send(t.port, "PUT", path, [Buffer.from("ok")])).status).toBe(409);
  });
});

describe("upload: limits", () => {
  it("refuses a Content-Length over the limit at once, with 413, before reading the body", async () => {
    const t = await startTransfer();
    const { ticket, path } = t.issue({ name: "big.bin", maxBytes: 1000 });
    const reply = await sendOrError(t.port, "PUT", path, [Buffer.alloc(100)], { "Content-Length": 5000 });
    // The server answers without reading the body, so the client may see the reply or a reset.
    if (!(reply instanceof Error)) {
      expect(reply.status).toBe(413);
      expect(json(reply).code).toBe("too_large");
    }
    for (let i = 0; i < 50 && ticket.state === "receiving"; i += 1) await sleep(10);
    expect(ticket).toMatchObject({ state: "failed", error: { code: "too_large" } });
    expect(readdirSync(t.inboxDir)).toEqual([]);
  });

  it("stops a body with no Content-Length once it passes the limit, and leaves no file", async () => {
    const t = await startTransfer();
    const { ticket, path } = t.issue({ name: "chunked.bin", maxBytes: 1000 });
    const reply = await sendOrError(t.port, "PUT", path, chunked(Buffer.alloc(300_000, 7), 10_000));
    if (!(reply instanceof Error)) expect(reply.status).toBe(413);
    for (let i = 0; i < 50 && ticket.state === "receiving"; i += 1) await sleep(10);
    expect(ticket).toMatchObject({ state: "failed", error: { code: "too_large" } });
    expect(readdirSync(t.inboxDir)).toEqual([]);
  });

  it("accepts a file of exactly the limit and refuses one a byte over", async () => {
    const t = await startTransfer();
    const exact = t.issue({ name: "exact.bin", maxBytes: 1000 });
    expect((await send(t.port, "PUT", exact.path, [Buffer.alloc(1000)], { "Content-Length": 1000 })).status).toBe(200);
    const over = t.issue({ name: "over.bin", maxBytes: 1000 });
    const reply = await sendOrError(t.port, "PUT", over.path, [Buffer.alloc(1001)], { "Content-Length": 1001 });
    if (!(reply instanceof Error)) expect(reply.status).toBe(413);
    expect(readdirSync(t.inboxDir)).toEqual(["exact.bin"]);
  });
});

describe("upload: integrity", () => {
  it("refuses a body that does not have the expected hash, with 422, and commits nothing", async () => {
    const t = await startTransfer();
    const { ticket, path } = t.issue({ name: "tampered.bin", expectSha256: sha256(Buffer.from("what was promised")) });
    const reply = await send(t.port, "PUT", path, [Buffer.from("what arrived")]);
    expect(reply.status).toBe(422);
    expect(json(reply).code).toBe("sha_mismatch");
    expect(readdirSync(t.inboxDir)).toEqual([]);
    expect(ticket).toMatchObject({ state: "failed", error: { code: "sha_mismatch" } });
  });

  it("leaves an existing file as it was when a replacement fails its hash", async () => {
    const t = await startTransfer();
    writeFileSync(join(t.inboxDir, "keep.bin"), "original");
    const { path } = t.issue({ name: "keep.bin", overwrite: true, expectSha256: "00".repeat(32) });
    expect((await send(t.port, "PUT", path, [Buffer.from("replacement")])).status).toBe(422);
    expect(readFileSync(join(t.inboxDir, "keep.bin"), "utf8")).toBe("original");
    expect(readdirSync(t.inboxDir)).toEqual(["keep.bin"]);
  });
});

describe("upload: the commit", () => {
  it("refuses with 409 when a file with the name appeared after the ticket was issued", async () => {
    const t = await startTransfer();
    const { ticket, path } = t.issue({ name: "taken.bin" });
    writeFileSync(join(t.inboxDir, "taken.bin"), "created meanwhile");
    const reply = await send(t.port, "PUT", path, [Buffer.from("new")]);
    expect(reply.status).toBe(409);
    expect(readFileSync(join(t.inboxDir, "taken.bin"), "utf8")).toBe("created meanwhile");
    expect(readdirSync(t.inboxDir)).toEqual(["taken.bin"]);
    expect(ticket.state).toBe("failed");
  });

  it("replaces a regular file when the ticket allows overwriting", async () => {
    const t = await startTransfer();
    writeFileSync(join(t.inboxDir, "same.bin"), "old");
    const { path } = t.issue({ name: "same.bin", overwrite: true });
    expect((await send(t.port, "PUT", path, [Buffer.from("new")])).status).toBe(200);
    expect(readFileSync(join(t.inboxDir, "same.bin"), "utf8")).toBe("new");
  });

  it("refuses a symlink planted at the name after the ticket was issued, and writes nothing through it", async () => {
    const t = await startTransfer();
    const outside = join(tempDir(), "outside.txt");
    writeFileSync(outside, "outside original");
    const { path } = t.issue({ name: "link.bin", overwrite: true });
    symlinkSync(outside, join(t.inboxDir, "link.bin"));
    const reply = await send(t.port, "PUT", path, [Buffer.from("attack")]);
    expect(reply.status).toBe(409);
    expect(readFileSync(outside, "utf8")).toBe("outside original");
    expect(lstatSync(join(t.inboxDir, "link.bin")).isSymbolicLink()).toBe(true);
    expect(readdirSync(t.inboxDir)).toEqual(["link.bin"]);
  });

  it("refuses a directory at the name", async () => {
    const t = await startTransfer();
    mkdirSync(join(t.inboxDir, "folder"));
    const { path } = t.issue({ name: "folder", overwrite: true });
    expect((await send(t.port, "PUT", path, [Buffer.from("x")])).status).toBe(409);
    expect(readdirSync(t.inboxDir)).toEqual(["folder"]);
  });

  it("does not let the body show up under the final name before it is whole", async () => {
    const t = await startTransfer();
    const { path } = t.issue({ name: "whole.bin" });
    const pending = partialPut(t.port, path, 1000, Buffer.alloc(500, 1));
    await sleep(100);
    expect(readdirSync(t.inboxDir).filter((name) => name === "whole.bin")).toEqual([]);
    expect(readdirSync(t.inboxDir).some((name) => name.startsWith(".upload-"))).toBe(true);
    pending.socket.destroy();
    await pending.closed;
  });
});

describe("upload: failures leave nothing behind", () => {
  it("removes the temporary file and fails the ticket when the client hangs up", async () => {
    const t = await startTransfer();
    writeFileSync(join(t.inboxDir, "keep.bin"), "original");
    const { ticket, path } = t.issue({ name: "keep.bin", overwrite: true });
    const pending = partialPut(t.port, path, 100_000, Buffer.alloc(40_000, 2));
    await sleep(100);
    pending.socket.destroy();
    await pending.closed;
    for (let i = 0; i < 100 && ticket.state === "receiving"; i += 1) await sleep(10);
    expect(ticket).toMatchObject({ state: "failed", error: { code: "interrupted" } });
    expect(readdirSync(t.inboxDir)).toEqual(["keep.bin"]);
    expect(readFileSync(join(t.inboxDir, "keep.bin"), "utf8")).toBe("original");
  });

  it("answers 408 and cleans up when the body stalls", async () => {
    const t = await startTransfer({ stallMs: 150 });
    const { ticket, path } = t.issue({ name: "stall.bin" });
    const pending = partialPut(t.port, path, 100_000, Buffer.alloc(1000, 3));
    await pending.closed;
    expect(pending.received()).toContain("408");
    expect(ticket).toMatchObject({ state: "failed", error: { code: "stalled" } });
    expect(readdirSync(t.inboxDir)).toEqual([]);
  });

  it("tells the session's idle timer a transfer ended, whichever way", async () => {
    const t = await startTransfer();
    const ended: string[] = [];
    t.store.onEnd = (ticket) => ended.push(`${ticket.id}:${ticket.state}`);
    const good = t.issue({ name: "good.bin" });
    const bad = t.issue({ name: "bad.bin", expectSha256: "00".repeat(32) });
    await send(t.port, "PUT", good.path, [Buffer.from("x")]);
    await send(t.port, "PUT", bad.path, [Buffer.from("y")]);
    expect(ended).toEqual([`${good.ticket.id}:complete`, `${bad.ticket.id}:failed`]);
  });
});

describe("upload: what gets logged", () => {
  it("logs ids and sizes, never the secret, the path or the file name", async () => {
    const t = await startTransfer();
    const { ticket, secret, path } = t.issue({ name: "very-secret-name.bin" });
    await send(t.port, "PUT", path, [Buffer.from("content-marker-ZZ")]);
    const text = t.lines.join("");
    for (const needle of [secret, "very-secret-name", "content-marker-ZZ", path]) expect(text, needle).not.toContain(needle);
    const messages = t.lines.map((line) => JSON.parse(line) as Record<string, unknown>).map((entry) => entry.message);
    expect(messages).toContain("upload started");
    expect(messages).toContain("upload complete");
    const done = t.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.message === "upload complete");
    expect(done).toMatchObject({ ticket: ticket.id, bytes: 17 });
  });
});
