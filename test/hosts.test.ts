import { describe, expect, it } from "vitest";
import { createHostCheck, hostOf } from "../src/http/hosts.js";

describe("createHostCheck with an allowlist", () => {
  const check = createHostCheck(["rea.example", "localhost", "[::1]"]);

  it("allows a listed host", () => {
    expect(check.allows("rea.example")).toBe(true);
    expect(check.allows("localhost")).toBe(true);
  });

  it("allows a listed host whatever port it carries", () => {
    for (const port of ["80", "443", "8080", "65535", "1"]) {
      expect(check.allows(`rea.example:${port}`)).toBe(true);
    }
  });

  it("compares case-insensitively", () => {
    expect(check.allows("REA.Example")).toBe(true);
    expect(check.allows("LocalHost:8080")).toBe(true);
  });

  it("allows bracketed IPv6 literals, with or without a port", () => {
    expect(check.allows("[::1]")).toBe(true);
    expect(check.allows("[::1]:8080")).toBe(true);
    expect(check.allows("[::2]")).toBe(false);
  });

  it("treats a trailing dot as the same host", () => {
    expect(check.allows("rea.example.")).toBe(true);
    expect(createHostCheck(["rea.example."]).allows("rea.example")).toBe(true);
  });

  it("refuses an unlisted host", () => {
    for (const host of ["evil.example", "rea.example.evil", "xrea.example", "sub.rea.example", "example", "127.0.0.1"]) {
      expect(check.allows(host)).toBe(false);
    }
  });

  it("refuses a missing Host header", () => {
    expect(check.allows(undefined)).toBe(false);
    expect(check.allows("")).toBe(false);
  });

  it.each([
    "rea.example@evil.example",
    "evil.example/rea.example",
    "rea.example evil.example",
    "rea.example, evil.example",
    "rea.example:abc",
    "rea.example:",
    "rea.example:8080:9090",
    "rea.example:123456",
    "http://rea.example",
    "rea.example/",
    "rea.example\n",
    "rea.example%00",
    "[rea.example]",
    "*.example",
    "..",
  ])("refuses the malformed value %j rather than guessing", (value) => {
    expect(check.allows(value)).toBe(false);
  });
});

describe("createHostCheck without an allowlist", () => {
  it("restricts nothing, including a missing or odd Host header", () => {
    const check = createHostCheck([]);
    for (const host of ["rea.example", "evil.example:1", "", undefined, "anything at all"]) {
      expect(check.allows(host)).toBe(true);
    }
  });
});

describe("hostOf", () => {
  it("returns the lower-cased host without its port", () => {
    expect(hostOf("Rea.Example:8443")).toBe("rea.example");
    expect(hostOf("[::1]:80")).toBe("[::1]");
  });

  it("never throws, whatever it is given", () => {
    for (let i = 0; i < 300; i += 1) {
      const junk = String.fromCharCode(...Array.from({ length: 1 + (i % 40) }, (_, j) => (i * 31 + j * 17) % 256));
      expect(() => hostOf(junk)).not.toThrow();
    }
  });
});
