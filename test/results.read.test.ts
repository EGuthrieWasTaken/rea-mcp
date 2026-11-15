import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignRange, readRange } from "../src/results/read.js";
import { tempDir } from "./helpers/tmp.js";

const strict = new TextDecoder("utf-8", { fatal: true });

/** Text with one-, two-, three- and four-byte characters. */
const mixed = "plain ascii é ü ñ 日本語 한국어 🙂🚀 end";

const fileWith = (text: string): { file: string; total: number } => {
  const file = join(tempDir(), "result.txt");
  writeFileSync(file, text, "utf8");
  return { file, total: Buffer.byteLength(text) };
};

/** Read a whole file page by page with the given page sizes. */
const readAll = async (file: string, total: number, sizes: () => number): Promise<string[]> => {
  const pages: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const range = await readRange(file, total, offset, sizes());
    pages.push(strict.decode(range.bytes)); // throws if a page splits a character
    expect(range.offset).toBe(offset);
    if (range.nextOffset === null) return pages;
    expect(range.nextOffset).toBeGreaterThan(offset);
    offset = range.nextOffset;
  }
  throw new Error("did not finish");
};

describe("readRange", () => {
  it("returns the whole file when the length covers it, with no next offset", async () => {
    const { file, total } = fileWith("hello world");
    const range = await readRange(file, total, 0, 1000);
    expect(range.bytes.toString()).toBe("hello world");
    expect(range.offset).toBe(0);
    expect(range.nextOffset).toBeNull();
  });

  it("returns a slice and says where the next one starts", async () => {
    const { file, total } = fileWith("0123456789");
    const range = await readRange(file, total, 2, 4);
    expect(range.bytes.toString()).toBe("2345");
    expect(range).toMatchObject({ offset: 2, nextOffset: 6 });
  });

  it("has no next offset when a slice ends exactly at the end", async () => {
    const { file, total } = fileWith("0123456789");
    expect((await readRange(file, total, 6, 4)).nextOffset).toBeNull();
    expect((await readRange(file, total, 6, 3)).nextOffset).toBe(9);
  });

  it("returns nothing, and no next offset, at exactly the end, and refuses past it", async () => {
    const { file, total } = fileWith("abc");
    const range = await readRange(file, total, 3, 10);
    expect(range.bytes.length).toBe(0);
    expect(range.nextOffset).toBeNull();
    await expect(readRange(file, total, 4, 10)).rejects.toThrow(RangeError);
  });

  it("reads an empty file", async () => {
    const { file, total } = fileWith("");
    const range = await readRange(file, total, 0, 100);
    expect(range.bytes.length).toBe(0);
    expect(range.nextOffset).toBeNull();
  });

  it("ends a slice before a character it would cut in two", async () => {
    const { file, total } = fileWith("ab日cd"); // a b [E6 97 A5] c d
    const range = await readRange(file, total, 0, 3); // would end after the first byte of 日
    expect(range.bytes.toString()).toBe("ab");
    expect(range.nextOffset).toBe(2);
    const next = await readRange(file, total, 2, 3);
    expect(next.bytes.toString()).toBe("日");
    expect(next.nextOffset).toBe(5);
  });

  it("moves a start inside a character forward to the next character", async () => {
    const { file, total } = fileWith("ab日cd");
    for (const inside of [3, 4]) {
      const range = await readRange(file, total, inside, 10);
      expect(range.offset).toBe(5);
      expect(range.bytes.toString()).toBe("cd");
    }
  });

  it("still makes progress when the length is smaller than one character", async () => {
    const { file, total } = fileWith("🙂🙂"); // two four-byte characters
    const first = await readRange(file, total, 0, 1);
    expect(first.bytes.toString()).toBe("🙂");
    expect(first.nextOffset).toBe(4);
    const second = await readRange(file, total, 4, 2);
    expect(second.bytes.toString()).toBe("🙂");
    expect(second.nextOffset).toBeNull();
  });

  it("never splits a character, whatever the page size, and the pages add up to the file", async () => {
    const { file, total } = fileWith(mixed);
    for (let size = 1; size <= total + 2; size += 1) {
      const pages = await readAll(file, total, () => size);
      expect(pages.join(""), `page size ${size}`).toBe(mixed);
    }
  });

  it("reassembles random text from random page sizes", async () => {
    const alphabet = ["a", "Z", "0", " ", "\n", "é", "ß", "日", "語", "한", "🙂", "🚀", "\u{1F9D1}‍\u{1F4BB}"];
    for (let round = 0; round < 40; round += 1) {
      const length = randomInt(0, 400);
      let text = "";
      for (let i = 0; i < length; i += 1) text += alphabet[randomInt(0, alphabet.length)];
      const { file, total } = fileWith(text);
      const pages = await readAll(file, total, () => randomInt(1, 60));
      expect(pages.join("")).toBe(text);
    }
  });
});

describe("alignRange", () => {
  it("treats a window that stops short of the file as having more to read", () => {
    const window = Buffer.from("abcdefgh");
    const range = alignRange(window, 100, 4, false);
    expect(range.bytes.toString()).toBe("abcd");
    expect(range.nextOffset).toBe(104);
  });

  it("does not skip more than three continuation bytes in data that is not UTF-8", () => {
    const window = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x41]);
    const range = alignRange(window, 0, 10, true);
    expect(range.offset).toBe(3);
  });
});
