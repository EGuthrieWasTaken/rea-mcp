import { describe, expect, it } from "vitest";
import { parseLogLines, startGateway } from "./helpers/process.js";

describe("gateway startup with an unparsable setting", () => {
  const cases: [string, string][] = [
    ["PORT", "abc"],
    ["PORT", "70000"],
    ["MAX_SESSIONS", "lots"],
    ["SESSION_IDLE_TIMEOUT_SEC", "-5"],
    ["TRUST_PROXY", "maybe"],
    ["LOG_LEVEL", "loud"],
    ["ALLOWED_HOSTS", "http://bad"],
    ["GHIDRA_MAX_HEAP", "lots"],
    ["GHIDRA_MAX_HEAP", "0"],
    ["GHIDRA_MAX_HEAP", "8GB"],
    ["REA_GHIDRA_CHECKPOINT_DIR", "relative/dir"],
  ];

  it.each(cases)("exits non-zero and names %s for %j", (name, value) => {
    const result = startGateway({ [name]: value });
    expect(result.status).toBe(1);
    // Everything the gateway says is one JSON object per line on stdout.
    expect(result.stderr).toBe("");
    const lines = parseLogLines(result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", message: "invalid configuration", variable: name });
  });
});
