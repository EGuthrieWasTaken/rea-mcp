import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHILD_ENV_ALLOWLIST, childEnvironment, productionLaunch } from "../src/rea/launch.js";

describe("childEnvironment", () => {
  it("passes only allowlisted variables, and only when they are set", () => {
    const child = childEnvironment({
      PATH: "/usr/bin",
      HOME: "/work/home",
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      JAVA_HOME: "/usr/lib/jvm/jdk",
      TMPDIR: "/tmp",
    });
    expect(child).toEqual({
      PATH: "/usr/bin",
      HOME: "/work/home",
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      JAVA_HOME: "/usr/lib/jvm/jdk",
      TMPDIR: "/tmp",
    });
  });

  it("omits unset and empty variables", () => {
    expect(childEnvironment({ PATH: "/usr/bin", HOME: "", JAVA_HOME: undefined })).toEqual({ PATH: "/usr/bin" });
  });

  it("never passes a key variable, another secret, or a setting REA cannot combine with a checkpoint", () => {
    const hostile: Record<string, string> = {
      PATH: "/usr/bin",
      REA_MCP_API_KEY: "a-secret",
      REA_MCP_API_KEYS: "a,b",
      REA_MCP_API_KEY_FILE: "/run/secrets/key",
      AWS_SECRET_ACCESS_KEY: "another-secret",
      REA_GHIDRA_PROJECT_PATH: "/p.gpr",
      REA_GHIDRA_SEED_FILE: "/seeds",
      REA_GHIDRA_NATIVEAOT_JAR: "/x.jar",
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:64:default",
      REA_GHIDRA_DISABLED_ANALYZERS: "A",
      JAVA_TOOL_OPTIONS: "-Xmx1g",
      NODE_OPTIONS: "--require /evil.js",
    };
    expect(childEnvironment(hostile)).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps its allowlist small and explicit", () => {
    expect([...CHILD_ENV_ALLOWLIST]).toEqual([
      "PATH",
      "HOME",
      "JAVA_HOME",
      "GHIDRA_INSTALL_DIR",
      "TMPDIR",
      "REA_GHIDRA_STARTUP_TIMEOUT_MS",
    ]);
  });

  it("passes REA_GHIDRA_STARTUP_TIMEOUT_MS through exactly as given, valid or not", () => {
    expect(childEnvironment({ REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000" })).toEqual({ REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000" });
    // REA validates it itself, and only when a Ghidra session starts.
    expect(childEnvironment({ REA_GHIDRA_STARTUP_TIMEOUT_MS: "abc" })).toEqual({ REA_GHIDRA_STARTUP_TIMEOUT_MS: "abc" });
    expect(childEnvironment({})).toEqual({});
  });

  it("hands GHIDRA_MAX_HEAP to REA as GHIDRA_HEADLESS_MAXMEM, the variable REA reads, and only that", () => {
    const child = childEnvironment({ GHIDRA_MAX_HEAP: "8G" });
    expect(child).toEqual({ GHIDRA_HEADLESS_MAXMEM: "8G" });
    expect(child).not.toHaveProperty("GHIDRA_MAX_HEAP");
  });

  it("ignores heap variables set directly, so GHIDRA_MAX_HEAP is the one documented route", () => {
    expect(childEnvironment({ GHIDRA_HEADLESS_MAXMEM: "1G", GHIDRA_MAXMEM: "1G", JAVA_TOOL_OPTIONS: "-Xmx1g" })).toEqual({});
    expect(childEnvironment({ GHIDRA_MAX_HEAP: "4G", GHIDRA_HEADLESS_MAXMEM: "1G" })).toEqual({ GHIDRA_HEADLESS_MAXMEM: "4G" });
  });

  it("never lets a malformed heap value reach the JVM", () => {
    for (const bad of ["lots", "0", "8GB", "8G -Xss1g", "8G\n-Xss1g"]) {
      expect(childEnvironment({ GHIDRA_MAX_HEAP: bad })).toEqual({});
    }
  });

  it("trims whitespace around a valid heap size, as the configuration does", () => {
    expect(childEnvironment({ GHIDRA_MAX_HEAP: " 8G\n" })).toEqual({ GHIDRA_HEADLESS_MAXMEM: "8G" });
  });
});

describe("productionLaunch", () => {
  it("runs the installed rea-agents script under the gateway's own Node, as `mcp`, with no shell", () => {
    const launch = productionLaunch({ PATH: "/usr/bin" });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(2);
    expect(launch.args[0]).toMatch(/rea-agents[\\/]scripts[\\/]rea\.mjs$/);
    expect(launch.args[1]).toBe("mcp");
    expect(existsSync(launch.args[0] ?? "")).toBe(true);
    expect(launch.env).toEqual({ PATH: "/usr/bin" });
  });
});
