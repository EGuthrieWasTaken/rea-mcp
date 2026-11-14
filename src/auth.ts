// Constant-time API key verification (spec: api-key-auth, "Constant-time key
// comparison"; design D4). Both the presented value and every accepted key are
// reduced to fixed-length SHA-256 digests before they are compared, so the
// comparison primitive never sees a length difference, and every accepted key is
// always evaluated so a match on an early key takes as long as no match at all.
import { createHash, timingSafeEqual } from "node:crypto";

export interface KeyVerifier {
  /** True when `presented` is exactly one of the accepted keys. Never throws. */
  verify(presented: string | readonly string[] | undefined): boolean;
}

/** The comparison primitive; injectable only so tests can count its calls. */
export type DigestCompare = (a: Buffer, b: Buffer) => boolean;

const digest = (bytes: Buffer): Buffer => createHash("sha256").update(bytes).digest();

export function createKeyVerifier(
  keys: readonly string[],
  compare: DigestCompare = timingSafeEqual,
): KeyVerifier {
  // Only digests are kept: the plaintext keys are not retained by the verifier.
  // Keys are text from the environment, so their bytes are UTF-8.
  const accepted = keys.map((key) => digest(Buffer.from(key, "utf8")));

  return {
    verify(presented) {
      const isText = typeof presented === "string";
      // Node decodes header values as Latin-1, so re-encoding as Latin-1 recovers
      // the bytes the client sent. A missing or repeated header hashes as empty
      // input and is still run through every comparison below.
      const candidate = digest(Buffer.from(isText ? presented : "", "latin1"));

      let matches = 0;
      for (const key of accepted) {
        // No early exit and no short-circuit: always evaluate every key.
        matches |= Number(compare(candidate, key));
      }
      return isText && matches !== 0;
    },
  };
}
