// API key loading (spec: api-key-auth, "Runtime-only key sources" and "Startup
// refusal on missing or weak keys"). Keys come only from the environment or a file
// the operator names; there is no default. Nothing in this module puts a key, any
// part of a key, or the actual length of a key into an error message.
import { closeSync, openSync, readSync } from "node:fs";
import type { Environment } from "./config.js";

/** Hard requirement 2: a key shorter than this is refused at startup. */
export const MIN_KEY_LENGTH = 32;

// A key file holds one short secret. Anything bigger is a mistake (a log, a
// directory listing, a binary), so refuse it instead of reading it all.
const MAX_KEY_FILE_BYTES = 4096;

const KEY_VARIABLE = "REA_MCP_API_KEY";
const KEY_FILE_VARIABLE = "REA_MCP_API_KEY_FILE";
const KEY_LIST_VARIABLE = "REA_MCP_API_KEYS";

/** A key setting that cannot be used. `variable` names the culprit. */
export class KeyError extends Error {
  readonly variable: string;
  constructor(variable: string, detail: string) {
    super(`${variable}: ${detail}`);
    this.name = "KeyError";
    this.variable = variable;
  }
}

// A control character (a line break, NUL) cannot appear in an HTTP header value,
// so a key containing one could never match a request.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const set = (env: Environment, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const check = (key: string, variable: string, entry?: number): string => {
  const where = entry === undefined ? "" : ` (entry ${entry})`;
  if (CONTROL_CHARACTER.test(key)) {
    throw new KeyError(
      variable,
      `contains a character that cannot be sent in an HTTP header${where}`,
    );
  }
  if (Array.from(key).length < MIN_KEY_LENGTH) {
    throw new KeyError(variable, `holds a key shorter than ${MIN_KEY_LENGTH} characters${where}`);
  }
  return key;
};

const readKeyFile = (path: string): string => {
  const unreadable = (cause: unknown): KeyError => {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
        ? cause.code
        : "unknown error";
    return new KeyError(KEY_FILE_VARIABLE, `cannot be read (${code})`);
  };
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > MAX_KEY_FILE_BYTES) {
        throw new KeyError(KEY_FILE_VARIABLE, `names a file that is too large to be a key`);
      }
      text = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw error instanceof KeyError ? error : unreadable(error);
  }
  // Surrounding whitespace, a trailing newline and a byte-order mark are trimmed.
  const key = text.trim();
  if (key === "") {
    throw new KeyError(KEY_FILE_VARIABLE, "names a file that holds no key");
  }
  return check(key, KEY_FILE_VARIABLE);
};

/**
 * Collect the accepted keys: the union of REA_MCP_API_KEY, the file named by
 * REA_MCP_API_KEY_FILE, and the comma-separated REA_MCP_API_KEYS, without
 * duplicates. Throws a KeyError, and so refuses startup, when there is none or
 * when any configured key is unusable.
 */
export function loadKeys(env: Environment): readonly string[] {
  const keys: string[] = [];

  const single = set(env, KEY_VARIABLE);
  if (single !== undefined) keys.push(check(single, KEY_VARIABLE));

  const file = set(env, KEY_FILE_VARIABLE);
  if (file !== undefined) keys.push(readKeyFile(file));

  const list = set(env, KEY_LIST_VARIABLE);
  if (list !== undefined) {
    let entry = 0;
    for (const part of list.split(",")) {
      entry += 1;
      const key = part.trim();
      if (key !== "") keys.push(check(key, KEY_LIST_VARIABLE, entry));
    }
  }

  if (keys.length === 0) {
    throw new KeyError(
      KEY_VARIABLE,
      `an API key is required; set ${KEY_VARIABLE}, ${KEY_FILE_VARIABLE} or ${KEY_LIST_VARIABLE}`,
    );
  }
  return Object.freeze([...new Set(keys)]);
}
