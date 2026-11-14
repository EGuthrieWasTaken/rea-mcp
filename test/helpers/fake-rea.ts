import { spawn, type ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { FAKE_REA } from "./paths.js";

export interface Reply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The fake REA fixture, driven directly over stdio. */
export class FakeRea {
  readonly child: ChildProcess;
  readonly stderrLines: string[] = [];
  readonly notifications: Record<string, unknown>[] = [];
  readonly exited: Promise<Exit>;
  readonly startedAt = Date.now();
  private nextId = 1;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private readonly buffer = new ReadBuffer();
  private stderrBuffer = "";

  private constructor(flags: string[], options: { cwd?: string; env?: Record<string, string> }) {
    this.child = spawn(process.execPath, [FAKE_REA, ...flags], {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        const message = this.buffer.readMessage();
        if (message === null) break;
        this.onMessage(message);
      }
    });
    this.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      let newline: number;
      while ((newline = this.stderrBuffer.indexOf("\n")) >= 0) {
        this.stderrLines.push(this.stderrBuffer.slice(0, newline));
        this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      }
    });
    this.child.stdin?.on("error", () => undefined);
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  static start(flags: string[] = [], options: { cwd?: string; env?: Record<string, string> } = {}): FakeRea {
    return new FakeRea(flags, options);
  }

  private onMessage(message: JSONRPCMessage): void {
    if ("id" in message && ("result" in message || "error" in message)) {
      const resolve = this.pending.get(Number(message.id));
      this.pending.delete(Number(message.id));
      resolve?.(message);
    } else {
      this.notifications.push(message);
    }
  }

  private write(message: JSONRPCMessage): void {
    this.child.stdin?.write(serializeMessage(message));
  }

  /** Send a request and wait for its reply. Never settles if the fixture never answers. */
  request(method: string, params?: Record<string, unknown>): { id: number; reply: Promise<Reply> } {
    const id = this.nextId++;
    const reply = new Promise<Reply>((resolve) => this.pending.set(id, resolve));
    this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return { id, reply };
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async initialize(): Promise<Reply> {
    const { reply } = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const answer = await reply;
    this.notify("notifications/initialized");
    return answer;
  }

  /** Call a tool and return the text of its first content item. */
  async call(name: string, toolArguments: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<string> {
    const { reply } = this.request("tools/call", {
      name,
      arguments: toolArguments,
      ...(meta === undefined ? {} : { _meta: meta }),
    });
    const answer = await reply;
    const content = answer.result?.content as { text: string }[] | undefined;
    return content?.[0]?.text ?? JSON.stringify(answer);
  }

  endStdin(): void {
    this.child.stdin?.end();
  }

  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  /** Resolve with the first stderr line containing `needle`. */
  async waitForStderr(needle: string, timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.stderrLines.find((line) => line.includes(needle));
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`no stderr line containing ${needle}: ${JSON.stringify(this.stderrLines)}`);
      await sleep(10);
    }
  }

  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }
}
