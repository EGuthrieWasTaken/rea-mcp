// Self-tests for the fake REA fixture: every later session, relay and termination
// test relies on these behaviours, so they are pinned here first.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRea, sleep } from "./helpers/fake-rea.js";

const started: FakeRea[] = [];
const grandchildren: number[] = [];
afterEach(async () => {
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.all(started.splice(0).map((rea) => rea.kill()));
});

const launch = (flags: string[] = [], options: { cwd?: string; env?: Record<string, string> } = {}): FakeRea => {
  const rea = FakeRea.start(flags, options);
  started.push(rea);
  return rea;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("fake REA: the MCP surface", () => {
  it("answers initialize and lists its tools", async () => {
    const rea = launch();
    const init = await rea.initialize();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "fake-rea" } });
    const { reply } = rea.request("tools/list");
    const names = ((await reply).result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(["echo", "slow", "crash", "env", "cwd", "pid", "grandchild", "log", "stats"]);
  });

  it("echoes text, reports its pid, and answers ping", async () => {
    const rea = launch();
    await rea.initialize();
    expect(await rea.call("echo", { text: "hello" })).toBe("hello");
    expect(await rea.call("pid")).toBe(String(rea.child.pid));
    expect((await rea.request("ping").reply).result).toEqual({});
  });

  it("answers an unknown method and an unknown tool with errors", async () => {
    const rea = launch();
    await rea.initialize();
    expect((await rea.request("no/such/method").reply).error?.code).toBe(-32601);
    expect((await rea.request("tools/call", { name: "nope" }).reply).error?.code).toBe(-32602);
  });

  it("reports the working directory it was started in", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fake-rea-")));
    try {
      const rea = launch([], { cwd: dir });
      await rea.initialize();
      expect(await rea.call("cwd")).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the environment it was given, and only that", async () => {
    const rea = launch([], { env: { FIXTURE_MARKER: "present" } });
    await rea.initialize();
    const seen = JSON.parse(await rea.call("env", { names: ["FIXTURE_MARKER", "REA_MCP_API_KEY", "HOME"] })) as Record<string, string>;
    expect(seen).toEqual({ FIXTURE_MARKER: "present" });
  });

  it("writes to stderr, which the gateway must capture", async () => {
    const rea = launch();
    await rea.waitForStderr("fake-rea: ready");
    await rea.initialize();
    await rea.call("log", { text: "a line from the child" });
    expect(rea.stderrLines).toContain("a line from the child");
  });
});

describe("fake REA: slow calls, progress and cancellation", () => {
  it("takes the time it is told to and reports progress before the result", async () => {
    const rea = launch();
    await rea.initialize();
    const began = Date.now();
    const result = await rea.call("slow", { ms: 300, steps: 3 }, { progressToken: "token-1" });
    expect(result).toBe("done");
    expect(Date.now() - began).toBeGreaterThanOrEqual(280);
    const progress = rea.notifications.filter((n) => n.method === "notifications/progress");
    expect(progress.map((n) => (n.params as { progress: number }).progress)).toEqual([1, 2, 3]);
    expect(progress.every((n) => (n.params as { progressToken: string }).progressToken === "token-1")).toBe(true);
  });

  it("sends no progress when the request has no progress token", async () => {
    const rea = launch();
    await rea.initialize();
    await rea.call("slow", { ms: 120, steps: 2 });
    expect(rea.notifications).toEqual([]);
  });

  it("stops a cancelled call and never answers it", async () => {
    const rea = launch();
    await rea.initialize();
    const { id, reply } = rea.request("tools/call", { name: "slow", arguments: { ms: 5_000 } });
    await sleep(50);
    rea.notify("notifications/cancelled", { requestId: id });
    expect(await Promise.race([reply.then(() => "answered"), sleep(400).then(() => "silent")])).toBe("silent");
    expect(JSON.parse(await rea.call("stats"))).toMatchObject({ cancelled: 1, inFlight: 0 });
  });
});

describe("fake REA: dying and refusing to die", () => {
  it("dies mid-call without answering, with the exit code it is given", async () => {
    const rea = launch();
    await rea.initialize();
    const { reply } = rea.request("tools/call", { name: "crash", arguments: { code: 7 } });
    expect((await rea.exited).code).toBe(7);
    expect(await Promise.race([reply.then(() => "answered"), sleep(100).then(() => "silent")])).toBe("silent");
  });

  it("spawns a grandchild that outlives a polite request to stop", async () => {
    const rea = launch();
    await rea.initialize();
    const pid = Number(await rea.call("grandchild"));
    grandchildren.push(pid);
    expect(alive(pid)).toBe(true);
    rea.endStdin();
    await rea.exited;
    expect(alive(pid)).toBe(true);
  });

  it("exits promptly with 0 when its stdin closes", async () => {
    const rea = launch();
    await rea.initialize();
    const began = Date.now();
    rea.endStdin();
    expect(await rea.exited).toEqual({ code: 0, signal: null });
    expect(Date.now() - began).toBeLessThan(1_500);
  });

  it("exits with 143 on SIGTERM, so a test can tell it from an exit after stdin EOF", async () => {
    const rea = launch();
    await rea.initialize();
    rea.signal("SIGTERM");
    expect(await rea.exited).toEqual({ code: 143, signal: null });
  });

  it("takes a configurable time to exit after stdin closes", async () => {
    const rea = launch(["--exit-delay-ms=500"]);
    await rea.initialize();
    const began = Date.now();
    rea.endStdin();
    expect((await rea.exited).code).toBe(0);
    expect(Date.now() - began).toBeGreaterThanOrEqual(450);
  });

  it("can ignore stdin EOF while still obeying SIGTERM", async () => {
    const rea = launch(["--ignore-eof"]);
    await rea.initialize();
    rea.endStdin();
    expect(await Promise.race([rea.exited.then(() => "exited"), sleep(400).then(() => "alive")])).toBe("alive");
    rea.signal("SIGTERM");
    expect(await rea.exited).toEqual({ code: 143, signal: null });
  });

  it("ignores both stdin EOF and SIGTERM, and only SIGKILL stops it", async () => {
    const rea = launch(["--ignore-signals"]);
    await rea.initialize();
    rea.endStdin();
    rea.signal("SIGTERM");
    expect(await Promise.race([rea.exited.then(() => "exited"), sleep(500).then(() => "alive")])).toBe("alive");
    rea.signal("SIGKILL");
    expect((await rea.exited).signal).toBe("SIGKILL");
  });

  it("can refuse to start, exiting 3 before answering anything", async () => {
    const rea = launch(["--fail-start"]);
    expect((await rea.exited).code).toBe(3);
    expect(rea.stderrLines.join("\n")).toContain("refusing to start");
  });

  it("can start slowly", async () => {
    const rea = launch(["--startup-delay-ms=300"]);
    const init = await rea.initialize();
    expect(init.result).toBeDefined();
    expect(Date.now() - rea.startedAt).toBeGreaterThanOrEqual(280);
  });
});
