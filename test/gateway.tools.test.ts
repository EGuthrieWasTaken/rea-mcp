// The gateway's four tools, end to end: a real MCP client, the real ticket store, inbox, result store and HTTP routes, and the
// fake REA (specs: file-transfer, result-paging).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, connectClient, startHarness, textOf, type Harness } from "./helpers/gateway.js";
import { closeTransferHarnesses, partialPut } from "./helpers/transfer.js";

afterEach(async () => {
  await closeHarnesses();
  await closeTransferHarnesses();
});

type Client = Awaited<ReturnType<typeof connectClient>>["client"];
type Args = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const call = (client: Client, name: string, args: Args = {}) => client.callTool({ name, arguments: args });
const object = (result: unknown): Record<string, unknown> => JSON.parse(textOf(result)) as Record<string, unknown>;
const features = (harness: Harness) => {
  if (harness.features === undefined) throw new Error("started without files");
  return harness.features;
};
const pathOf = (url: unknown): string => new URL(String(url)).pathname;

const bigText = (chars: number, unicode = false): string => {
  const unit = unicode ? "0123456789abcdef日" : "0123456789abcdef";
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
};

const put = (url: unknown, body: string | Buffer) => fetch(String(url), { method: "PUT", body });

/** Start a harness with file features and one connected client. */
const start = async (files: NonNullable<Parameters<typeof startHarness>[0]>["files"] = {}, extra: Parameters<typeof startHarness>[0] = {}) => {
  const harness = await startHarness({ ...extra, files });
  const connected = await connectClient(harness);
  return { harness, ...connected };
};

describe("request_upload", () => {
  it("returns a single-use URL, a curl command, the path REA will open, and an expiry", async () => {
    const { harness, client } = await start();
    const reply = await call(client, "request_upload", { name: "sample.dll" });
    expect(reply.isError).toBeUndefined();
    const out = object(reply);
    expect(String(out.upload_url).startsWith(`${harness.origin}/upload/u_`)).toBe(true);
    expect(out.curl_command).toBe(`curl -sS --fail-with-body -T <LOCAL_FILE> '${String(out.upload_url)}'`);
    expect(out.path).toBe(join(features(harness).inboxDir, "sample.dll"));
    expect(out.url_source).toBe("Host header");
    expect(out.max_bytes).toBe(268_435_456);
    expect(new Date(String(out.expires_at)).getTime()).toBeGreaterThan(Date.now());
    expect(existsSync(String(out.path))).toBe(false);
  });

  it("completes the whole flow: upload with curl's request, check the status, find the file", async () => {
    const { harness, client } = await start();
    const out = object(await call(client, "request_upload", { name: "sample.bin" }));
    const content = Buffer.from("the bytes of a sample");
    const response = await put(out.upload_url, content);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, name: "sample.bin", size: content.length, sha256: sha256(content), path: out.path });
    expect(readFileSync(String(out.path))).toEqual(content);
    expect(statSync(String(out.path)).mode & 0o111).toBe(0);

    const status = object(await call(client, "upload_status", { upload_id: out.upload_id }));
    expect(status).toMatchObject({ state: "complete", size: content.length, sha256: sha256(content), path: out.path, bytes_received: content.length });
    expect((await put(out.upload_url, "again")).status).toBe(409);
    expect(features(harness).tickets.size).toBe(1);
  });

  it("builds the URL on PUBLIC_BASE_URL when it is set", async () => {
    const { client } = await start({ publicBaseUrl: "https://rea.example" });
    const out = object(await call(client, "request_upload", { name: "a.bin" }));
    expect(String(out.upload_url).startsWith("https://rea.example/upload/u_")).toBe(true);
    expect(out.url_source).toBe("PUBLIC_BASE_URL");
  });

  it("clamps max_bytes to the server's limit and passes a smaller one on", async () => {
    const { client } = await start({ maxUploadBytes: 1000 });
    expect(object(await call(client, "request_upload", { name: "a", max_bytes: 5_000_000 })).max_bytes).toBe(1000);
    expect(object(await call(client, "request_upload", { name: "b", max_bytes: 300 })).max_bytes).toBe(300);
    expect(object(await call(client, "request_upload", { name: "c" })).max_bytes).toBe(1000);
  });

  it("enforces the expected hash it was given, case-insensitively", async () => {
    const { harness, client } = await start();
    const body = Buffer.from("known");
    const good = object(await call(client, "request_upload", { name: "good.bin", expect_sha256: sha256(body).toUpperCase() }));
    expect((await put(good.upload_url, body)).status).toBe(200);
    const bad = object(await call(client, "request_upload", { name: "bad.bin", expect_sha256: "00".repeat(32) }));
    expect((await put(bad.upload_url, body)).status).toBe(422);
    expect(readdirSync(features(harness).inboxDir)).toEqual(["good.bin"]);
  });

  it.each([
    ["a slash", "dir/file"],
    ["a backslash", "dir\\file"],
    ["dot dot", ".."],
    ["a leading dot", ".hidden"],
    ["an empty name", ""],
    ["a newline", "a\nb"],
    ["a right-to-left override", `gpj.${String.fromCharCode(0x202e)}txt`],
    ["201 bytes", "a".repeat(201)],
  ])("refuses a name with %s, and issues no ticket", async (_label, name) => {
    const { harness, client } = await start();
    const reply = await call(client, "request_upload", { name });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toContain('"name"');
    expect(features(harness).tickets.size).toBe(0);
  });

  it("accepts a name of 60 three-byte characters", async () => {
    const { client } = await start();
    expect((await call(client, "request_upload", { name: "日".repeat(60) })).isError).toBeUndefined();
  });

  it("refuses a name already in the inbox unless overwrite is true", async () => {
    const { harness, client } = await start();
    writeFileSync(join(features(harness).inboxDir, "taken.bin"), "x");
    const refused = await call(client, "request_upload", { name: "taken.bin" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("overwrite");
    expect(features(harness).tickets.size).toBe(0);
    expect((await call(client, "request_upload", { name: "taken.bin", overwrite: true })).isError).toBeUndefined();
  });

  it.each([
    ["a malformed hash", { name: "a", expect_sha256: "abc" }, "expect_sha256"],
    ["a hash of the wrong length", { name: "a", expect_sha256: "0".repeat(63) }, "expect_sha256"],
    ["a zero max_bytes", { name: "a", max_bytes: 0 }, "max_bytes"],
    ["a negative max_bytes", { name: "a", max_bytes: -5 }, "max_bytes"],
    ["a fractional max_bytes", { name: "a", max_bytes: 1.5 }, "max_bytes"],
    ["a name that is not a string", { name: 5 }, "name"],
    ["an overwrite that is not a boolean", { name: "a", overwrite: "yes" }, "overwrite"],
    ["a missing name", {}, "name"],
    ["an unknown argument", { name: "a", path: "/etc" }, "path"],
  ])("refuses %s, naming the argument", async (_label, args, argument) => {
    const { harness, client } = await start();
    const reply = await call(client, "request_upload", args);
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toContain(`"${argument}"`);
    expect(features(harness).tickets.size).toBe(0);
  });

  it("refuses when the inbox has no room, counting what is in it and what other tickets may still bring", async () => {
    const { harness, client } = await start({ inboxMaxBytes: 2500, maxUploadBytes: 1000 });
    expect((await call(client, "request_upload", { name: "a" })).isError).toBeUndefined();
    expect((await call(client, "request_upload", { name: "b" })).isError).toBeUndefined();
    const full = await call(client, "request_upload", { name: "c" });
    expect(full.isError).toBe(true);
    expect(textOf(full)).toContain("/work/inbox");
    expect(textOf(full)).toContain("operator");
    // A smaller reservation still fits.
    expect((await call(client, "request_upload", { name: "c", max_bytes: 400 })).isError).toBeUndefined();

    writeFileSync(join(features(harness).inboxDir, "already.bin"), Buffer.alloc(100));
    expect((await call(client, "request_upload", { name: "d", max_bytes: 100 })).isError).toBe(true);
  });

  it("refuses when 100 tickets are outstanding", async () => {
    const { harness, client } = await start();
    for (let i = 0; i < 100; i += 1) {
      const reply = await call(client, "request_upload", { name: `f${i}`, max_bytes: 1 });
      expect(reply.isError, `ticket ${i}`).toBeUndefined();
    }
    const reply = await call(client, "request_upload", { name: "one-more", max_bytes: 1 });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toContain("100");
    expect(features(harness).tickets.size).toBe(100);
  });
});

describe("upload_status", () => {
  it("reports pending, then receiving with progress, then failed when the client hangs up", async () => {
    const { harness, client } = await start();
    const out = object(await call(client, "request_upload", { name: "slow.bin", max_bytes: 1_000_000 }));
    expect(object(await call(client, "upload_status", { upload_id: out.upload_id })).state).toBe("pending");

    const pending = partialPut(Number(new URL(harness.origin).port), pathOf(out.upload_url), 500_000, Buffer.alloc(100_000, 1));
    let received = 0;
    for (let i = 0; i < 100 && received === 0; i += 1) {
      await sleep(20);
      received = Number(object(await call(client, "upload_status", { upload_id: out.upload_id })).bytes_received);
    }
    const during = object(await call(client, "upload_status", { upload_id: out.upload_id }));
    expect(during.state).toBe("receiving");
    expect(received).toBeGreaterThan(0);

    pending.socket.destroy();
    await pending.closed;
    let after = during;
    for (let i = 0; i < 100 && after.state === "receiving"; i += 1) {
      await sleep(20);
      after = object(await call(client, "upload_status", { upload_id: out.upload_id }));
    }
    expect(after).toMatchObject({ state: "failed", error: { code: "interrupted" } });
  });

  it("is an error for an id that is not an upload, including a download's", async () => {
    const { client } = await start({ resultInlineLimit: 5000 });
    expect((await call(client, "upload_status", { upload_id: "u_nothing" })).isError).toBe(true);
    const stub = object(await call(client, "big", { chars: 20_000 }));
    const download = object(await call(client, "request_download", { result_id: stub.result_id }));
    const reply = await call(client, "upload_status", { upload_id: download.download_id });
    expect(reply.isError).toBe(true);
  });

  it("refuses a missing or non-string id", async () => {
    const { client } = await start();
    expect((await call(client, "upload_status", {})).isError).toBe(true);
    expect((await call(client, "upload_status", { upload_id: 5 })).isError).toBe(true);
  });
});

describe("read_result", () => {
  const limit = 5000;

  it("pages through a result, never splitting a character, until the pages add up to the whole", async () => {
    const { client } = await start({ resultInlineLimit: limit });
    const text = bigText(30_000, true);
    const stub = object(await call(client, "big", { chars: 30_000, unicode: true }));
    expect(stub.stored).toBe(true);
    const total = Buffer.byteLength(text);
    expect(stub.bytes).toBe(total);

    const slices: string[] = [];
    let offset: number | null = 0;
    for (let guard = 0; offset !== null && guard < 1000; guard += 1) {
      const reply = await call(client, "read_result", { result_id: stub.result_id, offset, length: 777 });
      expect(reply.isError).toBeUndefined();
      const content = reply.content as { type: string; text: string }[];
      expect(content).toHaveLength(2);
      const meta = JSON.parse(content[0]?.text ?? "{}") as Record<string, number | null>;
      const slice = content[1]?.text ?? "";
      expect(meta.returned_bytes).toBe(Buffer.byteLength(slice));
      expect(meta.total_bytes).toBe(total);
      expect(meta.offset).toBe(offset);
      expect(slice).not.toContain("�");
      slices.push(slice);
      offset = meta.next_offset ?? null;
    }
    expect(offset).toBeNull();
    expect(slices.join("")).toBe(text);
  });

  it("returns the slice as it is, not escaped, and carries REA's untrusted-content marking", async () => {
    const { client } = await start({ resultInlineLimit: limit });
    const awkward = '"quoted" \\ back\\slash {"json":true}\n'.repeat(200);
    const stub = object(await call(client, "echo", { text: awkward }));
    expect(stub.truncated).toBe(true);
    const reply = await call(client, "read_result", { result_id: stub.result_id, offset: 0, length: 400 });
    const content = reply.content as { text: string }[];
    expect(content[1]?.text).toBe(awkward.slice(0, 400));
    expect(reply.isError).toBeUndefined();
  });

  it("keeps the _meta of the result it reads", async () => {
    const { client } = await start({ resultInlineLimit: limit });
    const stub = object(await call(client, "big", { chars: 20_000 }));
    const reply = await call(client, "read_result", { result_id: stub.result_id });
    expect(reply._meta).toEqual({ provenance: { untrusted_content: true, source: "analysis_target" } });
  });

  it("returns at most the inline limit, whether or not a length is given", async () => {
    const { client } = await start({ resultInlineLimit: limit });
    const stub = object(await call(client, "big", { chars: 30_000 }));
    for (const args of [{}, { length: 1_000_000 }]) {
      const reply = await call(client, "read_result", { result_id: stub.result_id, ...args });
      const meta = JSON.parse((reply.content as { text: string }[])[0]?.text ?? "{}") as { returned_bytes: number };
      expect(meta.returned_bytes).toBe(limit);
    }
  });

  it("ends with a null next_offset at exactly the end", async () => {
    const { client } = await start({ resultInlineLimit: limit });
    const stub = object(await call(client, "big", { chars: 6000 }));
    const reply = await call(client, "read_result", { result_id: stub.result_id, offset: 1000 });
    const meta = JSON.parse((reply.content as { text: string }[])[0]?.text ?? "{}") as { next_offset: number | null; returned_bytes: number };
    expect(meta).toMatchObject({ returned_bytes: 5000, next_offset: null });
  });

  it("is a tool error for an offset past the end, a bad offset or length, and a bad argument", async () => {
    const { client } = await start({ resultInlineLimit: limit });
    const stub = object(await call(client, "big", { chars: 6000 }));
    const id = stub.result_id;
    expect((await call(client, "read_result", { result_id: id, offset: 6001 })).isError).toBe(true);
    expect((await call(client, "read_result", { result_id: id, offset: 6000 })).isError).toBeUndefined();
    for (const args of [{ offset: -1 }, { offset: 1.5 }, { offset: "0" }, { length: 0 }, { length: -3 }, { length: 2.5 }, { extra: 1 }]) {
      const reply = await call(client, "read_result", { result_id: id, ...args });
      expect(reply.isError, JSON.stringify(args)).toBe(true);
    }
    expect((await call(client, "read_result", {})).isError).toBe(true);
  });

  it("gives the same error for an unknown id, a path, and another session's result", async () => {
    const { harness, client } = await start({ resultInlineLimit: limit });
    const other = await connectClient(harness);
    const stub = object(await call(other.client, "big", { chars: 20_000 }));
    const messages = new Set<string>();
    for (const id of [stub.result_id, "r_AAAAAAAAAAAAAAAA", "../../etc/passwd", "/etc/passwd", "r_../../../x", "", "r_" + "A".repeat(40)]) {
      const reply = await call(client, "read_result", { result_id: id });
      expect(reply.isError, String(id)).toBe(true);
      messages.add(textOf(reply));
    }
    // The same words for every one of them, so the answer does not tell which ids exist elsewhere. (A malformed
    // id is the one that names its argument; the others are indistinguishable from each other.)
    const lookups = [stub.result_id, "r_AAAAAAAAAAAAAAAA"].map(async (id) => textOf(await call(client, "read_result", { result_id: id })));
    expect(new Set(await Promise.all(lookups)).size).toBe(1);
    expect([...messages].every((message) => !message.includes("passwd"))).toBe(true);
  });
});

describe("request_download", () => {
  const limit = 5000;

  it("gives a URL from which the whole stored result downloads once, with the size and hash it promised", async () => {
    const { client } = await start({ resultInlineLimit: limit });
    const text = bigText(50_000, true);
    const stub = object(await call(client, "big", { chars: 50_000, unicode: true }));
    const out = object(await call(client, "request_download", { result_id: stub.result_id }));
    expect(out).toMatchObject({ result_id: stub.result_id, size: Buffer.byteLength(text), sha256: sha256(text), url_source: "Host header" });
    expect(out.curl_command).toBe(`curl -sS --fail-with-body -o <OUTPUT_FILE> '${String(out.download_url)}'`);

    const response = await fetch(String(out.download_url));
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString("utf8")).toBe(text);
    expect(sha256(body)).toBe(out.sha256);
    expect(response.headers.get("x-content-sha256")).toBe(out.sha256);
    expect(response.headers.get("content-disposition")).toContain("attachment");

    expect((await fetch(String(out.download_url))).status).toBe(409);
  });

  it("refuses an unknown id, a path, a file name and another session's result with the same words", async () => {
    const { harness, client } = await start({ resultInlineLimit: limit });
    const other = await connectClient(harness);
    const stub = object(await call(other.client, "big", { chars: 20_000 }));
    const texts = new Set<string>();
    for (const id of [stub.result_id, "r_AAAAAAAAAAAAAAAA", "../x", "/etc/passwd", "sample.bin", ""]) {
      const reply = await call(client, "request_download", { result_id: id });
      expect(reply.isError, String(id)).toBe(true);
      texts.add(textOf(reply));
    }
    expect(texts.size).toBe(1);
    expect(features(harness).tickets.size).toBe(0);
  });

  it("stops working when the session ends: the URL answers 404 and the file is gone", async () => {
    const { harness, client, transport } = await start({ resultInlineLimit: limit });
    const stub = object(await call(client, "big", { chars: 20_000 }));
    const out = object(await call(client, "request_download", { result_id: stub.result_id }));
    await transport.terminateSession();
    for (let i = 0; i < 100 && features(harness).tickets.find(String(out.download_id), "x") !== undefined; i += 1) await sleep(20);
    let status = 0;
    for (let i = 0; i < 100 && status !== 404; i += 1) {
      status = (await fetch(String(out.download_url))).status;
      if (status !== 404) await sleep(20);
    }
    expect(status).toBe(404);
  });
});

describe("a transfer and the idle reaper", () => {
  const idle = { idleTimeoutMs: 600, reapIntervalMs: 100 };

  it("does not end a session while its upload is still arriving, and starts counting again when it ends", async () => {
    const { harness, client } = await start({}, idle);
    const out = object(await call(client, "request_upload", { name: "long.bin", max_bytes: 1000 }));
    const port = Number(new URL(harness.origin).port);
    const upload = partialPut(port, pathOf(out.upload_url), 1000, Buffer.alloc(500, 1));
    await sleep(1500); // two and a half idle timeouts with no request from the client
    expect(harness.manager.size).toBe(1);

    upload.socket.write(Buffer.alloc(500, 2));
    for (let i = 0; i < 100 && object(await call(client, "upload_status", { upload_id: out.upload_id })).state !== "complete"; i += 1) await sleep(20);
    expect(harness.manager.size).toBe(1);

    for (let i = 0; i < 100 && harness.manager.size > 0; i += 1) await sleep(50);
    expect(harness.manager.size).toBe(0);
    upload.socket.destroy();
  });

  it("does end a session whose only ticket was never used", async () => {
    const { harness, client } = await start({}, idle);
    await call(client, "request_upload", { name: "never.bin" });
    for (let i = 0; i < 100 && harness.manager.size > 0; i += 1) await sleep(50);
    expect(harness.manager.size).toBe(0);
  });

  it("lets an upload finish after the session that asked for it has gone", async () => {
    const { harness, client } = await start({}, idle);
    const out = object(await call(client, "request_upload", { name: "orphan.bin", max_bytes: 100 }));
    for (let i = 0; i < 100 && harness.manager.size > 0; i += 1) await sleep(50);
    expect(harness.manager.size).toBe(0);
    expect((await put(out.upload_url, "still welcome")).status).toBe(200);
    expect(readFileSync(join(features(harness).inboxDir, "orphan.bin"), "utf8")).toBe("still welcome");
  });
});
