// Log hygiene for the transfer routes (spec: file-transfer, "Secrets stay out of the logs"; mcp-http-gateway,
// "Structured logging"; task 4.4). Everything is run at LOG_LEVEL=debug, the most the gateway ever writes.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDownloadHandler } from "../src/transfer/download.js";
import { closeTransferHarnesses, send, startTransfer } from "./helpers/transfer.js";
import { tempDir } from "./helpers/tmp.js";

afterEach(closeTransferHarnesses);

/** The needles that appear somewhere in the log text. */
const leaked = (lines: readonly string[], needles: Record<string, string>): string[] => {
  const text = lines.join("\n");
  return Object.entries(needles)
    .filter(([, needle]) => text.includes(needle))
    .map(([label]) => label);
};

const get = (port: number, path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });

describe("the leak detector itself", () => {
  it("finds a needle in any line and reports its label", () => {
    expect(leaked(['{"message":"fine"}', '{"message":"oops SECRETVALUE"}'], { secret: "SECRETVALUE", name: "other" })).toEqual(["secret"]);
    expect(leaked(['{"message":"fine"}'], { secret: "SECRETVALUE" })).toEqual([]);
  });
});

describe("transfer logging at debug level", () => {
  it("never writes a secret, a URL, a request path, a file name or file content", async () => {
    const dir = tempDir("rea-mcp-results-");
    const stored = join(dir, "r_log.txt");
    const result = Buffer.from("stored-result-marker-QQ");
    writeFileSync(stored, result);
    const t = await startTransfer({
      routes: ({ store }) => ({
        download: createDownloadHandler({
          tickets: store,
          logger: { debug() {}, info() {}, warn() {}, error() {}, enabled: () => false },
          idleTimeoutSec: 600,
          fileFor: () => stored,
        }),
      }),
    });

    const up = t.issue({ name: "private-file-name-XYZ.bin" });
    const down = t.issueDownload({ resultId: "r_log", filename: "r_log.txt", totalBytes: result.length, sha256: createHash("sha256").update(result).digest("hex") });
    const content = randomBytes(2000).toString("base64");

    expect((await send(t.port, "PUT", up.path, [Buffer.from(`upload-content-marker-QQ ${content}`)])).status).toBe(200);
    expect(await get(t.port, down.path)).toBe(200);
    // A failed attempt, a reuse, a wrong method and an unknown path, so every branch has logged something.
    expect((await send(t.port, "PUT", `/upload/u_unknown-id-ZZ/wrong-secret-ZZ`, [Buffer.from("x")])).status).toBe(404);
    expect((await send(t.port, "PUT", up.path, [Buffer.from("again")])).status).toBe(409);
    expect((await send(t.port, "DELETE", up.path)).status).toBe(405);

    const needles = {
      "upload secret": up.secret,
      "download secret": down.secret,
      "upload path": up.path,
      "download path": down.path,
      "upload url tail": `${up.ticket.id}/${up.secret}`,
      "file name": "private-file-name-XYZ",
      "upload content": "upload-content-marker-QQ",
      "result content": "stored-result-marker-QQ",
      "unknown id": "u_unknown-id-ZZ",
      "wrong secret": "wrong-secret-ZZ",
    };
    expect(leaked(t.lines, needles)).toEqual([]);

    // Every line is still valid JSON with only the documented fields.
    const known = new Set(["time", "level", "message", "method", "path", "status", "durationMs", "sourceIp", "ticket", "bytes", "reason"]);
    for (const line of t.lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(entry)) expect(known, key).toContain(key);
      if (typeof entry.path === "string") expect(["/upload", "/download", "/mcp", "/healthz", "other"]).toContain(entry.path);
    }
  });
});
