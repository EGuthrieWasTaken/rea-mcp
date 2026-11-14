import { describe, expect, it } from "vitest";
import { sourceIp, type RequestSource } from "../src/http/source.js";

const request = (headers: Record<string, string | string[]>, remoteAddress?: string): RequestSource => ({
  headers,
  socket: { remoteAddress },
});

describe("sourceIp without a trusted proxy", () => {
  it("is the socket peer", () => {
    expect(sourceIp(request({}, "203.0.113.9"), false)).toBe("203.0.113.9");
  });

  it("ignores X-Forwarded-For and CF-Connecting-IP, which anyone can send", () => {
    const spoofed = request({ "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "198.51.100.2" }, "203.0.113.9");
    expect(sourceIp(spoofed, false)).toBe("203.0.113.9");
  });

  it("unwraps an IPv4-mapped IPv6 peer address", () => {
    expect(sourceIp(request({}, "::ffff:203.0.113.9"), false)).toBe("203.0.113.9");
  });

  it("lower-cases an IPv6 peer address", () => {
    expect(sourceIp(request({}, "2001:DB8::A"), false)).toBe("2001:db8::a");
  });

  it("says unknown when the socket has no address", () => {
    expect(sourceIp(request({}, undefined), false)).toBe("unknown");
  });
});

describe("sourceIp behind a trusted proxy", () => {
  it("prefers CF-Connecting-IP", () => {
    const behind = request({ "cf-connecting-ip": "198.51.100.5", "x-forwarded-for": "198.51.100.6" }, "10.0.0.2");
    expect(sourceIp(behind, true)).toBe("198.51.100.5");
  });

  it("falls back to the first X-Forwarded-For entry", () => {
    expect(sourceIp(request({ "x-forwarded-for": "198.51.100.6, 10.0.0.3, 10.0.0.2" }, "10.0.0.2"), true)).toBe(
      "198.51.100.6",
    );
    expect(sourceIp(request({ "x-forwarded-for": " 2001:db8::7 ,10.0.0.3" }, "10.0.0.2"), true)).toBe("2001:db8::7");
  });

  it("falls back to the socket peer when no forwarding header is present", () => {
    expect(sourceIp(request({}, "10.0.0.2"), true)).toBe("10.0.0.2");
  });

  it("treats an unusable CF-Connecting-IP as absent and moves on to X-Forwarded-For", () => {
    expect(sourceIp(request({ "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "198.51.100.8" }, "10.0.0.2"), true)).toBe(
      "198.51.100.8",
    );
  });

  it.each(["", "garbage", "198.51.100.9:443", "[2001:db8::1]:80", "999.1.1.1", "198.51.100.9; DROP", "-"])(
    "refuses to take %j as an address and uses the socket peer",
    (value) => {
      const odd = request({ "x-forwarded-for": value, "cf-connecting-ip": value }, "10.0.0.2");
      expect(sourceIp(odd, true)).toBe("10.0.0.2");
    },
  );

  it("normalises a forwarded IPv4-mapped IPv6 address", () => {
    expect(sourceIp(request({ "cf-connecting-ip": "::FFFF:198.51.100.4" }, "10.0.0.2"), true)).toBe("198.51.100.4");
  });
});
