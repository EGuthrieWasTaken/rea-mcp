import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFeatures } from "../src/features.js";
import { createLogger } from "../src/logger.js";
import { tempDir } from "./helpers/tmp.js";

const options = (workDir: string, lines: string[] = []) => ({
  logger: createLogger("debug", (line) => lines.push(line)),
  workDir,
  publicBaseUrl: undefined,
  trustProxy: false,
  maxUploadBytes: 1000,
  inboxMaxBytes: 10_000,
  ticketTtlSec: 900,
  resultInlineLimit: 40_000,
  sessionIdleTimeoutSec: 300,
});

describe("createFeatures at startup (task 2.2)", () => {
  it("creates /work/inbox and /work/results when they are missing", async () => {
    const work = tempDir("rea-mcp-work-");
    const features = await createFeatures(options(work));
    expect(statSync(join(work, "inbox")).isDirectory()).toBe(true);
    expect(statSync(join(work, "results")).isDirectory()).toBe(true);
    expect(features.inboxDir).toBe(join(work, "inbox"));
    expect(features.resultsDir).toBe(join(work, "results"));
  });

  it("removes unfinished uploads from an earlier run, keeps real files, and says how many it removed", async () => {
    const work = tempDir("rea-mcp-work-");
    mkdirSync(join(work, "inbox"));
    writeFileSync(join(work, "inbox", ".upload-0123456789abcdef.tmp"), "stray");
    writeFileSync(join(work, "inbox", "keep.bin"), "keep");
    const lines: string[] = [];
    await createFeatures(options(work, lines));
    expect(readdirSync(join(work, "inbox"))).toEqual(["keep.bin"]);
    const entry = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.message === "removed unfinished uploads left by an earlier run");
    expect(entry).toMatchObject({ count: 1 });
  });

  it("empties /work/results, which belongs to sessions that no longer exist", async () => {
    const work = tempDir("rea-mcp-work-");
    mkdirSync(join(work, "results", "11111111-2222-3333-4444-555555555555"), { recursive: true });
    writeFileSync(join(work, "results", "11111111-2222-3333-4444-555555555555", "r_old.txt"), "left over");
    writeFileSync(join(work, "results", "stray.txt"), "x");
    await createFeatures(options(work));
    expect(readdirSync(join(work, "results"))).toEqual([]);
  });

  it("rejects when the work directory cannot be used, so the gateway can say so and stop", async () => {
    const work = tempDir("rea-mcp-work-");
    writeFileSync(join(work, "inbox"), "a file where the directory should be");
    await expect(createFeatures(options(work))).rejects.toThrow();
    expect(existsSync(join(work, "results"))).toBe(false);
  });
});
