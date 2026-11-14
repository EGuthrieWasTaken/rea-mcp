import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BUILT_MAIN } from "./helpers/paths.js";

// Start the real entry point with exactly one bad variable and nothing else, so
// the result cannot depend on the environment of the test runner.
const start = (env: Record<string, string>) =>
  spawnSync(process.execPath, [BUILT_MAIN], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });

describe("gateway startup with an unparsable setting", () => {
  const cases: [string, string][] = [
    ["PORT", "abc"],
    ["PORT", "70000"],
    ["MAX_SESSIONS", "lots"],
    ["SESSION_IDLE_TIMEOUT_SEC", "-5"],
    ["TRUST_PROXY", "maybe"],
    ["LOG_LEVEL", "loud"],
    ["ALLOWED_HOSTS", "http://bad"],
  ];

  it.each(cases)("exits non-zero and names %s for %j", (name, value) => {
    const result = start({ [name]: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid configuration");
    expect(result.stderr).toContain(name);
    expect(result.stdout).toBe("");
  });
});
