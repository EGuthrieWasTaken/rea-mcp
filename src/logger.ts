// Structured logger (spec: mcp-http-gateway, "Structured logging"; design D4).
//
// One JSON object per line on stdout, filtered by LOG_LEVEL. The logger has no
// code path that accepts request headers, bodies or keys:
//   - callers can pass only the fields in LogFields (a closed type), and
//   - at run time every other property is dropped, even if a caller casts around
//     the type, because only the names in ALLOWED_FIELDS are ever copied.
// Messages are fixed strings by convention; anything variable goes in a field.
import type { LogLevel } from "./config.js";

/** The only data a log entry may carry besides its time, level and message. */
export interface LogFields {
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  sourceIp?: string;
  sessionId?: string;
  /** The name of a configuration variable at fault, never its value. */
  variable?: string;
  reason?: string;
  port?: number;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  count?: number;
  /** For lines captured from a child process. */
  stream?: "stdout" | "stderr";
  line?: string;
}

const ALLOWED_FIELDS = [
  "method",
  "path",
  "status",
  "durationMs",
  "sourceIp",
  "sessionId",
  "variable",
  "reason",
  "port",
  "pid",
  "exitCode",
  "signal",
  "count",
  "stream",
  "line",
] as const satisfies readonly (keyof LogFields)[];

/** Longest string a field may hold; longer values are cut so one line stays bounded. */
export const MAX_FIELD_LENGTH = 2000;

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Whether an entry at `level` would be written. */
  enabled(level: LogLevel): boolean;
}

const sanitize = (value: unknown): string | number | null | undefined => {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}...` : value;
  }
  return undefined; // objects, arrays, booleans and the rest are not loggable
};

const defaultWrite = (line: string): void => {
  process.stdout.write(line);
};

export function createLogger(
  level: LogLevel,
  write: (line: string) => void = defaultWrite,
  now: () => Date = () => new Date(),
): Logger {
  const threshold = RANK[level];
  const emit = (at: LogLevel, message: string, fields?: LogFields): void => {
    if (RANK[at] < threshold) return;
    const entry: Record<string, string | number | null> = {
      time: now().toISOString(),
      level: at,
      message,
    };
    if (fields !== undefined) {
      for (const name of ALLOWED_FIELDS) {
        const value = sanitize((fields as Record<string, unknown>)[name]);
        if (value !== undefined) entry[name] = value;
      }
    }
    try {
      write(`${JSON.stringify(entry)}\n`);
    } catch {
      // A broken log pipe must never take the gateway down.
    }
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    enabled: (at) => RANK[at] >= threshold,
  };
}
