import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { ReaChild, TERM_WAIT_MS } from "../src/rea/child.js";
import { childEnvironment, type ReaLaunch } from "../src/rea/launch.js";
import { shutdownTiming } from "../src/sessions/timing.js";
import { sleep } from "./helpers/fake-rea.js";
import { HARNESS_KEY, connectClient, startHarness, textOf } from "./helpers/gateway.js";
import { FAKE_REA } from "./helpers/paths.js";
import { tempDir } from "./helpers/tmp.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const children: ReaChild[] = [];
const grandchildren: number[] = [];
afterEach(async () => {
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.all(children.splice(0).map((child) => child.terminate(0, 100)));
});

/** The real child wrapper, running the fake REA with the given flags. */
const launchChild = async (flags: string[]): Promise<ReaChild> => {
  const launch: ReaLaunch = { command: process.execPath, args: [FAKE_REA, ...flags], env: childEnvironment({ PATH: process.env.PATH }) };
  const child = await ReaChild.start(launch, tempDir(), createLogger("error", () => undefined), "test-session");
  children.push(child);
  return child;
};

/** Call a tool on a bare ReaChild and return the text of its answer. */
const callTool = (child: ReaChild, name: string): Promise<string> =>
  new Promise((resolve) => {
    child.onmessage = (message) => {
      if ("result" in message) resolve(((message.result.content as { text: string }[])[0]?.text) ?? "");
    };
    child.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
  });

describe("ReaChild.terminate: the sequence", () => {
  it("asks politely first: closing stdin is enough, and nothing is signalled", async () => {
    const child = await launchChild([]);
    const began = Date.now();
    expect(await child.terminate(5_000)).toBe("exited");
    expect(Date.now() - began).toBeLessThan(2_000);
    // 0 means it stopped on stdin EOF; a SIGTERM would have made the fixture exit 143.
    expect(child.exitStatus).toEqual({ code: 0, signal: null });
  });

  it("gives a child that is slow to exit its whole grace period, without signalling it", async () => {
    const child = await launchChild(["--exit-delay-ms=500"]);
    const began = Date.now();
    expect(await child.terminate(3_000)).toBe("exited");
    expect(Date.now() - began).toBeGreaterThanOrEqual(450);
    expect(child.exitStatus).toEqual({ code: 0, signal: null });
  });

  it("sends SIGTERM to a child that ignores stdin EOF", async () => {
    const child = await launchChild(["--ignore-eof"]);
    const began = Date.now();
    expect(await child.terminate(300, 3_000)).toBe("terminated");
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
    expect(child.exitStatus).toEqual({ code: 143, signal: null });
  });

  it("kills a child that ignores both, only after the grace period and the SIGTERM wait", async () => {
    const child = await launchChild(["--ignore-signals"]);
    const began = Date.now();
    expect(await child.terminate(300, 300)).toBe("killed");
    expect(Date.now() - began).toBeGreaterThanOrEqual(550);
    expect(child.exitStatus?.signal).toBe("SIGKILL");
  });

  it("does not stretch the grace period for a child that would take longer", async () => {
    const child = await launchChild(["--exit-delay-ms=3000"]);
    expect(await child.terminate(300, 300)).toBe("killed");
  });

  it("uses a 2 second SIGTERM wait unless told otherwise", () => {
    expect(TERM_WAIT_MS).toBe(2_000);
  });
});

describe("ReaChild.terminate: nothing it started survives", () => {
  it("kills a grandchild even when REA itself exits politely", async () => {
    const child = await launchChild([]);
    const grandchild = Number(await callTool(child, "grandchild"));
    grandchildren.push(grandchild);
    expect(alive(grandchild)).toBe(true);

    expect(await child.terminate(5_000)).toBe("exited");
    expect(child.exitStatus).toEqual({ code: 0, signal: null });
    // A killed process stays visible until its parent is reaped, so poll.
    await expect.poll(() => alive(grandchild), { timeout: 5_000 }).toBe(false);
  });

  it("kills a grandchild along with a child that had to be killed", async () => {
    const child = await launchChild(["--ignore-signals"]);
    const grandchild = Number(await callTool(child, "grandchild"));
    grandchildren.push(grandchild);
    expect(await child.terminate(200, 200)).toBe("killed");
    await expect.poll(() => alive(grandchild), { timeout: 5_000 }).toBe(false);
  });

  it("still clears out the grandchild of a child that has already died", async () => {
    const child = await launchChild([]);
    const grandchild = Number(await callTool(child, "grandchild"));
    grandchildren.push(grandchild);
    child.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crash", arguments: { code: 4 } } });
    expect((await child.exited).code).toBe(4);
    expect(alive(grandchild)).toBe(true);

    expect(await child.terminate(5_000)).toBe("exited");
    await expect.poll(() => alive(grandchild), { timeout: 5_000 }).toBe(false);
  });
});

describe("ending a session", () => {
  it("lets REA finish within the grace period, as with a checkpoint to save", async () => {
    // Scaled: a REA that needs 700 ms to exit, a grace period that allows 3 s.
    const harness = await startHarness({ flags: ["--exit-delay-ms=700"], terminationGraceMs: 3_000 });
    const { client, transport } = await connectClient(harness);
    await transport.terminateSession();
    await expect.poll(() => harness.entries().some((entry) => entry.message === "REA stopped"), { timeout: 8_000 }).toBe(true);
    expect(harness.entries().find((entry) => entry.message === "REA stopped")).toMatchObject({ reason: "exited", exitCode: 0 });
    await client.close();
  });

  it("kills REA that outlasts the grace period", async () => {
    const harness = await startHarness({ flags: ["--exit-delay-ms=5000"], terminationGraceMs: 200, termSignalWaitMs: 200 });
    const { transport } = await connectClient(harness);
    await transport.terminateSession();
    await expect.poll(() => harness.entries().some((entry) => entry.message === "REA stopped"), { timeout: 8_000 }).toBe(true);
    expect(harness.entries().find((entry) => entry.message === "REA stopped")).toMatchObject({ reason: "killed", signal: "SIGKILL" });
  });

  it("leaves no grandchild running", async () => {
    const harness = await startHarness();
    const { client, transport } = await connectClient(harness);
    const grandchild = Number(textOf(await client.callTool({ name: "grandchild" })));
    grandchildren.push(grandchild);
    expect(alive(grandchild)).toBe(true);
    await transport.terminateSession();
    await expect.poll(() => alive(grandchild), { timeout: 8_000 }).toBe(false);
  });
});

describe("gateway shutdown", () => {
  it("stops every session's REA in parallel, not one after another", async () => {
    const harness = await startHarness({ flags: ["--exit-delay-ms=500"], terminationGraceMs: 3_000, maxSessions: 4 });
    const connected = await Promise.all([1, 2, 3, 4].map(() => connectClient(harness)));
    const pids = await Promise.all(connected.map(async ({ client }) => Number(textOf(await client.callTool({ name: "pid" })))));

    const began = Date.now();
    await harness.manager.closeAll();
    // Four children that each take 500 ms: in parallel that is about 500 ms, one by one 2 s.
    expect(Date.now() - began).toBeLessThan(1_400);
    expect(harness.manager.size).toBe(0);
    await expect.poll(() => pids.some(alive), { timeout: 5_000 }).toBe(false);
  });

  it("refuses a new session once shutdown has begun, and starts no REA", async () => {
    const harness = await startHarness();
    const { client } = await connectClient(harness);
    const attempts = harness.manager.spawnAttempts;
    harness.manager.beginShutdown();

    const refused = await fetch(harness.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": HARNESS_KEY },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "late", version: "0" } },
      }),
    });
    expect(refused.status).toBe(503);
    expect(harness.manager.spawnAttempts).toBe(attempts);
    // Sessions already live are untouched until they are closed.
    expect(textOf(await client.callTool({ name: "echo", arguments: { text: "still up" } }))).toBe("still up");
    await sleep(10);
  });
});

describe("shutdown timing", () => {
  it("fits inside Docker's default 10 second stop timeout without checkpointing", () => {
    const { graceMs, budgetMs } = shutdownTiming(false);
    expect(graceMs).toBe(5_000);
    expect(budgetMs).toBeLessThanOrEqual(10_000);
    expect(budgetMs).toBeGreaterThan(graceMs + TERM_WAIT_MS);
  });

  it("allows 30 seconds to stop REA, and 40 in all, with checkpointing", () => {
    const { graceMs, budgetMs } = shutdownTiming(true);
    expect(graceMs).toBe(30_000);
    expect(budgetMs).toBe(40_000);
    expect(budgetMs).toBeGreaterThan(graceMs + TERM_WAIT_MS);
  });
});
