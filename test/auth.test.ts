import { timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyVerifier, type DigestCompare } from "../src/auth.js";
import { randomKey } from "./helpers/keys.js";

/** A comparison that records what it was asked to compare, then compares for real. */
const spy = () => {
  const calls: { a: number; b: number }[] = [];
  const compare: DigestCompare = (a, b) => {
    calls.push({ a: a.length, b: b.length });
    return timingSafeEqual(a, b);
  };
  return { calls, compare };
};

describe("createKeyVerifier", () => {
  const [one, two, three] = [randomKey(), randomKey(40), randomKey(33)];

  it("accepts the right key and rejects a wrong one", () => {
    const verifier = createKeyVerifier([one]);
    expect(verifier.verify(one)).toBe(true);
    expect(verifier.verify(randomKey())).toBe(false);
  });

  it("rejects a missing header, an empty value and a repeated header", () => {
    const verifier = createKeyVerifier([one]);
    expect(verifier.verify(undefined)).toBe(false);
    expect(verifier.verify("")).toBe(false);
    expect(verifier.verify([one, one])).toBe(false);
  });

  it("accepts any one of several keys, for rotation", () => {
    const verifier = createKeyVerifier([one, two, three]);
    for (const key of [one, two, three]) expect(verifier.verify(key)).toBe(true);
    expect(verifier.verify(randomKey())).toBe(false);
  });

  it("is case-sensitive and exact: no prefix, suffix or padding matches", () => {
    const verifier = createKeyVerifier([one]);
    expect(verifier.verify(one.toUpperCase())).toBe(false);
    expect(verifier.verify(one.slice(0, -1))).toBe(false);
    expect(verifier.verify(`${one}x`)).toBe(false);
    expect(verifier.verify(` ${one}`)).toBe(false);
  });

  it("rejects values shorter or longer than every key without throwing", () => {
    const verifier = createKeyVerifier([one, two]);
    for (const presented of ["a", one.slice(0, 31), `${one}${one}`, "z".repeat(200_000)]) {
      expect(verifier.verify(presented)).toBe(false);
    }
  });

  it("accepts a non-ASCII key sent as its UTF-8 bytes (a Latin-1 header string)", () => {
    const key = `ключ-${randomKey(40)}`;
    const wire = Buffer.from(key, "utf8").toString("latin1");
    expect(createKeyVerifier([key]).verify(wire)).toBe(true);
    expect(createKeyVerifier([key]).verify(key)).toBe(false);
  });

  it("never throws, whatever it is given", () => {
    const verifier = createKeyVerifier([one, two]);
    for (let i = 0; i < 300; i += 1) {
      const presented = Buffer.from(randomKey(1 + (i % 97)), "hex").toString("latin1");
      expect(() => verifier.verify(presented)).not.toThrow();
    }
  });
});

describe("createKeyVerifier evaluates every accepted key", () => {
  const keys = [randomKey(), randomKey(), randomKey()];

  it.each([
    ["the first key", 0],
    ["the last key", 2],
  ])("runs all comparisons when the presented key is %s", (_label, index) => {
    const { calls, compare } = spy();
    expect(createKeyVerifier(keys, compare).verify(keys[index])).toBe(true);
    expect(calls).toHaveLength(keys.length);
  });

  it("runs all comparisons when nothing matches", () => {
    const { calls, compare } = spy();
    expect(createKeyVerifier(keys, compare).verify(randomKey())).toBe(false);
    expect(calls).toHaveLength(keys.length);
  });

  it("runs all comparisons for a missing header", () => {
    const { calls, compare } = spy();
    expect(createKeyVerifier(keys, compare).verify(undefined)).toBe(false);
    expect(calls).toHaveLength(keys.length);
  });

  it("only ever compares 32-byte digests, so lengths cannot reach the primitive", () => {
    const { calls, compare } = spy();
    const verifier = createKeyVerifier([randomKey(32), randomKey(500)], compare);
    for (const presented of ["x", randomKey(32), randomKey(5000), undefined]) verifier.verify(presented);
    expect(calls.length).toBe(8);
    expect(calls.every((call) => call.a === 32 && call.b === 32)).toBe(true);
  });

  it("accepts no one when no keys are configured", () => {
    expect(createKeyVerifier([]).verify(randomKey())).toBe(false);
  });
});
