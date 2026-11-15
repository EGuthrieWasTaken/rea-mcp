// The inbox: where uploaded files land (spec: file-transfer, "The inbox", "Upload commit"; design D7, D8).
//
// One flat directory, /work/inbox, shared by every session. A file is written to a temporary name inside
// it, so the final rename or link is on one filesystem and atomic, and appears under its real name only
// once it is whole. Names come from the caller, so they are validated twice: when the ticket is asked for
// (so the agent hears about a bad name before it uploads anything) and here, before any write. A valid
// name is a single path component, so no name can reach outside the directory.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/** Longest file name, in bytes of UTF-8. (Most filesystems allow 255; this leaves room for the temp prefix.) */
export const MAX_NAME_BYTES = 200;

/** Files in the inbox are readable by the owner and by the `users` group (so the share can be browsed), never executable. */
const FILE_MODE = 0o640;

const TEMP_PREFIX = ".upload-";
const TEMP_SUFFIX = ".tmp";
const TEMP_NAME = /^\.upload-[0-9a-f]{16}\.tmp$/;

// C0 and C1 controls (including NUL and DEL), the Unicode line and paragraph separators, and the bidirectional
// controls that make a name read differently from how it is spelled.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export type NameCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Whether `name` may be the name of an uploaded file. The reason is for the agent and says nothing about the system. */
export function checkName(name: unknown): NameCheck {
  if (typeof name !== "string" || name === "") return { ok: false, reason: "the name must be a non-empty string" };
  if (!name.isWellFormed()) return { ok: false, reason: "the name is not valid text" };
  if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
    return { ok: false, reason: `the name is longer than ${MAX_NAME_BYTES} bytes in UTF-8` };
  }
  if (name.includes("/") || name.includes("\\")) {
    return { ok: false, reason: "the name must be a file name, not a path: it cannot contain / or \\" };
  }
  if (name === "." || name === ".." || name.startsWith(".")) {
    return { ok: false, reason: "the name cannot start with a dot" };
  }
  if (FORBIDDEN_CHARACTER.test(name)) {
    return { ok: false, reason: "the name cannot contain control or direction-changing characters" };
  }
  return { ok: true };
}

export type InboxFailure = "exists" | "not_regular" | "invalid_name";

/** An upload that cannot be put in place for a reason the uploader or agent should hear about. */
export class InboxError extends Error {
  readonly failure: InboxFailure;
  constructor(failure: InboxFailure, message: string) {
    super(message);
    this.name = "InboxError";
    this.failure = failure;
  }
}

const errno = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** A file being received. Exactly one of `commit` and `abort` should end it; `abort` is always safe to call. */
export class Incoming {
  private closed = false;
  private done = false;

  constructor(
    private readonly inbox: Inbox,
    private readonly handle: FileHandle,
    private readonly tempPath: string,
  ) {}

  write(chunk: Buffer): Promise<unknown> {
    return this.handle.write(chunk);
  }

  /**
   * Make the file visible as `name`. With `overwrite` false this never replaces an existing entry, even one
   * created after the ticket was issued (a hard link fails if the name exists, atomically). With `overwrite`
   * true it replaces a regular file by rename, and refuses a symlink or a directory.
   */
  async commit(name: string, overwrite: boolean): Promise<void> {
    try {
      const checked = checkName(name);
      if (!checked.ok) throw new InboxError("invalid_name", checked.reason);
      const finalPath = this.inbox.pathOf(name);
      await this.handle.sync();
      await this.close();
      if (overwrite) {
        const existing = await lstat(finalPath).catch((error: unknown) => {
          if (errno(error) === "ENOENT") return undefined;
          throw error;
        });
        if (existing !== undefined && !existing.isFile()) {
          throw new InboxError("not_regular", "a file with that name exists and is not a regular file, so it is not replaced");
        }
        await rename(this.tempPath, finalPath);
      } else {
        try {
          await link(this.tempPath, finalPath);
        } catch (error) {
          if (errno(error) === "EEXIST") throw new InboxError("exists", "a file with that name already exists");
          throw error;
        }
        await unlink(this.tempPath);
      }
      this.done = true;
    } catch (error) {
      await this.abort();
      throw error;
    }
    await this.inbox.syncDirectory();
  }

  /** Throw the file away. */
  async abort(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.close();
    await unlink(this.tempPath).catch(() => undefined);
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close().catch(() => undefined);
  }
}

export class Inbox {
  constructor(readonly dir: string) {}

  /** The path an uploaded file with this (valid) name has. */
  pathOf(name: string): string {
    return join(this.dir, name);
  }

  /** Whether anything is at `name`. A symlink counts, whatever it points at. */
  async exists(name: string): Promise<boolean> {
    try {
      await lstat(this.pathOf(name));
      return true;
    } catch (error) {
      if (errno(error) === "ENOENT") return false;
      throw error;
    }
  }

  /** Bytes held by regular files here, temporary files included: they use the disk too. */
  async usedBytes(): Promise<number> {
    let total = 0;
    for (const entry of await readdir(this.dir)) {
      const stats = await lstat(join(this.dir, entry)).catch(() => undefined);
      if (stats?.isFile() === true) total += stats.size;
    }
    return total;
  }

  /** Remove temporary files an earlier run left behind. Returns how many. */
  async sweepTemporary(): Promise<number> {
    let removed = 0;
    for (const entry of await readdir(this.dir)) {
      if (!TEMP_NAME.test(entry)) continue;
      const stats = await lstat(join(this.dir, entry)).catch(() => undefined);
      if (stats?.isFile() !== true) continue;
      await unlink(join(this.dir, entry)).then(
        () => {
          removed += 1;
        },
        () => undefined,
      );
    }
    return removed;
  }

  /** Start receiving a file. */
  async begin(): Promise<Incoming> {
    const tempPath = join(this.dir, `${TEMP_PREFIX}${randomBytes(8).toString("hex")}${TEMP_SUFFIX}`);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const handle = await open(tempPath, flags, FILE_MODE);
    return new Incoming(this, handle, tempPath);
  }

  /** Best effort: make a rename or link durable. */
  async syncDirectory(): Promise<void> {
    try {
      const handle = await open(this.dir, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Not every filesystem allows it; the file itself was already synced.
    }
  }
}
