import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  license?: string;
  private?: boolean;
  type?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

// An exact version has no range operators, tags or wildcards.
const isExactVersion = (spec: string | undefined): boolean =>
  spec !== undefined && /^\d+\.\d+\.\d+$/.test(spec);

describe("project scaffold", () => {
  it("is licensed GPL-3.0-only and is not published to npm", () => {
    expect(pkg.license).toBe("GPL-3.0-only");
    expect(pkg.private).toBe(true);
  });

  it("is an ES module project targeting the Node version REA admits", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.engines?.node).toBe("^24.22.1");
  });

  it("pins rea-agents and the MCP SDK to exact versions", () => {
    expect(isExactVersion(pkg.dependencies?.["rea-agents"])).toBe(true);
    expect(isExactVersion(pkg.dependencies?.["@modelcontextprotocol/sdk"])).toBe(true);
  });
});
