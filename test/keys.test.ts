import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyError, MIN_KEY_LENGTH, loadKeys } from "../src/keys.js";
import { randomKey } from "./helpers/keys.js";

const failure = (env: Record<string, string>): KeyError => {
  try {
    loadKeys(env);
  } catch (error) {
    if (error instanceof KeyError) return error;
    throw error;
  }
  throw new Error("expected loadKeys to throw a KeyError");
};

/** The error must not reveal the key, any prefix or suffix of it. */
const expectNoKeyMaterial = (error: Error, key: string): void => {
  expect(error.message).not.toContain(key);
  expect(error.message).not.toContain(key.slice(0, 8));
  expect(error.message).not.toContain(key.slice(-8));
};

// U+FEFF, written as a code point so the source holds no invisible character.
const BOM = String.fromCharCode(0xfeff);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rea-mcp-keys-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const keyFile = (content: string, name = "key"): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe("loadKeys sources", () => {
  it("accepts a single key from REA_MCP_API_KEY", () => {
    const key = randomKey();
    expect(loadKeys({ REA_MCP_API_KEY: key })).toEqual([key]);
  });

  it("reads the key from REA_MCP_API_KEY_FILE without its trailing newline", () => {
    const key = randomKey();
    expect(loadKeys({ REA_MCP_API_KEY_FILE: keyFile(`${key}\n`) })).toEqual([key]);
  });

  it.each([["CRLF", "\r\n"], ["surrounding whitespace", "  "], ["no newline", ""]])(
    "trims a key file with %s",
    (_label, padding) => {
      const key = randomKey();
      const content = padding === "  " ? `${padding}${key}${padding}\n` : `${key}${padding}`;
      expect(loadKeys({ REA_MCP_API_KEY_FILE: keyFile(content) })).toEqual([key]);
    },
  );

  it("ignores a byte-order mark at the start of the key file", () => {
    const key = randomKey();
    expect(loadKeys({ REA_MCP_API_KEY_FILE: keyFile(`${BOM}${key}\n`) })).toEqual([key]);
  });

  it("accepts several keys from REA_MCP_API_KEYS for rotation", () => {
    const [a, b] = [randomKey(), randomKey(40)];
    expect(loadKeys({ REA_MCP_API_KEYS: `${a},${b}` })).toEqual([a, b]);
  });

  it("ignores empty entries and trims each entry of REA_MCP_API_KEYS", () => {
    const [a, b] = [randomKey(), randomKey()];
    expect(loadKeys({ REA_MCP_API_KEYS: ` ${a} ,, ,${b}, ` })).toEqual([a, b]);
  });

  it("combines every source and removes duplicates", () => {
    const [one, two, three, four] = [randomKey(), randomKey(), randomKey(), randomKey()];
    const keys = loadKeys({
      REA_MCP_API_KEY: one,
      REA_MCP_API_KEY_FILE: keyFile(`${two}\n`),
      REA_MCP_API_KEYS: `${three},${four},${one}`,
    });
    expect(keys).toEqual([one, two, three, four]);
  });

  it("treats empty and whitespace-only variables as unset", () => {
    const key = randomKey();
    const env = { REA_MCP_API_KEY: key, REA_MCP_API_KEY_FILE: "", REA_MCP_API_KEYS: "   " };
    expect(loadKeys(env)).toEqual([key]);
  });
});

describe("loadKeys refuses to start", () => {
  it("when no key is configured, saying a key is required and naming every source", () => {
    const error = failure({});
    expect(error.message).toContain("API key is required");
    for (const name of ["REA_MCP_API_KEY", "REA_MCP_API_KEY_FILE", "REA_MCP_API_KEYS"]) {
      expect(error.message).toContain(name);
    }
  });

  it("when every source is blank", () => {
    const blank = { REA_MCP_API_KEY: " ", REA_MCP_API_KEY_FILE: "", REA_MCP_API_KEYS: ",," };
    expect(failure(blank).message).toContain("API key is required");
  });

  it(`for a key one character short of ${MIN_KEY_LENGTH}, without revealing it`, () => {
    const key = randomKey(MIN_KEY_LENGTH - 1);
    const error = failure({ REA_MCP_API_KEY: key });
    expect(error.variable).toBe("REA_MCP_API_KEY");
    expect(error.message).toContain(`${MIN_KEY_LENGTH} characters`);
    expectNoKeyMaterial(error, key);
  });

  it(`accepts a key of exactly ${MIN_KEY_LENGTH} characters`, () => {
    const key = randomKey(MIN_KEY_LENGTH);
    expect(loadKeys({ REA_MCP_API_KEY: key })).toEqual([key]);
  });

  it("when one key among several is too short, rather than starting with the rest", () => {
    const [good, weak] = [randomKey(), randomKey(20)];
    const error = failure({ REA_MCP_API_KEYS: `${good},${weak}` });
    expect(error.variable).toBe("REA_MCP_API_KEYS");
    expect(error.message).toContain("entry 2");
    expectNoKeyMaterial(error, weak);
    expectNoKeyMaterial(error, good);
  });

  it("when a weak key comes from the file", () => {
    const weak = randomKey(10);
    const error = failure({ REA_MCP_API_KEY: randomKey(), REA_MCP_API_KEY_FILE: keyFile(weak) });
    expect(error.variable).toBe("REA_MCP_API_KEY_FILE");
    expectNoKeyMaterial(error, weak);
  });

  it("when the key file does not exist", () => {
    const error = failure({ REA_MCP_API_KEY: randomKey(), REA_MCP_API_KEY_FILE: join(dir, "missing") });
    expect(error.variable).toBe("REA_MCP_API_KEY_FILE");
    expect(error.message).toContain("cannot be read");
    expect(error.message).toContain("ENOENT");
  });

  it("when the key file path is a directory", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const error = failure({ REA_MCP_API_KEY_FILE: sub });
    expect(error.variable).toBe("REA_MCP_API_KEY_FILE");
    expect(error.message).toContain("cannot be read");
  });

  it.skipIf(process.getuid?.() === 0)("when the key file is not readable", () => {
    const path = keyFile(randomKey());
    chmodSync(path, 0o000);
    expect(failure({ REA_MCP_API_KEY_FILE: path }).message).toContain("EACCES");
  });

  it("when the key file is empty or only whitespace", () => {
    for (const content of ["", "\n", "  \r\n  "]) {
      const error = failure({ REA_MCP_API_KEY: randomKey(), REA_MCP_API_KEY_FILE: keyFile(content) });
      expect(error.variable).toBe("REA_MCP_API_KEY_FILE");
      expect(error.message).toContain("holds no key");
    }
  });

  it("when the key file has more than one line", () => {
    const [first, second] = [randomKey(), randomKey()];
    const error = failure({ REA_MCP_API_KEY_FILE: keyFile(`${first}\n${second}\n`) });
    expect(error.variable).toBe("REA_MCP_API_KEY_FILE");
    expectNoKeyMaterial(error, first);
    expectNoKeyMaterial(error, second);
  });

  it("when the key file is far too large to be a key", () => {
    const error = failure({ REA_MCP_API_KEY_FILE: keyFile("x".repeat(5000)) });
    expect(error.variable).toBe("REA_MCP_API_KEY_FILE");
    expect(error.message).toContain("too large");
  });

  it("when a key contains a control character", () => {
    const key = `${randomKey()}\u0007${randomKey()}`;
    const error = failure({ REA_MCP_API_KEY: key });
    expect(error.variable).toBe("REA_MCP_API_KEY");
    expect(error.message).toContain("HTTP header");
    expectNoKeyMaterial(error, key);
  });
});
