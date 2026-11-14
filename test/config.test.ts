import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_ENV, loadConfig } from "../src/config.js";

const failure = (env: Record<string, string>): ConfigError => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw a ConfigError");
};

describe("loadConfig defaults", () => {
  it("applies the documented defaults when nothing is set", () => {
    expect(loadConfig({})).toEqual({
      port: 8080,
      maxSessions: 4,
      sessionIdleTimeoutSec: 900,
      trustProxy: false,
      allowedHosts: [],
      logLevel: "info",
      workDir: "/work",
    });
  });

  it("agrees with DEFAULT_ENV, which the unRAID template check compares against", () => {
    expect(loadConfig(DEFAULT_ENV)).toEqual(loadConfig({}));
  });

  it("treats empty and whitespace-only values as unset", () => {
    const blank = { PORT: "", MAX_SESSIONS: "  ", LOG_LEVEL: "\t", ALLOWED_HOSTS: " " };
    expect(loadConfig(blank)).toEqual(loadConfig({}));
  });
});

describe("loadConfig overrides", () => {
  it("reads every variable", () => {
    expect(
      loadConfig({
        PORT: "9000",
        MAX_SESSIONS: "2",
        SESSION_IDLE_TIMEOUT_SEC: "60",
        TRUST_PROXY: "true",
        ALLOWED_HOSTS: "rea.example",
        LOG_LEVEL: "debug",
      }),
    ).toEqual({
      port: 9000,
      maxSessions: 2,
      sessionIdleTimeoutSec: 60,
      trustProxy: true,
      allowedHosts: ["rea.example"],
      logLevel: "debug",
      workDir: "/work",
    });
  });

  it("accepts the bounds of each integer", () => {
    expect(loadConfig({ PORT: "1" }).port).toBe(1);
    expect(loadConfig({ PORT: "65535" }).port).toBe(65535);
    expect(loadConfig({ MAX_SESSIONS: "1" }).maxSessions).toBe(1);
    expect(loadConfig({ MAX_SESSIONS: "256" }).maxSessions).toBe(256);
    expect(loadConfig({ SESSION_IDLE_TIMEOUT_SEC: "1" }).sessionIdleTimeoutSec).toBe(1);
    expect(loadConfig({ SESSION_IDLE_TIMEOUT_SEC: "604800" }).sessionIdleTimeoutSec).toBe(604_800);
  });

  it("is case-insensitive for TRUST_PROXY and LOG_LEVEL", () => {
    expect(loadConfig({ TRUST_PROXY: "TRUE" }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: "False" }).trustProxy).toBe(false);
    expect(loadConfig({ LOG_LEVEL: "WARN" }).logLevel).toBe("warn");
  });
});

describe("loadConfig ALLOWED_HOSTS", () => {
  it("lower-cases, strips ports, ignores empty entries and removes duplicates", () => {
    const config = loadConfig({ ALLOWED_HOSTS: "Example.COM, other.test:8443 ,,example.com" });
    expect(config.allowedHosts).toEqual(["example.com", "other.test"]);
  });

  it("accepts bracketed IPv6 literals and localhost", () => {
    const config = loadConfig({ ALLOWED_HOSTS: "[::1]:8080,localhost" });
    expect(config.allowedHosts).toEqual(["[::1]", "localhost"]);
  });

  it.each(["http://example.com", "example.com/path", "*.example.com", "bad host", "a,b c"])(
    "rejects the malformed list %j",
    (value) => {
      expect(failure({ ALLOWED_HOSTS: value }).variable).toBe("ALLOWED_HOSTS");
    },
  );
});

describe("loadConfig rejects unusable values, naming the variable", () => {
  const cases: [string, string][] = [
    ["PORT", "abc"],
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "80.5"],
    ["PORT", "-1"],
    ["MAX_SESSIONS", "lots"],
    ["MAX_SESSIONS", "0"],
    ["MAX_SESSIONS", "257"],
    ["SESSION_IDLE_TIMEOUT_SEC", "0"],
    ["SESSION_IDLE_TIMEOUT_SEC", "604801"],
    ["SESSION_IDLE_TIMEOUT_SEC", "1e3"],
    ["TRUST_PROXY", "yes"],
    ["TRUST_PROXY", "1"],
    ["LOG_LEVEL", "loud"],
  ];

  it.each(cases)("%s=%j", (name, value) => {
    const error = failure({ [name]: value });
    expect(error.variable).toBe(name);
    expect(error.message.startsWith(`${name} `)).toBe(true);
  });

  it("never echoes the offending value", () => {
    const marker = "ZZ-marker-value-ZZ";
    for (const name of ["PORT", "MAX_SESSIONS", "SESSION_IDLE_TIMEOUT_SEC", "TRUST_PROXY", "LOG_LEVEL"]) {
      expect(failure({ [name]: marker }).message).not.toContain(marker);
    }
    expect(failure({ ALLOWED_HOSTS: `http://${marker}` }).message).not.toContain(marker);
  });
});

describe("loadConfig REA_MCP_WORK_DIR (an internal setting, for tests)", () => {
  it("defaults to /work", () => {
    expect(loadConfig({}).workDir).toBe("/work");
  });

  it("accepts an absolute path and drops trailing slashes", () => {
    expect(loadConfig({ REA_MCP_WORK_DIR: "/tmp/some/dir///" }).workDir).toBe("/tmp/some/dir");
    expect(loadConfig({ REA_MCP_WORK_DIR: "/" }).workDir).toBe("/");
  });

  it.each(["relative/path", "./here", "work"])("rejects the relative path %j, naming the variable", (value) => {
    expect(failure({ REA_MCP_WORK_DIR: value }).variable).toBe("REA_MCP_WORK_DIR");
  });
});
