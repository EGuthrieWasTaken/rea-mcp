// Spike for task 3.6, kept as a regression guard. Design D7 and the keep-alive spec
// rely on three behaviours of the MCP SDK's streamable HTTP server transport. If an
// SDK upgrade changes any of them, these tests fail before the gateway misbehaves.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_SSE_KEEP_ALIVE_MS } from "@modelcontextprotocol/sdk/server/sseKeepAlive.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isJSONRPCRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spike", version: "0" } },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * A relay-shaped fixture: whatever "REA" would answer is produced by `reply`, `delayMs`
 * after the request arrives. Returns the URL to POST to.
 */
const serve = async (
  keepAliveMs: number,
  delayMs: number,
  reply: (request: { id: string | number }, send: (message: JSONRPCMessage, relatedRequestId?: string | number) => void) => void,
): Promise<string> => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), keepAliveMs });
  await transport.start();
  const send = (message: JSONRPCMessage, relatedRequestId?: string | number): void => {
    void transport.send(message, relatedRequestId === undefined ? undefined : { relatedRequestId });
  };
  transport.onmessage = (message) => {
    if (isJSONRPCRequest(message)) setTimeout(() => reply({ id: message.id }, send), delayMs);
  };
  const server: Server = createServer((req, res) => void transport.handleRequest(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
};

const post = (url: string): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(INITIALIZE),
  });

/** Read the SSE stream as text until the JSON-RPC result has arrived. */
const readUntilResult = async (response: Response): Promise<string> => {
  if (response.body === null) throw new Error("no response body");
  const decoder = new TextDecoder();
  let text = "";
  // Leaving the loop cancels the stream.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes('"result"')) break;
  }
  return text;
};

describe("MCP SDK streamable HTTP server transport", () => {
  it("defaults to a 15 second keep-alive, the interval the spec asks for", () => {
    expect(DEFAULT_SSE_KEEP_ALIVE_MS).toBe(15_000);
  });

  it("answers a POST with an SSE stream that carries keep-alive comments until the result is ready", async () => {
    const url = await serve(100, 550, ({ id }, send) => send({ jsonrpc: "2.0", id, result: { ok: true } }));
    const response = await post(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("mcp-session-id")).not.toBeNull();
    const text = await readUntilResult(response);
    // Comment frames arrived while nothing else was being written...
    expect(text.match(/^: keepalive$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // ...and strictly before the result, on the same stream.
    expect(text.indexOf(": keepalive")).toBeLessThan(text.indexOf("event: message"));
    expect(text).toContain('"result":{"ok":true}');
  });

  it("puts a notification on the request's stream only when it is given the request id", async () => {
    const url = await serve(60_000, 100, ({ id }, send) => {
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "with-related-id", progress: 1 } }, id);
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "without-related-id", progress: 1 } });
      send({ jsonrpc: "2.0", id, result: { ok: true } });
    });
    const text = await readUntilResult(await post(url));
    expect(text).toContain("with-related-id");
    // Without the id the notification belongs to the standalone GET stream, which this
    // client never opened, so it is not on the POST stream. The relay must therefore
    // map progress tokens back to request ids (task 3.15).
    expect(text).not.toContain("without-related-id");
  });
});
