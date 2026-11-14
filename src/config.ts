// Gateway configuration from environment variables (spec: mcp-http-gateway,
// "Environment-variable configuration"). Pure and synchronous: it reads only the
// environment object it is given, so tests need no process state.
//
// API keys are loaded separately (keys.ts) so that nothing in this module can
// echo one. Error messages here name the variable and the rule, never the value.

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly port: number;
  readonly maxSessions: number;
  readonly sessionIdleTimeoutSec: number;
  readonly trustProxy: boolean;
  /** Lower-cased host names with any port removed. Empty means "do not restrict". */
  readonly allowedHosts: readonly string[];
  readonly logLevel: LogLevel;
  /**
   * Where the gateway keeps its files (session working directories live in
   * `<workDir>/sessions`). Always `/work` in the image; REA_MCP_WORK_DIR exists so
   * tests can point it elsewhere, and is deliberately not a documented setting.
   */
  readonly workDir: string;
  /**
   * REA_GHIDRA_CHECKPOINT_DIR: where REA saves Ghidra analysis. Unset means no
   * checkpointing, which is the default. When set, children get a longer shutdown grace.
   */
  readonly checkpointDir: string | undefined;
  /**
   * GHIDRA_MAX_HEAP: the maximum Java heap of Ghidra's JVM, as the operator wrote it.
   * Handed to REA as GHIDRA_HEADLESS_MAXMEM. Unset leaves REA's own default (2G).
   */
  readonly ghidraMaxHeap: string | undefined;
}

/**
 * A JVM heap size: a positive integer, optionally followed by k, m or g in either case.
 * (A bare number is bytes, as for the JVM.) REA turns the value into -Xmx and an invalid
 * one makes Java fail to start, so it is checked here, at gateway startup.
 */
const HEAP_SIZE = /^[1-9]\d{0,14}[kKmMgG]?$/;
export const isHeapSize = (value: string): boolean => HEAP_SIZE.test(value);

/**
 * The documented defaults, as the strings an operator would set. The unRAID
 * template check compares its defaults with these so the two cannot drift.
 */
export const DEFAULT_ENV = {
  PORT: "8080",
  MAX_SESSIONS: "4",
  SESSION_IDLE_TIMEOUT_SEC: "900",
  TRUST_PROXY: "false",
  ALLOWED_HOSTS: "",
  LOG_LEVEL: "info",
  // These have no default: unset means REA's own behaviour (a 2G heap, its default
  // startup deadline, no checkpointing). They are listed so the unRAID template check can
  // compare every advanced variable, and so a blank value reads as unset.
  GHIDRA_MAX_HEAP: "",
  REA_GHIDRA_STARTUP_TIMEOUT_MS: "",
  REA_GHIDRA_CHECKPOINT_DIR: "",
} as const;

/** A configuration value that cannot be used. `variable` names the culprit. */
export class ConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, rule: string) {
    super(`${variable} ${rule}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** A variable that is unset, or set to nothing but whitespace, takes its default. */
const read = (env: Environment, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const integer = (
  env: Environment,
  name: keyof typeof DEFAULT_ENV,
  min: number,
  max: number,
): number => {
  const raw = read(env, name) ?? DEFAULT_ENV[name];
  if (!/^\d{1,15}$/.test(raw)) {
    throw new ConfigError(name, `must be an integer from ${min} to ${max}`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ConfigError(name, `must be an integer from ${min} to ${max}`);
  }
  return value;
};

const boolean = (env: Environment, name: keyof typeof DEFAULT_ENV): boolean => {
  const raw = (read(env, name) ?? DEFAULT_ENV[name]).toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(name, "must be true or false");
};

const logLevel = (env: Environment): LogLevel => {
  const raw = (read(env, "LOG_LEVEL") ?? DEFAULT_ENV.LOG_LEVEL).toLowerCase();
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    throw new ConfigError("LOG_LEVEL", `must be one of ${LOG_LEVELS.join(", ")}`);
  }
  return level;
};

// A DNS name or a bracketed IPv6 literal, with an optional port that is ignored.
const HOST_ENTRY = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.?)(:\d{1,5})?$/;

const allowedHosts = (env: Environment): readonly string[] => {
  const raw = read(env, "ALLOWED_HOSTS");
  if (raw === undefined) return [];
  const hosts = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (entry === "") continue;
    const match = HOST_ENTRY.exec(entry);
    if (match?.[1] === undefined) {
      throw new ConfigError(
        "ALLOWED_HOSTS",
        "must be a comma-separated list of host names, without schemes or paths",
      );
    }
    hosts.add(match[1]);
  }
  return [...hosts];
};

const workDir = (env: Environment): string => {
  const raw = read(env, "REA_MCP_WORK_DIR") ?? "/work";
  if (!raw.startsWith("/") || raw.includes("\0")) {
    throw new ConfigError("REA_MCP_WORK_DIR", "must be an absolute path");
  }
  return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
};

const ghidraMaxHeap = (env: Environment): string | undefined => {
  const raw = read(env, "GHIDRA_MAX_HEAP");
  if (raw === undefined) return undefined;
  if (!isHeapSize(raw)) {
    throw new ConfigError("GHIDRA_MAX_HEAP", "must be a JVM heap size: a positive integer, optionally followed by k, m or g");
  }
  return raw;
};

const checkpointDir = (env: Environment): string | undefined => {
  const raw = read(env, "REA_GHIDRA_CHECKPOINT_DIR");
  if (raw === undefined) return undefined;
  if (!raw.startsWith("/") || raw.includes("\0")) {
    throw new ConfigError("REA_GHIDRA_CHECKPOINT_DIR", "must be an absolute path");
  }
  return raw;
};

export function loadConfig(env: Environment): Config {
  return {
    port: integer(env, "PORT", 1, 65535),
    maxSessions: integer(env, "MAX_SESSIONS", 1, 256),
    sessionIdleTimeoutSec: integer(env, "SESSION_IDLE_TIMEOUT_SEC", 1, 604_800),
    trustProxy: boolean(env, "TRUST_PROXY"),
    allowedHosts: allowedHosts(env),
    logLevel: logLevel(env),
    workDir: workDir(env),
    checkpointDir: checkpointDir(env),
    ghidraMaxHeap: ghidraMaxHeap(env),
  };
}
