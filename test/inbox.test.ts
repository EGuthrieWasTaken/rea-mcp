import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkName, Inbox, InboxError, MAX_NAME_BYTES } from "../src/transfer/inbox.js";
import { tempDir } from "./helpers/tmp.js";

const make = () => {
  const dir = join(tempDir(), "inbox");
  mkdirSync(dir);
  return { dir, inbox: new Inbox(dir) };
};

const receive = async (inbox: Inbox, content: string) => {
  const incoming = await inbox.begin();
  await incoming.write(Buffer.from(content));
  return incoming;
};

const failureOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InboxError) return error.failure;
    throw error;
  }
  throw new Error("expected an InboxError");
};

describe("checkName", () => {
  it.each(["sample.dll", "a", "my file (1).exe", "no-extension", "über.bin", "日本語.bin", "emoji 🙂.bin", "dots.in.the.middle", "UPPER.BIN"])(
    "accepts %j",
    (name) => {
      expect(checkName(name)).toEqual({ ok: true });
    },
  );

  it("accepts 200 bytes and refuses 201, counting UTF-8 bytes and not characters", () => {
    expect(checkName("a".repeat(MAX_NAME_BYTES)).ok).toBe(true);
    expect(checkName("a".repeat(MAX_NAME_BYTES + 1)).ok).toBe(false);
    const sixtyCharacters180Bytes = "日".repeat(60);
    expect(Buffer.byteLength(sixtyCharacters180Bytes)).toBe(180);
    expect(checkName(sixtyCharacters180Bytes).ok).toBe(true);
    const seventyCharacters210Bytes = "日".repeat(70);
    expect(checkName(seventyCharacters210Bytes).ok).toBe(false);
  });

  it.each([
    ["a name with a slash", "dir/file"],
    ["a name with a backslash", "dir\\file"],
    ["a path out of the directory", "../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["dot", "."],
    ["dot dot", ".."],
    ["a leading dot", ".hidden"],
    ["a temp-file lookalike", ".upload-0123456789abcdef.tmp"],
    ["an empty name", ""],
    ["a NUL", "a\0b"],
    ["a newline", "a\nb"],
    ["a tab", "a\tb"],
    ["an escape character", "a\u001bb"],
    ["DEL", "a\u007fb"],
    ["a C1 control", "a\u0085b"],
    ["a line separator", "a\u2028b"],
    ["a right-to-left override", "gpj.\u202etxt"],
    ["a lone surrogate", "a\ud800b"],
  ])("refuses %s", (_label, name) => {
    expect(checkName(name).ok).toBe(false);
  });

  it("refuses a value that is not a string", () => {
    for (const value of [undefined, null, 5, {}, ["a"]]) expect(checkName(value).ok).toBe(false);
  });

  it("gives a reason that does not repeat the name", () => {
    const result = checkName("secret-marker/../x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("secret-marker");
  });
});

describe("Inbox: receiving a file", () => {
  it("makes a file appear whole under its name, readable by the group and not executable", async () => {
    const { dir, inbox } = make();
    const incoming = await receive(inbox, "hello");
    expect(readdirSync(dir).some((entry) => entry === "a.bin")).toBe(false); // not visible yet
    await incoming.commit("a.bin", false);
    expect(readFileSync(join(dir, "a.bin"), "utf8")).toBe("hello");
    const mode = statSync(join(dir, "a.bin")).mode & 0o777;
    expect(mode & 0o111).toBe(0);
    expect(mode & 0o600).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["a.bin"]);
  });

  it("keeps the content in the order it was written", async () => {
    const { dir, inbox } = make();
    const incoming = await inbox.begin();
    for (const part of ["one ", "two ", "three"]) await incoming.write(Buffer.from(part));
    await incoming.commit("parts.txt", false);
    expect(readFileSync(join(dir, "parts.txt"), "utf8")).toBe("one two three");
  });

  it("leaves nothing behind when the file is aborted, and abort can be repeated", async () => {
    const { dir, inbox } = make();
    const incoming = await receive(inbox, "partial");
    await incoming.abort();
    await incoming.abort();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not replace an existing file without overwrite, and leaves no temporary file", async () => {
    const { dir, inbox } = make();
    writeFileSync(join(dir, "a.bin"), "original");
    const incoming = await receive(inbox, "new");
    expect(await failureOf(incoming.commit("a.bin", false))).toBe("exists");
    expect(readFileSync(join(dir, "a.bin"), "utf8")).toBe("original");
    expect(readdirSync(dir)).toEqual(["a.bin"]);
  });

  it("does not replace a file that appeared after the upload began", async () => {
    const { dir, inbox } = make();
    const incoming = await receive(inbox, "new");
    writeFileSync(join(dir, "late.bin"), "created meanwhile");
    expect(await failureOf(incoming.commit("late.bin", false))).toBe("exists");
    expect(readFileSync(join(dir, "late.bin"), "utf8")).toBe("created meanwhile");
    expect(readdirSync(dir)).toEqual(["late.bin"]);
  });

  it("replaces a regular file when overwrite is allowed", async () => {
    const { dir, inbox } = make();
    writeFileSync(join(dir, "a.bin"), "original");
    const incoming = await receive(inbox, "replacement");
    await incoming.commit("a.bin", true);
    expect(readFileSync(join(dir, "a.bin"), "utf8")).toBe("replacement");
    expect(readdirSync(dir)).toEqual(["a.bin"]);
  });

  it("refuses to replace a symlink, even with overwrite, and writes nothing through it", async () => {
    const { dir, inbox } = make();
    const outside = join(tempDir(), "outside.txt");
    writeFileSync(outside, "outside original");
    symlinkSync(outside, join(dir, "link.bin"));
    const incoming = await receive(inbox, "attack");
    expect(await failureOf(incoming.commit("link.bin", true))).toBe("not_regular");
    expect(readFileSync(outside, "utf8")).toBe("outside original");
    expect(lstatSync(join(dir, "link.bin")).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir)).toEqual(["link.bin"]);
  });

  it("does not follow a dangling symlink when overwrite is off", async () => {
    const { dir, inbox } = make();
    const target = join(tempDir(), "does-not-exist.txt");
    symlinkSync(target, join(dir, "dangling.bin"));
    const incoming = await receive(inbox, "attack");
    expect(await failureOf(incoming.commit("dangling.bin", false))).toBe("exists");
    expect(lstatSync(join(dir, "dangling.bin")).isSymbolicLink()).toBe(true);
    expect(() => statSync(target)).toThrow();
  });

  it("refuses to replace a directory", async () => {
    const { dir, inbox } = make();
    mkdirSync(join(dir, "folder"));
    const incoming = await receive(inbox, "x");
    expect(await failureOf(incoming.commit("folder", true))).toBe("not_regular");
    expect(readdirSync(dir)).toEqual(["folder"]);
  });

  it("refuses an invalid name at commit time and leaves no temporary file", async () => {
    const { dir, inbox } = make();
    const incoming = await receive(inbox, "x");
    expect(await failureOf(incoming.commit("../escape", false))).toBe("invalid_name");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("gives every incoming file its own temporary name", async () => {
    const { dir, inbox } = make();
    const first = await receive(inbox, "1");
    const second = await receive(inbox, "2");
    expect(readdirSync(dir)).toHaveLength(2);
    await first.commit("one", false);
    await second.commit("two", false);
    expect(readFileSync(join(dir, "one"), "utf8")).toBe("1");
    expect(readFileSync(join(dir, "two"), "utf8")).toBe("2");
  });
});

describe("Inbox: inspecting the directory", () => {
  it("says whether a name exists, counting a symlink", async () => {
    const { dir, inbox } = make();
    writeFileSync(join(dir, "here"), "x");
    symlinkSync(join(tempDir(), "nowhere"), join(dir, "linked"));
    expect(await inbox.exists("here")).toBe(true);
    expect(await inbox.exists("linked")).toBe(true);
    expect(await inbox.exists("absent")).toBe(false);
  });

  it("adds up regular files, temporary ones included, and ignores directories and links", async () => {
    const { dir, inbox } = make();
    writeFileSync(join(dir, "a"), "12345");
    writeFileSync(join(dir, "b"), "123");
    mkdirSync(join(dir, "folder"));
    symlinkSync(join(dir, "a"), join(dir, "link"));
    const incoming = await receive(inbox, "1234567");
    expect(await inbox.usedBytes()).toBe(5 + 3 + 7);
    await incoming.abort();
    expect(await inbox.usedBytes()).toBe(8);
  });

  it("removes stray temporary files and nothing else", async () => {
    const { dir, inbox } = make();
    writeFileSync(join(dir, ".upload-0123456789abcdef.tmp"), "stray");
    writeFileSync(join(dir, ".upload-fedcba9876543210.tmp"), "stray");
    writeFileSync(join(dir, "keep.bin"), "keep");
    writeFileSync(join(dir, ".upload-notahexname.tmp"), "not ours");
    writeFileSync(join(dir, "report.upload-0123456789abcdef.tmp"), "not ours either");
    expect(await inbox.sweepTemporary()).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([".upload-notahexname.tmp", "keep.bin", "report.upload-0123456789abcdef.tmp"]);
  });
});
