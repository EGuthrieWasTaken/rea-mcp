// Reading a byte range of a stored result without ever splitting a character (spec: result-paging, "Ranged reads of
// stored results"; design D4).
//
// Offsets and lengths are bytes of the stored UTF-8, so a read is one positioned read however large the file is. The
// range is then trimmed to character boundaries: a start inside a character moves forward to the next one, and an
// incomplete character at the end is left for the next page. `nextOffset` is always where the next page starts, so
// reading page after page reproduces the file exactly.
import { open } from "node:fs/promises";

export interface Range {
  /** Where the returned text really starts (the requested offset, moved forward to a character boundary). */
  readonly offset: number;
  readonly bytes: Buffer;
  /** Where the next page starts, or null at the end of the file. */
  readonly nextOffset: number | null;
}

/** A UTF-8 continuation byte: 10xxxxxx. */
const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** How many bytes the character that starts with `lead` takes. */
const sequenceLength = (lead: number): number => (lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1);

/**
 * `window` holds the file's bytes from `offset` for at most `length + 4` of them, and `atEnd` says whether the window
 * runs to the end of the file. Pure, so it can be tested exhaustively.
 */
export function alignRange(window: Buffer, offset: number, length: number, atEnd: boolean): Range {
  let start = 0;
  while (start < 3 && start < window.length && isContinuation(window[start] as number)) start += 1;

  let end = Math.min(start + length, window.length);
  if (end < window.length) {
    // The first byte after the slice is a continuation byte: the slice ends inside a character, so stop before it.
    while (end > start && isContinuation(window[end] as number)) end -= 1;
  }
  // A page must make progress: if the limit is smaller than one character, take that character whole.
  if (end === start && start < window.length) end = Math.min(start + sequenceLength(window[start] as number), window.length);

  const absoluteEnd = offset + end;
  const finished = atEnd && end === window.length;
  return { offset: offset + start, bytes: window.subarray(start, end), nextOffset: finished ? null : absoluteEnd };
}

/** Read `length` bytes of `file` (whose size is `total`) from `offset`. Throws a RangeError when `offset` is past the end. */
export async function readRange(file: string, total: number, offset: number, length: number): Promise<Range> {
  if (offset > total) throw new RangeError("offset is past the end");
  const wanted = Math.min(length + 4, total - offset);
  const window = Buffer.alloc(wanted);
  if (wanted > 0) {
    const handle = await open(file, "r");
    try {
      let filled = 0;
      while (filled < wanted) {
        const { bytesRead } = await handle.read(window, filled, wanted - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled < wanted) return alignRange(window.subarray(0, filled), offset, length, true);
    } finally {
      await handle.close();
    }
  }
  return alignRange(window, offset, length, offset + wanted >= total);
}
