import { describe, expect, it } from "vitest";
import { extractText, PREVIEW_CHARS, previewOf, replaceResult, resultSize, stubJson } from "../src/results/replace.js";

const info = { resultId: "r_AAAAAAAAAAAAAAAA", tool: "list_strings", chars: 10, bytes: 12, preview: "pre" };
const stubOf = (result: Record<string, unknown>): Record<string, unknown> => {
  const item = (result.content as { text: string }[])[0];
  return JSON.parse(item?.text ?? "null") as Record<string, unknown>;
};

describe("resultSize", () => {
  it("is the length of the serialized result, structured content included", () => {
    const result = { content: [{ type: "text", text: "abc" }], structuredContent: { a: 1 } };
    expect(resultSize(result)).toBe(JSON.stringify(result).length);
    expect(resultSize(result)).toBeGreaterThan(resultSize({ content: result.content }));
  });
});

describe("extractText", () => {
  it("joins the text items with a blank line and ignores other items", () => {
    const result = {
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "second" },
      ],
      structuredContent: { ignored: true },
    };
    expect(extractText(result)).toBe("first\n\nsecond");
  });

  it("falls back to the JSON of the structured content when there is no text", () => {
    expect(extractText({ content: [], structuredContent: { rows: [1, 2] } })).toBe('{"rows":[1,2]}');
    expect(extractText({ content: [{ type: "text", text: "" }], structuredContent: { a: 1 } })).toBe('{"a":1}');
    expect(extractText({ structuredContent: [1] })).toBe("[1]");
  });

  it("is undefined when there is nothing to store", () => {
    expect(extractText({})).toBeUndefined();
    expect(extractText({ content: [] })).toBeUndefined();
    expect(extractText({ content: [{ type: "image", data: "AAAA" }] })).toBeUndefined();
    expect(extractText({ content: "not an array", structuredContent: null })).toBeUndefined();
  });

  it("ignores malformed items without throwing", () => {
    expect(extractText({ content: [null, 5, "x", [], { type: "text" }, { type: "text", text: 7 }, { type: "text", text: "ok" }] })).toBe("ok");
  });
});

describe("previewOf", () => {
  it("is the text itself when it is short", () => {
    expect(previewOf("short")).toBe("short");
    expect(previewOf("a".repeat(PREVIEW_CHARS))).toHaveLength(PREVIEW_CHARS);
  });

  it("is the first 2000 characters of a long text", () => {
    const text = "0123456789".repeat(500);
    expect(previewOf(text)).toBe(text.slice(0, PREVIEW_CHARS));
  });

  it("does not cut a surrogate pair in two", () => {
    const text = `${"a".repeat(PREVIEW_CHARS - 1)}🙂${"b".repeat(100)}`;
    const preview = previewOf(text);
    expect(preview).toBe("a".repeat(PREVIEW_CHARS - 1));
    expect(preview.isWellFormed()).toBe(true);
    const exact = `${"a".repeat(PREVIEW_CHARS - 2)}🙂${"b".repeat(100)}`;
    expect(previewOf(exact)).toBe(`${"a".repeat(PREVIEW_CHARS - 2)}🙂`);
  });
});

describe("stubJson", () => {
  it("carries the documented fields and names read_result and request_download", () => {
    const stub = JSON.parse(stubJson(info)) as Record<string, unknown>;
    expect(stub).toMatchObject({
      truncated: true,
      reason: "result_too_large",
      result_id: "r_AAAAAAAAAAAAAAAA",
      tool: "list_strings",
      chars: 10,
      bytes: 12,
      preview: "pre",
      stored: true,
    });
    expect(stub.note).toContain("read_result");
    expect(stub.note).toContain("request_download");
  });

  it("says plainly when the result could not be stored, and still has the preview", () => {
    const stub = JSON.parse(stubJson({ ...info, resultId: null })) as Record<string, unknown>;
    expect(stub).toMatchObject({ stored: false, result_id: null, preview: "pre" });
    expect(String(stub.note)).not.toContain("read_result");
    expect(String(stub.note)).toContain("Ask REA for less");
  });
});

describe("replaceResult", () => {
  const original = {
    _meta: { provenance: { untrusted_content: true, source: "analysis_target" } },
    content: [{ type: "text", text: "x".repeat(100) }],
    structuredContent: { big: "y".repeat(100) },
  };

  it("gives one text item holding the stub, and no structured content", () => {
    const result = replaceResult(original, info);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(stubOf(result)).toMatchObject({ truncated: true, result_id: "r_AAAAAAAAAAAAAAAA" });
  });

  it("keeps _meta and isError exactly as they were", () => {
    const result = replaceResult({ ...original, isError: true }, info);
    expect(result._meta).toEqual(original._meta);
    expect(result.isError).toBe(true);
    expect("isError" in replaceResult(original, info)).toBe(false);
  });

  it("keeps non-text items after the stub, and other fields", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const result = replaceResult({ ...original, content: [{ type: "text", text: "t" }, image], extra: 1 }, info);
    expect(result.content).toHaveLength(2);
    expect((result.content as unknown[])[1]).toEqual(image);
    expect(result.extra).toBe(1);
  });

  it("does not change the result it was given", () => {
    const copy = structuredClone(original);
    replaceResult(original, info);
    expect(original).toEqual(copy);
  });

  it("is much smaller than the result it replaces", () => {
    const big = { content: [{ type: "text", text: "z".repeat(500_000) }], structuredContent: { t: "z".repeat(500_000) } };
    const stub = replaceResult(big, { ...info, preview: previewOf("z".repeat(500_000)) });
    expect(resultSize(stub)).toBeLessThan(4000);
  });
});
