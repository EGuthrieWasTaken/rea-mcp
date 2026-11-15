// The relay's three exceptions (spec: mcp-http-gateway, "MCP streamable HTTP endpoint"; result-paging): the tool list, the
// gateway's own tool calls, and oversized results. Everything runs through a real MCP client (the SDK's, which validates
// output schemas) against the fake REA.
import { existsSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionGateway } from "../src/gateway-tools/index.js";
import { resultSize } from "../src/results/replace.js";
import { closeHarnesses, connectClient, startHarness, textOf, type Harness } from "./helpers/gateway.js";

afterEach(closeHarnesses);

const GATEWAY_TOOLS = ["request_upload", "upload_status", "request_download", "read_result"];
const REA_TOOLS = ["echo", "slow", "crash", "env", "cwd", "pid", "grandchild", "log", "stats", "big"];

const json = (result: unknown): Record<string, unknown> => JSON.parse(textOf(result)) as Record<string, unknown>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The text a `big` call with this many characters returns. */
const bigText = (chars: number, unicode = false): string => {
  const unit = unicode ? "0123456789abcdef日" : "0123456789abcdef";
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
};

const files = (harness: Harness) => {
  if (harness.features === undefined) throw new Error("the harness was started without files");
  return harness.features;
};

describe("the tool list", () => {
  it("is REA's tools and the gateway's four, with no output schemas", async () => {
    const harness = await startHarness({ flags: ["--output-schemas"], files: {} });
    const { client } = await connectClient(harness);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...REA_TOOLS, ...GATEWAY_TOOLS]);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeUndefined();
  });

  it("keeps REA's output schemas, and still adds the gateway's tools, when replacement is off", async () => {
    const harness = await startHarness({ flags: ["--output-schemas"], files: { resultInlineLimit: 0 } });
    const { client } = await connectClient(harness);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...REA_TOOLS, ...GATEWAY_TOOLS]);
    for (const tool of tools.filter((candidate) => REA_TOOLS.includes(candidate.name))) expect(tool.outputSchema, tool.name).toBeDefined();
    for (const tool of tools.filter((candidate) => GATEWAY_TOOLS.includes(candidate.name))) expect(tool.outputSchema, tool.name).toBeUndefined();
  });

  it("describes each gateway tool with an input schema that forbids extra arguments", async () => {
    const harness = await startHarness({ files: {} });
    const { client } = await connectClient(harness);
    const { tools } = await client.listTools();
    for (const name of GATEWAY_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description?.length, name).toBeGreaterThan(40);
      expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("puts the gateway's tools on the last page of a paginated list", async () => {
    const harness = await startHarness({ flags: ["--paginate", "--output-schemas"], files: {} });
    const { client } = await connectClient(harness);
    const first = await client.listTools();
    expect(first.nextCursor).toBe("page2");
    expect(first.tools.map((tool) => tool.name)).toEqual(REA_TOOLS.slice(0, 3));
    const second = await client.listTools({ cursor: first.nextCursor });
    expect(second.nextCursor).toBeUndefined();
    expect(second.tools.map((tool) => tool.name)).toEqual([...REA_TOOLS.slice(3), ...GATEWAY_TOOLS]);
    for (const tool of [...first.tools, ...second.tools]) expect(tool.outputSchema, tool.name).toBeUndefined();
  });

  it("keeps the gateway's tool when REA reports one with the same name, and logs a warning", async () => {
    const harness = await startHarness({ flags: ["--extra-tool=read_result"], files: {} });
    const { client } = await connectClient(harness);
    const { tools } = await client.listTools();
    const named = tools.filter((tool) => tool.name === "read_result");
    expect(named).toHaveLength(1);
    expect(named[0]?.description).not.toContain("fake-rea");
    expect(harness.entries().some((entry) => entry.level === "warn" && entry.message === "REA reports a tool with a name the gateway keeps")).toBe(true);
  });

  it("is exactly REA's list when file transfer is not attached", async () => {
    const harness = await startHarness({ flags: ["--output-schemas"] });
    const { client } = await connectClient(harness);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(REA_TOOLS);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
  });
});

describe("the gateway's own tool calls", () => {
  it("are answered by the gateway and never reach REA", async () => {
    const harness = await startHarness({ files: {} });
    const { client } = await connectClient(harness);
    await client.callTool({ name: "read_result", arguments: { result_id: "r_AAAAAAAAAAAAAAAA" } });
    await client.callTool({ name: "upload_status", arguments: { upload_id: "u_nothing" } });
    await client.callTool({ name: "request_upload", arguments: { name: "a.bin" } });
    const stats = json(await client.callTool({ name: "stats", arguments: {} }));
    expect(stats.called).toEqual(["stats"]);
  });

  it("answer an unknown argument or a missing one as tool errors, not protocol errors", async () => {
    const harness = await startHarness({ files: {} });
    const { client } = await connectClient(harness);
    const unknown = await client.callTool({ name: "request_upload", arguments: { name: "a.bin", nope: 1 } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('"nope"');
    const missing = await client.callTool({ name: "upload_status", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('"upload_id"');
  });

  it("are answered exactly once when the session ends under them", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway: SessionGateway = {
      toolNames: new Set(["read_result"]),
      toolDefinitions: [{ name: "read_result", title: "t", description: "d", inputSchema: { type: "object" } }],
      inlineLimit: 0,
      callTool: async () => {
        await gate;
        return { content: [{ type: "text", text: "late" }] };
      },
      replaceOversized: () => Promise.resolve(undefined),
      busy: () => false,
      sessionEnded: () => Promise.resolve(),
    };
    const harness = await startHarness({ gateway });
    const { client, transport } = await connectClient(harness);
    const call = client.callTool({ name: "read_result", arguments: {} }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await sleep(100);
    await transport.terminateSession();
    const outcome = await call;
    expect("error" in outcome).toBe(true);
    release?.();
    await sleep(100);
    // Nothing further arrived, and the gateway did not log a second answer or a failure.
    expect(harness.entries().filter((entry) => entry.level === "error")).toEqual([]);
  });
});

describe("results over the limit", () => {
  it("are stored whole and replaced by a stub that a validating client accepts", async () => {
    const harness = await startHarness({ flags: ["--output-schemas"], files: { resultInlineLimit: 5000 } });
    const { client, transport } = await connectClient(harness);
    const reply = await client.callTool({ name: "big", arguments: { chars: 100_000 } });
    const stub = json(reply);
    expect(reply.structuredContent).toBeUndefined();
    expect(stub).toMatchObject({ truncated: true, reason: "result_too_large", tool: "big", chars: 100_000, bytes: 100_000, stored: true });
    expect(stub.preview).toBe(bigText(100_000).slice(0, 2000));
    expect(String(stub.note)).toContain("read_result");

    const stored = join(files(harness).resultsDir, transport.sessionId ?? "", `${String(stub.result_id)}.txt`);
    expect(readFileSync(stored, "utf8")).toBe(bigText(100_000));
  });

  it("are untouched at the limit and replaced one character over it", async () => {
    // What the fake REA returns for echo: content and structuredContent, both holding the text.
    const resultFor = (text: string) => ({ content: [{ type: "text", text }], structuredContent: { result: text } });
    const text = "x".repeat(3000);
    const size = resultSize(resultFor(text));

    const atLimit = await startHarness({ flags: ["--output-schemas"], files: { resultInlineLimit: size } });
    const a = await connectClient(atLimit);
    const unchanged = await a.client.callTool({ name: "echo", arguments: { text } });
    expect(textOf(unchanged)).toBe(text);
    expect(unchanged.structuredContent).toEqual({ result: text });

    const over = await startHarness({ flags: ["--output-schemas"], files: { resultInlineLimit: size - 1 } });
    const b = await connectClient(over);
    const replaced = await b.client.callTool({ name: "echo", arguments: { text } });
    expect(json(replaced).truncated).toBe(true);
  });

  it("pass through unchanged when small, with their structured content", async () => {
    const harness = await startHarness({ flags: ["--output-schemas"], files: { resultInlineLimit: 5000 } });
    const { client } = await connectClient(harness);
    const reply = await client.callTool({ name: "echo", arguments: { text: "small" } });
    expect(textOf(reply)).toBe("small");
    expect(reply.structuredContent).toEqual({ result: "small" });
  });

  it("keep REA's _meta and isError on the stub", async () => {
    const harness = await startHarness({ files: { resultInlineLimit: 5000 } });
    const { client } = await connectClient(harness);
    const reply = await client.callTool({ name: "big", arguments: { chars: 20_000, error: true } });
    expect(reply.isError).toBe(true);
    expect(reply._meta).toEqual({ provenance: { untrusted_content: true, source: "analysis_target" } });
    expect(json(reply).truncated).toBe(true);
  });

  it("are not replaced when REA answers with an error response", async () => {
    const harness = await startHarness({ files: { resultInlineLimit: 5000 } });
    const { client } = await connectClient(harness);
    await expect(client.callTool({ name: "no-such-tool", arguments: {} })).rejects.toThrow(/unknown tool/);
  });

  it("are relayed unchanged, with nothing stored, when replacement is off", async () => {
    const harness = await startHarness({ flags: ["--output-schemas"], files: { resultInlineLimit: 0 } });
    const { client } = await connectClient(harness);
    const reply = await client.callTool({ name: "big", arguments: { chars: 100_000 } });
    expect(textOf(reply)).toBe(bigText(100_000));
    expect(reply.structuredContent).toEqual({ result: bigText(100_000) });
    expect(readdirSync(files(harness).resultsDir)).toEqual([]);
  });

  it("are given to the client as REA sent them if the file cannot be written, with a warning that holds no content", async () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    const harness = await startHarness({ files: { resultInlineLimit: 5000 } });
    chmodSync(files(harness).resultsDir, 0o500);
    try {
      const { client } = await connectClient(harness);
      const reply = await client.callTool({ name: "big", arguments: { chars: 20_000 } });
      expect(textOf(reply)).toBe(bigText(20_000));
      const warning = harness.entries().find((entry) => entry.message === "could not store a large result; sending it as it is");
      expect(warning).toBeDefined();
      expect(harness.lines.join("")).not.toContain(bigText(200));
    } finally {
      chmodSync(files(harness).resultsDir, 0o700);
    }
  });

  it("get a stub that says they could not be stored when the session's store is full, and keep the preview", async () => {
    const harness = await startHarness({ files: { resultInlineLimit: 5000, sessionStoreLimitBytes: 50_000 } });
    const { client } = await connectClient(harness);
    const first = json(await client.callTool({ name: "big", arguments: { chars: 40_000 } }));
    expect(first.stored).toBe(true);
    const second = json(await client.callTool({ name: "big", arguments: { chars: 40_000 } }));
    expect(second).toMatchObject({ stored: false, result_id: null, truncated: true });
    expect(second.preview).toBe(bigText(40_000).slice(0, 2000));
  });

  it("are stored under the session that made them, and removed when it ends", async () => {
    const harness = await startHarness({ files: { resultInlineLimit: 5000 } });
    const { client, transport } = await connectClient(harness);
    await client.callTool({ name: "big", arguments: { chars: 20_000 } });
    const sessionDir = join(files(harness).resultsDir, transport.sessionId ?? "");
    expect(readdirSync(sessionDir)).toHaveLength(1);
    await transport.terminateSession();
    for (let i = 0; i < 100 && existsSync(sessionDir); i += 1) await sleep(20);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("do not keep a session from ending while they are being stored, and answer once", async () => {
    const harness = await startHarness({ files: { resultInlineLimit: 5000 } });
    const { client, transport } = await connectClient(harness);
    const call = client.callTool({ name: "big", arguments: { chars: 5_000_000 } }).then(
      () => "answered",
      () => "failed",
    );
    await transport.terminateSession();
    expect(["answered", "failed"]).toContain(await call);
    await sleep(200);
    // However the race went, no stored result outlives the session.
    const remaining = readdirSync(files(harness).resultsDir);
    expect(remaining).toEqual([]);
  });
});
