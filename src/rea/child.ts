// One REA child process and its stdio JSON-RPC channel (design D1, D6, D8).
//
// The child is started by this module and not by the SDK's StdioClientTransport,
// which fixes its own environment and shutdown sequence. Here it is spawned with no
// shell, exactly the environment it is given, and in its own process group so that
// ending a session can signal REA and every process REA started (such as Ghidra).
// Only the SDK's framing helpers are reused.
import { spawn, type ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.js";
import type { ReaLaunch } from "./launch.js";

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** How many of the child's last stderr lines are kept for diagnostics. */
const STDERR_TAIL_LINES = 20;
/** After the process exits, wait this long for its last output before reporting it. */
const DRAIN_MS = 100;

export class ReaChild {
  /** Called for each JSON-RPC message the child writes. */
  onmessage: ((message: JSONRPCMessage) => void) | undefined;
  /** Called once, after the child has exited and its output has been delivered. */
  onexit: ((exit: ChildExit) => void) | undefined;
  /** Resolves as soon as the process has exited. */
  readonly exited: Promise<ChildExit>;

  readonly pid: number | undefined;
  private exit: ChildExit | undefined;
  private readonly stderrTail: string[] = [];
  private stderrBuffer = "";

  private constructor(
    private readonly proc: ChildProcess,
    private readonly logger: Logger,
    private readonly sessionId: string,
  ) {
    this.pid = proc.pid;
    const stdout = new ReadBuffer();

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = stdout.readMessage();
        } catch {
          // A line that is not a JSON-RPC message: it is already consumed; skip it.
          this.logger.warn("invalid message from REA", { sessionId: this.sessionId, pid: this.pid });
          continue;
        }
        if (message === null) break;
        try {
          this.onmessage?.(message);
        } catch (error) {
          this.logger.error("handling a message from REA failed", {
            sessionId: this.sessionId,
            reason: error instanceof Error ? error.name : "unknown error",
          });
        }
      }
    });

    proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      let newline: number;
      while ((newline = this.stderrBuffer.indexOf("\n")) >= 0) {
        this.recordStderr(this.stderrBuffer.slice(0, newline));
        this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      }
    });

    // Errors on these streams (a write to a child that already died) must never
    // become uncaught exceptions; the exit is reported through `exited`.
    proc.stdin?.on("error", () => undefined);
    proc.on("error", (error) => {
      this.logger.warn("REA process error", { sessionId: this.sessionId, pid: this.pid, reason: error.name });
    });

    this.exited = new Promise<ChildExit>((resolve) => {
      proc.once("exit", (code, signal) => {
        this.exit = { code, signal };
        resolve(this.exit);
        // `close` can be held up by a grandchild that kept the pipes open, so report
        // on `exit`, after giving the last output a moment to arrive.
        let reported = false;
        const report = (): void => {
          if (reported) return;
          reported = true;
          if (this.stderrBuffer !== "") this.recordStderr(this.stderrBuffer);
          this.stderrBuffer = "";
          this.onexit?.(this.exit as ChildExit);
        };
        proc.stdout?.once("end", report);
        setTimeout(report, DRAIN_MS).unref();
      });
    });
  }

  /**
   * Start `launch` in `cwd`. Resolves once the process exists; rejects with the spawn
   * error (for example ENOENT) when it cannot be started.
   */
  static start(launch: ReaLaunch, cwd: string, logger: Logger, sessionId: string): Promise<ReaChild> {
    return new Promise((resolve, reject) => {
      const proc = spawn(launch.command, [...launch.args], {
        cwd,
        env: { ...launch.env },
        shell: false,
        detached: true, // its own process group: see signalGroup
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const child = new ReaChild(proc, logger, sessionId);
      proc.once("error", reject);
      proc.once("spawn", () => {
        proc.off("error", reject);
        resolve(child);
      });
    });
  }

  /** Write a JSON-RPC message to the child's stdin. Throws if the channel is closed. */
  send(message: JSONRPCMessage): void {
    const stdin = this.proc.stdin;
    if (stdin === null || !stdin.writable) throw new Error("the REA process is not accepting input");
    stdin.write(serializeMessage(message));
  }

  /** End the child's stdin, which REA treats as a request to shut down. */
  closeStdin(): void {
    this.proc.stdin?.end();
  }

  /** Signal the child's whole process group. False if there was nothing to signal. */
  signalGroup(signal: NodeJS.Signals): boolean {
    if (this.pid === undefined || this.exit !== undefined) return false;
    try {
      process.kill(-this.pid, signal);
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        this.logger.warn("could not signal REA", { sessionId: this.sessionId, pid: this.pid, signal });
      }
      return false;
    }
  }

  /** Stop the child and everything it started. Task 3.14 replaces this with the graceful sequence. */
  async terminate(): Promise<void> {
    this.signalGroup("SIGKILL");
    await this.exited;
  }

  /** The last few lines the child wrote to stderr, for diagnostics. */
  get stderrLines(): readonly string[] {
    return this.stderrTail;
  }

  private recordStderr(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
    this.logger.debug("REA stderr", { sessionId: this.sessionId, pid: this.pid, stream: "stderr", line });
  }
}
