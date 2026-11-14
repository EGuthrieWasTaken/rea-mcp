// A fake stdio MCP server standing in for REA in tests. It speaks real MCP framing
// (newline-delimited JSON-RPC, via the SDK's own helpers) and is controlled by
// command-line flags, because the gateway starts it with an allowlisted environment.
//
//   --fail-start              exit 3 immediately, before answering anything
//   --startup-delay-ms=N      wait N ms before reading stdin
//   --ignore-signals          ignore stdin EOF and SIGTERM: only SIGKILL stops it
//   --exit-delay-ms=N         after stdin EOF or SIGTERM, wait N ms, then exit 0
//                             (stands in for REA saving a checkpoint on close)
//
// Tools: echo, slow, crash, env, cwd, pid, grandchild, log, stats.
import { spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const numberFlag = (name: string): number | undefined => {
  const found = args.find((argument) => argument.startsWith(`--${name}=`));
  return found === undefined ? undefined : Number(found.split("=")[1]);
};

type Params = Record<string, unknown>;

const send = (message: JSONRPCMessage): void => {
  process.stdout.write(serializeMessage(message));
};
const reply = (id: RequestId, result: Params): void => send({ jsonrpc: "2.0", id, result });
const fail = (id: RequestId, code: number, message: string): void =>
  send({ jsonrpc: "2.0", id, error: { code, message } });
const text = (value: string): Params => ({ content: [{ type: "text", text: value }] });
// Tool arguments arrive as JSON, so anything may be in them: take only real strings.
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const TOOLS = ["echo", "slow", "crash", "env", "cwd", "pid", "grandchild", "log", "stats"].map((name) => ({
  name,
  description: `fake-rea tool ${name}`,
  inputSchema: { type: "object", properties: {} },
}));

const counters = { requests: 0, cancelled: 0 };
// Cancel handlers for requests that are still in flight, by request id.
const inFlight = new Map<RequestId, () => void>();

const slow = (id: RequestId, params: Params, progressToken: unknown): void => {
  const total = Number(params.ms ?? 1000);
  const steps = Number(params.steps ?? 0);
  const timers: NodeJS.Timeout[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const at = (total * step) / (steps + 1);
    timers.push(
      setTimeout(() => {
        if (progressToken !== undefined) {
          send({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: progressToken as string | number, progress: step, total: steps },
          });
        }
      }, at),
    );
  }
  timers.push(
    setTimeout(() => {
      inFlight.delete(id);
      reply(id, text("done"));
    }, total),
  );
  inFlight.set(id, () => timers.forEach(clearTimeout));
};

const callTool = (id: RequestId, params: Params): void => {
  const name = String(params.name);
  const toolArguments = (params.arguments ?? {}) as Params;
  const progressToken = (params._meta as Params | undefined)?.progressToken;
  switch (name) {
    case "echo":
      reply(id, text(asString(toolArguments.text)));
      return;
    case "slow":
      slow(id, toolArguments, progressToken);
      return;
    case "crash":
      // Dies without answering, as a REA that is killed or crashes mid-call would.
      process.exit(Number(toolArguments.code ?? 1));
      return;
    case "env": {
      const wanted = Array.isArray(toolArguments.names) ? (toolArguments.names as string[]) : undefined;
      const entries = Object.entries(process.env).filter(([key]) => wanted === undefined || wanted.includes(key));
      reply(id, text(JSON.stringify(Object.fromEntries(entries))));
      return;
    }
    case "cwd":
      reply(id, text(process.cwd()));
      return;
    case "pid":
      reply(id, text(String(process.pid)));
      return;
    case "grandchild": {
      // A child that outlives a polite request to stop, to test group termination.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      reply(id, text(String(child.pid)));
      return;
    }
    case "log":
      process.stderr.write(`${asString(toolArguments.text)}\n`);
      reply(id, text("logged"));
      return;
    case "stats":
      reply(id, text(JSON.stringify({ ...counters, inFlight: inFlight.size })));
      return;
    default:
      fail(id, -32602, `unknown tool ${name}`);
  }
};

const handle = (message: JSONRPCMessage): void => {
  if (isJSONRPCNotification(message)) {
    if (message.method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        counters.cancelled += 1;
        inFlight.get(requestId)?.();
        inFlight.delete(requestId);
      }
    }
    return;
  }
  if (!isJSONRPCRequest(message)) return;
  counters.requests += 1;
  const params = (message.params ?? {}) as Params;
  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fake-rea", version: "0.0.0" },
      });
      return;
    case "tools/list":
      reply(message.id, { tools: TOOLS });
      return;
    case "tools/call":
      callTool(message.id, params);
      return;
    case "ping":
      reply(message.id, {});
      return;
    default:
      fail(message.id, -32601, "method not found");
  }
};

// ---------------------------------------------------------------- lifecycle

if (flag("fail-start")) {
  process.stderr.write("fake-rea: refusing to start\n");
  process.exit(3);
}

const exitDelay = numberFlag("exit-delay-ms") ?? 0;
const shutDown = (): void => {
  if (flag("ignore-signals")) return;
  setTimeout(() => process.exit(0), exitDelay);
};

process.on("SIGTERM", shutDown);
if (flag("ignore-signals")) setInterval(() => undefined, 1_000); // keep the event loop alive after EOF

const start = (): void => {
  process.stderr.write("fake-rea: ready\n");
  const buffer = new ReadBuffer();
  process.stdin.on("data", (chunk: Buffer) => {
    buffer.append(chunk);
    for (;;) {
      const message = buffer.readMessage();
      if (message === null) break;
      handle(message);
    }
  });
  process.stdin.on("end", shutDown);
};

const startupDelay = numberFlag("startup-delay-ms");
if (startupDelay === undefined) start();
else setTimeout(start, startupDelay);
