import { describe, expect, it } from "vitest";
import { LOG_LEVELS, type LogLevel } from "../src/config.js";
import { createLogger, MAX_FIELD_LENGTH, type LogFields } from "../src/logger.js";
import { randomKey } from "./helpers/keys.js";

const capture = (level: LogLevel) => {
  const lines: string[] = [];
  const logger = createLogger(level, (line) => lines.push(line), () => new Date("2026-01-02T03:04:05.000Z"));
  const entries = (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, entries };
};

/** Every way a caller might try to smuggle a header or key past the type. */
const smuggled = (key: string): LogFields =>
  ({
    method: "POST",
    path: "/mcp",
    status: 200,
    headers: { "x-api-key": key },
    "x-api-key": key,
    authorization: `Bearer ${key}`,
    apiKey: key,
    body: { token: key },
  }) as unknown as LogFields;

describe("logger output format", () => {
  it("writes one JSON object per line with a time, level and message", () => {
    const { logger, lines, entries } = capture("debug");
    logger.info("hello", { status: 200 });
    logger.warn("careful");
    expect(lines.every((line) => line.endsWith("\n") && line.indexOf("\n") === line.length - 1)).toBe(true);
    expect(entries()).toEqual([
      { time: "2026-01-02T03:04:05.000Z", level: "info", message: "hello", status: 200 },
      { time: "2026-01-02T03:04:05.000Z", level: "warn", message: "careful" },
    ]);
  });

  it("keeps a multi-line message on one line", () => {
    const { logger, lines, entries } = capture("info");
    logger.info("first\nsecond", { line: "a\r\nb" });
    expect(lines).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ message: "first\nsecond", line: "a\r\nb" });
  });
});

describe("logger level filtering", () => {
  const expected: Record<LogLevel, LogLevel[]> = {
    debug: ["debug", "info", "warn", "error"],
    info: ["info", "warn", "error"],
    warn: ["warn", "error"],
    error: ["error"],
  };

  it.each(LOG_LEVELS)("at LOG_LEVEL=%s writes only the levels at or above it", (level) => {
    const { logger, entries } = capture(level);
    for (const at of LOG_LEVELS) logger[at](`a ${at} entry`);
    expect(entries().map((entry) => entry.level)).toEqual(expected[level]);
  });

  it("reports which levels are enabled", () => {
    const { logger } = capture("warn");
    expect(LOG_LEVELS.map((level) => logger.enabled(level))).toEqual([false, false, true, true]);
  });
});

describe("logger never carries headers or keys", () => {
  it.each(LOG_LEVELS)("drops smuggled properties at LOG_LEVEL=%s", (level) => {
    const key = randomKey();
    const { logger, lines, entries } = capture(level);
    for (const at of LOG_LEVELS) logger[at]("request handled", smuggled(key));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(key);
      expect(line).not.toContain("x-api-key");
      expect(line).not.toContain("authorization");
      expect(line).not.toContain("apiKey");
    }
    // What is on the allowlist still gets through.
    expect(entries()[0]).toMatchObject({ method: "POST", path: "/mcp", status: 200 });
  });

  it("refuses a headers object at compile time", () => {
    const { logger } = capture("debug");
    // @ts-expect-error `headers` is not a loggable field
    logger.info("request", { headers: { "x-api-key": "x" } });
    // @ts-expect-error nor is a request body
    logger.info("request", { body: "x" });
  });

  it("does not let fields override the time, level or message", () => {
    const { logger, entries } = capture("info");
    logger.info("real", { level: "fake", time: "fake", message: "fake" } as unknown as LogFields);
    expect(entries()[0]).toEqual({ time: "2026-01-02T03:04:05.000Z", level: "info", message: "real" });
  });

  it("drops values that are not plain strings, finite numbers or null", () => {
    const { logger, entries } = capture("info");
    logger.info("odd", {
      status: Number.NaN,
      durationMs: Number.POSITIVE_INFINITY,
      sessionId: { nested: "object" },
      sourceIp: ["a"],
      reason: true,
      exitCode: null,
    } as unknown as LogFields);
    expect(entries()[0]).toEqual({
      time: "2026-01-02T03:04:05.000Z",
      level: "info",
      message: "odd",
      exitCode: null,
    });
  });

  it("cuts very long string fields", () => {
    const { logger, entries } = capture("info");
    logger.info("long", { line: "x".repeat(MAX_FIELD_LENGTH * 3) });
    expect(String(entries()[0]?.line).length).toBe(MAX_FIELD_LENGTH + 3);
  });
});

describe("logger robustness", () => {
  it("does not throw when the output pipe is broken", () => {
    const logger = createLogger("info", () => {
      throw new Error("EPIPE");
    });
    expect(() => logger.error("still running")).not.toThrow();
  });
});
