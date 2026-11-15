import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESULT_ID, ResultStore } from "../src/results/store.js";
import { tempDir } from "./helpers/tmp.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

const make = async (sessionLimitBytes?: number) => {
  const dir = join(tempDir("rea-mcp-results-"), "results");
  const store = new ResultStore({ dir, ...(sessionLimitBytes === undefined ? {} : { sessionLimitBytes }) });
  await store.init();
  return { dir, store };
};

const stored = async (store: ResultStore, sessionId: string, text: string) => {
  const result = await store.put(sessionId, "list_strings", text, { provenance: { untrusted_content: true } });
  if (result === "full") throw new Error("expected the result to be stored");
  return result;
};

describe("ResultStore: storing", () => {
  it("writes the text to a file in the session's directory and describes it", async () => {
    const { dir, store } = await make();
    const text = "héllo wörld 日本";
    const result = await stored(store, SESSION, text);
    expect(result.id).toMatch(RESULT_ID);
    expect(result.file).toBe(join(dir, SESSION, `${result.id}.txt`));
    expect(readFileSync(result.file, "utf8")).toBe(text);
    expect(result).toMatchObject({
      sessionId: SESSION,
      tool: "list_strings",
      chars: text.length,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      meta: { provenance: { untrusted_content: true } },
    });
  });

  it("keeps the files private: 0600 in a 0700 directory", async () => {
    const { dir, store } = await make();
    const result = await stored(store, SESSION, "x");
    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, SESSION)).mode & 0o777).toBe(0o700);
  });

  it("gives every result its own id", async () => {
    const { store } = await make();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) ids.add((await stored(store, SESSION, `result ${i}`)).id);
    expect(ids.size).toBe(50);
  });

  it("refuses a result that would take the session over its cap, writes nothing, and then still takes a smaller one", async () => {
    const { dir, store } = await make(100);
    await stored(store, SESSION, "a".repeat(60));
    expect(await store.put(SESSION, "t", "b".repeat(41), undefined)).toBe("full");
    expect(readdirSync(join(dir, SESSION))).toHaveLength(1);
    expect(store.usedBytes(SESSION)).toBe(60);
    await stored(store, SESSION, "c".repeat(40));
    expect(store.usedBytes(SESSION)).toBe(100);
  });

  it("counts bytes, not characters, against the cap", async () => {
    const { store } = await make(10);
    expect(await store.put(SESSION, "t", "日".repeat(4), undefined)).toBe("full"); // 12 bytes
    expect(await store.put(SESSION, "t", "日".repeat(3), undefined)).not.toBe("full"); // 9 bytes
  });

  it("gives each session its own cap", async () => {
    const { store } = await make(50);
    await stored(store, SESSION, "a".repeat(50));
    expect(await store.put(OTHER, "t", "b".repeat(50), undefined)).not.toBe("full");
  });

  it("refuses a session id that could be a path", async () => {
    const { store } = await make();
    for (const id of ["../x", "a/b", "", "a".repeat(65), "..", "a b"]) {
      await expect(store.put(id, "t", "x", undefined), id).rejects.toThrow();
    }
  });
});

describe("ResultStore: finding a result", () => {
  it("finds a result of the session that stored it", async () => {
    const { store } = await make();
    const result = await stored(store, SESSION, "x");
    expect(store.get(SESSION, result.id)).toBe(result);
  });

  it("answers the same for an unknown id and for another session's result", async () => {
    const { store } = await make();
    const result = await stored(store, SESSION, "x");
    expect(store.get(OTHER, result.id)).toBeUndefined();
    expect(store.get(SESSION, "r_AAAAAAAAAAAAAAAA")).toBeUndefined();
  });

  it("does not look up anything that is not shaped like a result id", async () => {
    const { store } = await make();
    for (const id of ["", "../x", "/etc/passwd", "r_short", "r_" + "A".repeat(17), "x_AAAAAAAAAAAAAAAA", "r_AAAAAAAAAAAAAAA/"]) {
      expect(store.get(SESSION, id), id).toBeUndefined();
    }
  });
});

describe("ResultStore: removing and starting", () => {
  it("deletes a session's files and forgets its results, and leaves other sessions alone", async () => {
    const { dir, store } = await make();
    const mine = await stored(store, SESSION, "mine");
    const theirs = await stored(store, OTHER, "theirs");
    await store.removeSession(SESSION);
    expect(existsSync(join(dir, SESSION))).toBe(false);
    expect(store.get(SESSION, mine.id)).toBeUndefined();
    expect(store.usedBytes(SESSION)).toBe(0);
    expect(store.get(OTHER, theirs.id)).toBe(theirs);
    expect(readFileSync(theirs.file, "utf8")).toBe("theirs");
  });

  it("can remove a session that stored nothing, and can be asked twice", async () => {
    const { store } = await make();
    await store.removeSession(SESSION);
    await store.removeSession(SESSION);
    await store.removeSession("../not-a-session");
  });

  it("frees a session's cap when it is removed and recreated", async () => {
    const { store } = await make(10);
    await stored(store, SESSION, "a".repeat(10));
    await store.removeSession(SESSION);
    expect(await store.put(SESSION, "t", "b".repeat(10), undefined)).not.toBe("full");
  });

  it("empties the directory at startup, whatever is in it", async () => {
    const dir = join(tempDir("rea-mcp-results-"), "results");
    mkdirSync(join(dir, SESSION), { recursive: true });
    writeFileSync(join(dir, SESSION, "r_old.txt"), "left by an earlier run");
    writeFileSync(join(dir, "stray.txt"), "x");
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    await new ResultStore({ dir }).init();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("creates the directory when it is missing", async () => {
    const dir = join(tempDir("rea-mcp-results-"), "not", "yet", "results");
    await new ResultStore({ dir }).init();
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
