// Stored results (spec: result-paging; design D3).
//
// A result too large to send is kept here, under /work/results/<session-id>/, so the agent can page through it with
// `read_result` or fetch it with a download ticket. The directory belongs to the session that made the result and is
// deleted when that session ends; the whole tree is emptied at startup, because a restart ends every session. Files
// are written for the gateway's user alone (0600 in a 0700 directory).
//
// Only the text is stored. The index of what has been stored (ids, sizes, the hash, the result's _meta) is in memory.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The most a session may store (fixed; design D3). */
export const SESSION_STORE_LIMIT_BYTES = 256 * 1024 * 1024;

/** The shape of a result id. Anything else is not looked up and no path is built from it. */
export const RESULT_ID = /^r_[A-Za-z0-9_-]{16}$/;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface StoredResult {
  readonly id: string;
  readonly sessionId: string;
  /** The tool that produced it. */
  readonly tool: string;
  /** Length of the text in UTF-16 code units, which is what a JavaScript string's `length` is. */
  readonly chars: number;
  /** Size of the stored file: the text in UTF-8. */
  readonly bytes: number;
  /** SHA-256 of the stored file, for the download ticket. */
  readonly sha256: string;
  /** The `_meta` of the result this came from, handed back with every read of it. */
  readonly meta: unknown;
  readonly file: string;
}

export interface ResultStoreOptions {
  /** Normally `<work>/results`. */
  dir: string;
  /** Per-session cap, injectable for tests. */
  sessionLimitBytes?: number;
}

export class ResultStore {
  private readonly dir: string;
  private readonly limit: number;
  private readonly index = new Map<string, Map<string, StoredResult>>();
  private readonly used = new Map<string, number>();

  constructor(options: ResultStoreOptions) {
    this.dir = options.dir;
    this.limit = options.sessionLimitBytes ?? SESSION_STORE_LIMIT_BYTES;
  }

  /** Create the directory if need be and empty it: results from an earlier run belong to sessions that are gone. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.dir)) await rm(join(this.dir, entry), { recursive: true, force: true });
  }

  /** Store `text` for a session. "full" when it would take the session over its cap (nothing is written). */
  async put(sessionId: string, tool: string, text: string, meta: unknown): Promise<StoredResult | "full"> {
    if (!SESSION_ID.test(sessionId)) throw new Error("not a session id");
    const data = Buffer.from(text, "utf8");
    const so_far = this.used.get(sessionId) ?? 0;
    if (so_far + data.length > this.limit) return "full";

    const id = `r_${randomBytes(12).toString("base64url")}`;
    const sessionDir = join(this.dir, sessionId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const file = join(sessionDir, `${id}.txt`);
    await writeFile(file, data, { mode: 0o600, flag: "wx" });

    const stored: StoredResult = {
      id,
      sessionId,
      tool,
      chars: text.length,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      meta,
      file,
    };
    let results = this.index.get(sessionId);
    if (results === undefined) {
      results = new Map();
      this.index.set(sessionId, results);
    }
    results.set(id, stored);
    this.used.set(sessionId, so_far + data.length);
    return stored;
  }

  /** A result of this session. The same `undefined` for an unknown id and for another session's. */
  get(sessionId: string, resultId: string): StoredResult | undefined {
    if (!RESULT_ID.test(resultId)) return undefined;
    return this.index.get(sessionId)?.get(resultId);
  }

  /** Forget a session's results and delete their files. Safe to repeat. */
  async removeSession(sessionId: string): Promise<void> {
    this.index.delete(sessionId);
    this.used.delete(sessionId);
    if (!SESSION_ID.test(sessionId)) return;
    await rm(join(this.dir, sessionId), { recursive: true, force: true });
  }

  /** Bytes a session has stored. */
  usedBytes(sessionId: string): number {
    return this.used.get(sessionId) ?? 0;
  }
}
