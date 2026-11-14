import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { BUILT_MAIN } from "./paths.js";

export interface LogLine {
  time?: string;
  level?: string;
  message?: string;
  [field: string]: unknown;
}

/** Parse stdout as JSON lines; throws if any non-empty line is not a JSON object. */
export const parseLogLines = (stdout: string): LogLine[] =>
  stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LogLine);

/**
 * Run the real built entry point to completion with exactly the given environment
 * (plus PATH), for cases where it is expected to exit by itself.
 */
export const startGateway = (env: Record<string, string>) =>
  spawnSync(process.execPath, [BUILT_MAIN], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });

/** An unused TCP port. Racy by nature, but good enough for tests that start one process. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The real built gateway as a long-running child process. */
export class GatewayProcess {
  readonly lines: LogLine[] = [];
  /** Lines on stdout that were not JSON objects. Should always stay empty. */
  readonly invalid: string[] = [];
  stderr = "";
  readonly exited: Promise<Exit>;
  private readonly child: ChildProcess;
  private buffer = "";
  private readonly waiters: (() => void)[] = [];

  private constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [BUILT_MAIN], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const text = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        try {
          this.lines.push(JSON.parse(text) as LogLine);
        } catch {
          this.invalid.push(text);
        }
      }
      this.waiters.splice(0).forEach((wake) => wake());
    });
    this.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.waiters.splice(0).forEach((wake) => wake());
        resolve({ code, signal });
      });
    });
  }

  static start(env: Record<string, string>): GatewayProcess {
    return new GatewayProcess(env);
  }

  /** Resolves with the first log line matching `predicate`, now or later. */
  async waitForLog(predicate: (line: LogLine) => boolean, timeoutMs = 10_000): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find(predicate);
      if (found !== undefined) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for a log line; saw: ${JSON.stringify(this.lines)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Send a signal and wait for the process to exit. */
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<Exit> {
    this.child.kill(signal);
    return this.exited;
  }

  /** Make sure the process is gone, whatever state a failed test left it in. */
  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }
}
