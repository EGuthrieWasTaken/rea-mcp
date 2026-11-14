// Long calls behind a proxy that cuts silent connections, and progress and
// cancellation on the way through. Real time is scaled 1:50: the 120 s call of the
// spec is 2.4 s here, the roughly 100 s origin idle limit is 2 s, and the 15 s
// keep-alive is 300 ms.
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_KEY, connectClient, startHarness, textOf, type Harness } from "./helpers/gateway.js";
import { startIdleProxy, type IdleProxy } from "./helpers/idle-proxy.js";
import { sleep } from "./helpers/fake-rea.js";

const CALL_MS = 2_400;
const PROXY_IDLE_MS = 2_000;
const KEEP_ALIVE_MS = 300;

const proxies: IdleProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

const proxyFor = async (harness: Harness): Promise<IdleProxy> => {
  const proxy = await startIdleProxy(Number(new URL(harness.url).port), PROXY_IDLE_MS);
  proxies.push(proxy);
  return proxy;
};

interface Streamed {
  text: string;
  /** True when the response ended normally rather than the connection being cut. */
  complete: boolean;
}

/** POST a tools/call through `port` and read the whole SSE response, whatever happens to it. */
const streamCall = (port: number, sessionId: string, params: Record<string, unknown>): Promise<Streamed> =>
  new Promise((resolve) => {
    let text = "";
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        agent: false, // a connection of its own, so a cut cannot affect anything else
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-api-key": HARNESS_KEY,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-06-18",
        },
      },
      (res) => {
        res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
        res.on("error", () => undefined);
        res.once("close", () => resolve({ text, complete: res.complete }));
      },
    );
    req.on("error", () => resolve({ text, complete: false }));
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/call", params }));
  });

const keepAlives = (text: string): number => text.match(/^: keepalive$/gm)?.length ?? 0;

describe("a long call behind a proxy that cuts silent connections", () => {
  it("survives, because keep-alive comments flow until the result arrives", async () => {
    const harness = await startHarness({ keepAliveMs: KEEP_ALIVE_MS });
    const proxy = await proxyFor(harness);
    const { client, transport } = await connectClient(harness);

    const streamed = await streamCall(proxy.port, transport.sessionId ?? "", { name: "slow", arguments: { ms: CALL_MS } });

    expect(streamed.complete).toBe(true);
    expect(proxy.cuts()).toBe(0);
    // About CALL_MS / KEEP_ALIVE_MS = 8 of them, all before the result, on the same stream.
    expect(keepAlives(streamed.text)).toBeGreaterThanOrEqual(5);
    expect(streamed.text.lastIndexOf(": keepalive")).toBeLessThan(streamed.text.indexOf('"result"'));
    expect(streamed.text).toContain('"text":"done"');
    await client.close();
  });

  it("is cut when nothing keeps the stream alive: the stub really does enforce its limit", async () => {
    // The control: the same call with keep-alives effectively off.
    const harness = await startHarness({ keepAliveMs: 600_000 });
    const proxy = await proxyFor(harness);
    const { client, transport } = await connectClient(harness);

    const streamed = await streamCall(proxy.port, transport.sessionId ?? "", { name: "slow", arguments: { ms: CALL_MS } });

    expect(streamed.complete).toBe(false);
    expect(proxy.cuts()).toBeGreaterThanOrEqual(1);
    expect(streamed.text).not.toContain('"result"');
    await client.close();
  });

  it("stops writing keep-alives once the stream has ended, and logs nothing amiss", async () => {
    const harness = await startHarness({ keepAliveMs: KEEP_ALIVE_MS });
    const proxy = await proxyFor(harness);
    const { client, transport } = await connectClient(harness);

    const streamed = await streamCall(proxy.port, transport.sessionId ?? "", { name: "slow", arguments: { ms: 700 } });
    expect(streamed.complete).toBe(true);
    const before = proxy.bytesFromUpstream();
    await sleep(KEEP_ALIVE_MS * 3);
    expect(proxy.bytesFromUpstream()).toBe(before);
    expect(harness.entries().filter((entry) => entry.level === "warn" || entry.level === "error")).toEqual([]);
    await client.close();
  });
});

describe("progress", () => {
  it("reaches the client that asked for it, before the result, with the client's own token", async () => {
    const harness = await startHarness();
    const { client } = await connectClient(harness);
    const seen: { progress: number; total?: number | undefined }[] = [];

    const result = await client.callTool({ name: "slow", arguments: { ms: 900, steps: 3 } }, undefined, {
      onprogress: (progress) => seen.push(progress),
    });

    expect(textOf(result)).toBe("done");
    // The SDK client only delivers a notification whose token matches its own request.
    expect(seen.map((progress) => progress.progress)).toEqual([1, 2, 3]);
    expect(seen.every((progress) => progress.total === 3)).toBe(true);
    await client.close();
  });

  it("keeps each request's progress on its own request, when several are running at once", async () => {
    const harness = await startHarness();
    const { client } = await connectClient(harness);
    const two: { total?: number | undefined }[] = [];
    const four: { total?: number | undefined }[] = [];

    await Promise.all([
      client.callTool({ name: "slow", arguments: { ms: 900, steps: 2 } }, undefined, { onprogress: (p) => two.push(p) }),
      client.callTool({ name: "slow", arguments: { ms: 900, steps: 4 } }, undefined, { onprogress: (p) => four.push(p) }),
    ]);

    expect(two).toHaveLength(2);
    expect(two.every((progress) => progress.total === 2)).toBe(true);
    expect(four).toHaveLength(4);
    expect(four.every((progress) => progress.total === 4)).toBe(true);
    await client.close();
  });

  it("preserves a string token and a numeric token exactly as the client sent them", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);
    const call = (token: string | number) =>
      new Promise<string>((resolve) => {
        const req = request(
          {
            host: new URL(harness.url).hostname,
            port: Number(new URL(harness.url).port),
            path: "/mcp",
            method: "POST",
            agent: false,
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "x-api-key": HARNESS_KEY,
              "mcp-session-id": transport.sessionId ?? "",
              "mcp-protocol-version": "2025-06-18",
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
            res.once("close", () => resolve(text));
          },
        );
        req.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "slow", arguments: { ms: 300, steps: 1 }, _meta: { progressToken: token } },
          }),
        );
      });

    expect(await call("tok-é✓")).toContain('"progressToken":"tok-é✓"');
    expect(await call(42)).toContain('"progressToken":42');
    await client.close();
  });
});

describe("cancellation", () => {
  it("is delivered to REA, which stops the work", async () => {
    const harness = await startHarness();
    const { client } = await connectClient(harness);
    const controller = new AbortController();
    const call = client.callTool({ name: "slow", arguments: { ms: 60_000 } }, undefined, { signal: controller.signal });
    await sleep(150);
    controller.abort();
    await expect(call).rejects.toBeDefined();

    await expect
      .poll(async () => JSON.parse(textOf(await client.callTool({ name: "stats" }))) as { cancelled: number; inFlight: number })
      .toEqual(expect.objectContaining({ cancelled: 1, inFlight: 0 }));
    await client.close();
  });
});
