import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BUILT_MAIN } from "./helpers/paths.js";
import { randomKey } from "./helpers/keys.js";

const start = (env: Record<string, string>) =>
  spawnSync(process.execPath, [BUILT_MAIN], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });

describe("gateway startup without a usable key", () => {
  it("exits non-zero and says a key is required when none is configured", () => {
    const result = start({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API key is required");
    expect(result.stdout).toBe("");
  });

  it("exits non-zero for a 31-character key and does not print it", () => {
    const key = randomKey(31);
    const result = start({ REA_MCP_API_KEY: key });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REA_MCP_API_KEY");
    expect(`${result.stdout}${result.stderr}`).not.toContain(key);
    expect(`${result.stdout}${result.stderr}`).not.toContain(key.slice(0, 8));
  });

  it("exits non-zero when one key among several is weak", () => {
    const [good, weak] = [randomKey(), randomKey(12)];
    const result = start({ REA_MCP_API_KEYS: `${good},${weak}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REA_MCP_API_KEYS");
    for (const key of [good, weak]) expect(`${result.stdout}${result.stderr}`).not.toContain(key);
  });

  it("exits non-zero when the key file is missing", () => {
    const result = start({ REA_MCP_API_KEY_FILE: "/nonexistent/rea-mcp-key" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REA_MCP_API_KEY_FILE");
  });

  it("does not report a key problem for a valid key", () => {
    const key = randomKey();
    const result = start({ REA_MCP_API_KEY: key });
    expect(result.stderr).not.toContain("usable API key");
    expect(`${result.stdout}${result.stderr}`).not.toContain(key);
  });
});
