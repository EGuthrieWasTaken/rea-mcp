import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDownloadHandler } from "../src/transfer/download.js";
import { closeTransferHarnesses, send, startTransfer } from "./helpers/transfer.js";
import { tempDir } from "./helpers/tmp.js";

afterEach(closeTransferHarnesses);

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (body: Buffer): unknown => (JSON.parse(body.toString()) as { code?: unknown }).code;

/** A harness whose download route serves files from a temp directory, by result id. */
const start = async () => {
  const dir = tempDir("rea-mcp-results-");
  const files = new Map<string, string>();
  const t = await startTransfer({
    routes: ({ store }) => ({
      download: createDownloadHandler({
        tickets: store,
        logger: { debug() {}, info() {}, warn() {}, error() {}, enabled: () => false },
        fileFor: (ticket) => files.get(ticket.resultId),
      }),
    }),
  });
  return {
    ...t,
    /** Store `content` as a result and issue a ticket for it. */
    stored: (content: Buffer, resultId = "r_one") => {
      const path = join(dir, `${resultId}.txt`);
      writeFileSync(path, content);
      files.set(resultId, path);
      return t.issueDownload({ resultId, filename: `${resultId}.txt`, totalBytes: content.length, sha256: sha256(content) });
    },
    path: (resultId: string) => join(dir, `${resultId}.txt`),
    forget: (resultId: string) => void files.delete(resultId),
  };
};

const get = (port: number, path: string) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.once("error", reject);
    req.end();
  });

describe("download", () => {
  it("sends the stored bytes with their size, hash and a download name, and completes the ticket", async () => {
    const t = await start();
    const content = randomBytes(3 * 1024 * 1024 + 7);
    const { ticket, path } = t.stored(content);
    const reply = await get(t.port, path);
    expect(reply.status).toBe(200);
    expect(reply.body.equals(content)).toBe(true);
    expect(reply.headers["content-length"]).toBe(String(content.length));
    expect(reply.headers["x-content-sha256"]).toBe(sha256(content));
    expect(reply.headers["content-disposition"]).toBe('attachment; filename="r_one.txt"');
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["content-type"]).toBe("application/octet-stream");
    for (let i = 0; i < 100 && ticket.state === "streaming"; i += 1) await sleep(10);
    expect(ticket).toMatchObject({ state: "complete", size: content.length });
  });

  it("sends an empty result", async () => {
    const t = await start();
    const { path } = t.stored(Buffer.alloc(0));
    const reply = await get(t.port, path);
    expect(reply.status).toBe(200);
    expect(reply.body.length).toBe(0);
  });

  it("refuses a second use with 409", async () => {
    const t = await start();
    const { path } = t.stored(Buffer.from("once"));
    expect((await get(t.port, path)).status).toBe(200);
    const again = await get(t.port, path);
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe("conflict");
  });

  it("refuses an expired ticket with 410", async () => {
    const t = await start();
    const { path } = t.stored(Buffer.from("late"));
    t.advance(900_000);
    const reply = await get(t.port, path);
    expect(reply.status).toBe(410);
    expect(codeOf(reply.body)).toBe("expired");
  });

  it("answers 404 for a ticket whose session has ended", async () => {
    const t = await start();
    const { path } = t.stored(Buffer.from("gone with the session"));
    t.store.revokeDownloads("s1");
    expect((await get(t.port, path)).status).toBe(404);
  });

  it("answers 410 when the stored file is gone", async () => {
    const t = await start();
    const { ticket, path } = t.stored(Buffer.from("vanishing"));
    t.forget("r_one");
    const reply = await get(t.port, path);
    expect(reply.status).toBe(410);
    expect(codeOf(reply.body)).toBe("gone");
    expect(ticket.state).toBe("failed");
  });

  it("refuses a file whose size changed since the ticket was issued", async () => {
    const t = await start();
    const { ticket, path } = t.stored(Buffer.from("original size"));
    writeFileSync(t.path("r_one"), "changed to a different size");
    const reply = await get(t.port, path);
    expect(reply.status).toBe(409);
    expect(codeOf(reply.body)).toBe("file_changed");
    expect(ticket.state).toBe("failed");
  });

  it("does not take an upload ticket at the download route, nor a download ticket at the upload route", async () => {
    const t = await start();
    const down = t.stored(Buffer.from("x"));
    const up = t.issue({ name: "a.bin" });
    expect((await get(t.port, `/download/${up.ticket.id}/${up.secret}`)).status).toBe(404);
    expect((await send(t.port, "PUT", `/upload/${down.ticket.id}/${down.secret}`, [Buffer.from("y")])).status).toBe(404);
  });

  it("fails the ticket when the client drops the connection part way", async () => {
    const t = await start();
    const content = randomBytes(30 * 1024 * 1024);
    const { ticket, path } = t.stored(content);
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port: t.port, method: "GET", path }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => undefined);
      req.end();
    });
    for (let i = 0; i < 100 && ticket.state === "streaming"; i += 1) await sleep(20);
    expect(ticket).toMatchObject({ state: "failed", error: { code: "interrupted" } });
  });

  it("makes a streaming download count as a transfer under way", async () => {
    const t = await start();
    const { ticket, path } = t.stored(randomBytes(30 * 1024 * 1024));
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port: t.port, method: "GET", path }, (res) => {
        res.pause();
        setTimeout(() => {
          expect(t.store.busy("s1")).toBe(true);
          req.destroy();
          resolve();
        }, 150);
      });
      req.on("error", () => undefined);
      req.end();
    });
    for (let i = 0; i < 100 && ticket.state === "streaming"; i += 1) await sleep(20);
    expect(t.store.busy("s1")).toBe(false);
  });
});
