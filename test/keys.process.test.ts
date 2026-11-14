import { describe, expect, it } from "vitest";
import { randomKey } from "./helpers/keys.js";
import { freePort, GatewayProcess, parseLogLines, startGateway } from "./helpers/process.js";
import { tempDir } from "./helpers/tmp.js";

const MESSAGE = "cannot start without a usable API key";

describe("gateway startup without a usable key", () => {
  it("exits non-zero and logs that a key is required when none is configured", () => {
    const result = startGateway({});
    expect(result.status).toBe(1);
    const [entry] = parseLogLines(result.stdout);
    expect(entry).toMatchObject({ level: "error", message: MESSAGE, variable: "REA_MCP_API_KEY" });
    expect(String(entry?.reason)).toContain("API key is required");
  });

  it("exits non-zero for a 31-character key and does not print it", () => {
    const key = randomKey(31);
    const result = startGateway({ REA_MCP_API_KEY: key });
    expect(result.status).toBe(1);
    expect(parseLogLines(result.stdout)[0]).toMatchObject({ message: MESSAGE, variable: "REA_MCP_API_KEY" });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain(key);
    expect(output).not.toContain(key.slice(0, 8));
  });

  it("exits non-zero when one key among several is weak", () => {
    const [good, weak] = [randomKey(), randomKey(12)];
    const result = startGateway({ REA_MCP_API_KEYS: `${good},${weak}` });
    expect(result.status).toBe(1);
    expect(parseLogLines(result.stdout)[0]).toMatchObject({ message: MESSAGE, variable: "REA_MCP_API_KEYS" });
    for (const key of [good, weak]) expect(`${result.stdout}${result.stderr}`).not.toContain(key);
  });

  it("exits non-zero when the key file is missing", () => {
    const result = startGateway({ REA_MCP_API_KEY_FILE: "/nonexistent/rea-mcp-key" });
    expect(result.status).toBe(1);
    expect(parseLogLines(result.stdout)[0]).toMatchObject({ message: MESSAGE, variable: "REA_MCP_API_KEY_FILE" });
  });

  it("does not report a key problem for a valid key, and keeps the key out of its output", async () => {
    const [key, port] = [randomKey(), await freePort()];
    const gateway = GatewayProcess.start({ REA_MCP_API_KEY: key, PORT: String(port), REA_MCP_WORK_DIR: tempDir() });
    try {
      await gateway.waitForLog((line) => line.message === "listening");
      expect(gateway.lines.map((line) => line.message)).not.toContain(MESSAGE);
    } finally {
      await gateway.stop("SIGTERM");
    }
    expect(`${JSON.stringify(gateway.lines)}${gateway.stderr}`).not.toContain(key);
  });
});
