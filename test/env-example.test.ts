// .env.example is the operator's map of every setting. This keeps it from drifting from
// what the gateway actually reads.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ENV } from "../src/config.js";
import { REPO_ROOT } from "./helpers/paths.js";

const example = readFileSync(`${REPO_ROOT}.env.example`, "utf8");
const lines = example.split("\n");

/** The names assigned on active or commented-out lines, such as `# PORT=8080`. */
const listed = new Set(
  lines.map((line) => /^#?\s?([A-Z][A-Z0-9_]+)=/.exec(line)?.[1]).filter((name): name is string => name !== undefined),
);

describe(".env.example", () => {
  it("lists every setting the gateway reads", () => {
    const expected = [...Object.keys(DEFAULT_ENV), "REA_MCP_API_KEY", "REA_MCP_API_KEY_FILE", "REA_MCP_API_KEYS"];
    for (const name of expected) expect(listed, name).toContain(name);
  });

  it("does not list settings the gateway does not read", () => {
    const known = new Set([...Object.keys(DEFAULT_ENV), "REA_MCP_API_KEY", "REA_MCP_API_KEY_FILE", "REA_MCP_API_KEYS"]);
    for (const name of listed) expect(known, name).toContain(name);
  });

  it("leaves the only active assignment, the API key, empty", () => {
    const active = lines.filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line));
    expect(active).toEqual(["REA_MCP_API_KEY="]);
  });

  it("keeps checkpointing off by default: its line is commented out and empty", () => {
    expect(lines).toContain("# REA_GHIDRA_CHECKPOINT_DIR=");
  });

  it("carries no value that could be mistaken for a key", () => {
    for (const line of lines) expect(line).not.toMatch(/=[A-Za-z0-9+/_-]{20,}/);
  });
});
