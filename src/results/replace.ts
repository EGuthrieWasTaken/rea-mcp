// Replacing an oversized result with a stub (spec: result-paging, "Oversized results are replaced by a stub", "What is
// stored and what is kept"; design D3). Pure functions: the store and the relay do the I/O.

/** The preview in a stub: the first this many characters of the stored text. */
export const PREVIEW_CHARS = 2000;

/** What a client is told to do with the stub. */
const NOTE_STORED =
  "The full output was too large to send in one piece, so it is stored. Read it in pieces with read_result (result_id, offset, length), or get all of it with request_download and run the curl command it returns. The stored text is deleted when this session ends, which happens after a few minutes without any request, so read or download it soon; if it is gone, run the call again. chars counts characters; bytes, and the offset and length of read_result, count UTF-8 bytes. Asking REA for less (a smaller limit, a summary, a narrower range) also gives a smaller result.";
const NOTE_NOT_STORED =
  "The full output was too large to send in one piece and could not be stored, because this session's stored results are full. Ask REA for less (a smaller limit, a summary, a narrower range).";

/** The length of a result as the client receives it: its serialized JSON, `content` and `structuredContent` both counted. */
export const resultSize = (result: unknown): number => JSON.stringify(result).length;

type Item = Record<string, unknown>;

const isItem = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);
const isTextItem = (item: Item): item is Item & { text: string } => item.type === "text" && typeof item.text === "string";

/**
 * What would be stored for this result: the text of its `text` content items joined by a blank line, or, if there is none,
 * the JSON of its `structuredContent`. Undefined when there is nothing to store.
 */
export function extractText(result: Record<string, unknown>): string | undefined {
  const content = Array.isArray(result.content) ? (result.content as unknown[]).filter(isItem) : [];
  const text = content
    .filter(isTextItem)
    .map((item) => item.text)
    .join("\n\n");
  if (text !== "") return text;
  if (result.structuredContent !== undefined && result.structuredContent !== null) return JSON.stringify(result.structuredContent);
  return undefined;
}

/** The first `limit` characters, without cutting a surrogate pair in two. */
export function previewOf(text: string, limit = PREVIEW_CHARS): string {
  if (text.length <= limit) return text;
  const cut = text.charCodeAt(limit - 1);
  const splitsPair = cut >= 0xd800 && cut <= 0xdbff;
  return text.slice(0, splitsPair ? limit - 1 : limit);
}

export interface StubInfo {
  /** The stored result's id, or null when it could not be stored. */
  resultId: string | null;
  tool: string;
  chars: number;
  bytes: number;
  preview: string;
}

/** The JSON the stub carries as text. */
export function stubJson(info: StubInfo): string {
  const stored = info.resultId !== null;
  return JSON.stringify({
    truncated: true,
    reason: "result_too_large",
    result_id: info.resultId,
    tool: info.tool,
    chars: info.chars,
    bytes: info.bytes,
    preview: info.preview,
    stored,
    note: stored ? NOTE_STORED : NOTE_NOT_STORED,
  });
}

/**
 * The result the client gets instead: the stub as one text item, any non-text items after it, no `structuredContent`, and
 * every other field (`_meta`, `isError`) as it was.
 */
export function replaceResult(result: Record<string, unknown>, info: StubInfo): Record<string, unknown> {
  const { content, structuredContent: _dropped, ...rest } = result;
  void _dropped;
  const others = (Array.isArray(content) ? (content as unknown[]) : []).filter((item) => !(isItem(item) && isTextItem(item)));
  return { ...rest, content: [{ type: "text", text: stubJson(info) }, ...others] };
}
