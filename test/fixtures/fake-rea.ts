// A fake stdio MCP server standing in for REA in tests. It speaks real MCP framing
// (newline-delimited JSON-RPC, via the SDK's own helpers) and is controlled by
// command-line flags, because the gateway starts it with an allowlisted environment.
//
//   --fail-start              exit 3 immediately, before answering anything
//   --startup-delay-ms=N      wait N ms before reading stdin
//   --ignore-signals          ignore stdin EOF and SIGTERM: only SIGKILL stops it
//   --ignore-eof              ignore stdin EOF only: SIGTERM still stops it
//   --exit-delay-ms=N         after stdin EOF or SIGTERM, wait N ms, then exit
//                             (stands in for REA saving a checkpoint on close)
//   --output-schemas          every tool declares a strict outputSchema and every result carries a matching
//                             structuredContent, as REA's do (docs/DESIGN.md 18)
//   --paginate                tools/list answers in two pages, the first with a nextCursor
//   --extra-tool=NAME         one more tool, with this name (for a clash with the gateway's own tools)
//
// Exit codes tell a test what stopped it: 0 after stdin EOF, 143 after SIGTERM.
//
// Tools: echo, slow, crash, env, cwd, pid, grandchild, log, stats, big.
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
const strictResults = flag("output-schemas");
const text = (value: string): Params =>
  strictResults
    ? { content: [{ type: "text", text: value }], structuredContent: { result: value } }
    : { content: [{ type: "text", text: value }] };
// Tool arguments arrive as JSON, so anything may be in them: take only real strings.
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const extraTool = args.find((argument) => argument.startsWith("--extra-tool="))?.split("=")[1];
const TOOLS = ["echo", "slow", "crash", "env", "cwd", "pid", "grandchild", "log", "stats", "big", ...(extraTool === undefined ? [] : [extraTool])].map(
  (name) => ({
    name,
    description: `fake-rea tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...(strictResults
      ? {
          outputSchema: {
            type: "object",
            properties: { result: { type: "string" } },
            required: ["result"],
            additionalProperties: false,
          },
        }
      : {}),
  }),
);

const counters = { requests: 0, cancelled: 0 };
// The names of the tools it has been asked to call, in order.
const called: string[] = [];
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
  called.push(name);
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
      reply(id, text(JSON.stringify({ ...counters, inFlight: inFlight.size, called })));
      return;
    case "big": {
      // A result of `chars` characters, as REA's are when nothing limits them, carrying REA's untrusted-content marking.
      // `unicode` puts a three-byte character at every tenth position; `error` makes it an error result.
      const chars = Number(toolArguments.chars ?? 100_000);
      const unit = toolArguments.unicode === true ? "0123456789abcdef日" : "0123456789abcdef";
      const body = unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
      const result = text(body);
      reply(id, {
        ...result,
        _meta: { provenance: { untrusted_content: true, source: "analysis_target" } },
        ...(toolArguments.error === true ? { isError: true } : {}),
      });
      return;
    }
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
      if (flag("paginate")) {
        const second = params.cursor === "page2";
        reply(message.id, second ? { tools: TOOLS.slice(3) } : { tools: TOOLS.slice(0, 3), nextCursor: "page2" });
      } else {
        reply(message.id, { tools: TOOLS });
      }
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
const shutDown = (code: number): void => {
  if (flag("ignore-signals")) return;
  setTimeout(() => process.exit(code), exitDelay);
};

process.on("SIGTERM", () => shutDown(143));
if (flag("ignore-signals") || flag("ignore-eof")) setInterval(() => undefined, 1_000); // stay alive after EOF

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
  process.stdin.on("end", () => {
    if (!flag("ignore-eof")) shutDown(0);
  });
};

const startupDelay = numberFlag("startup-delay-ms");
if (startupDelay === undefined) start();
else setTimeout(start, startupDelay);
