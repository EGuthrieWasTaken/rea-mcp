import { describe, expect, it } from "vitest";
import { baseUrl } from "../src/transfer/url.js";

const open = { publicBaseUrl: undefined, trustProxy: false };
const trusted = { publicBaseUrl: undefined, trustProxy: true };

describe("baseUrl", () => {
  it("uses PUBLIC_BASE_URL before anything else, even when the request says otherwise", () => {
    const settings = { publicBaseUrl: "https://rea.example", trustProxy: true };
    expect(
      baseUrl(settings, { host: "internal:8080", forwardedHost: "other.example", forwardedProto: "http" }),
    ).toEqual({ ok: true, url: "https://rea.example", source: "PUBLIC_BASE_URL" });
  });

  it("uses the forwarded headers when the proxy is trusted", () => {
    expect(baseUrl(trusted, { host: "internal:8080", forwardedProto: "https", forwardedHost: "rea.example" })).toEqual({
      ok: true,
      url: "https://rea.example",
      source: "forwarded headers",
    });
  });

  it("takes the first entry of a forwarded list, ignores case, and defaults the scheme to http", () => {
    expect(baseUrl(trusted, { forwardedProto: "HTTPS, http", forwardedHost: "Rea.Example, other.example" })).toMatchObject({
      url: "https://rea.example",
    });
    expect(baseUrl(trusted, { forwardedHost: "rea.example:8443" })).toMatchObject({ url: "http://rea.example:8443" });
    expect(baseUrl(trusted, { forwardedProto: "gopher", forwardedHost: "rea.example" })).toMatchObject({
      url: "http://rea.example",
    });
  });

  it("uses the forwarded scheme with the Host header when only the scheme is forwarded", () => {
    expect(baseUrl(trusted, { host: "rea.example", forwardedProto: "https" })).toEqual({
      ok: true,
      url: "https://rea.example",
      source: "forwarded headers",
    });
  });

  it("ignores forwarded headers when the proxy is not trusted", () => {
    expect(baseUrl(open, { host: "rea.example:8080", forwardedProto: "https", forwardedHost: "attacker.example" })).toEqual({
      ok: true,
      url: "http://rea.example:8080",
      source: "Host header",
    });
  });

  it("falls back to the Host header, with http, when nothing else applies", () => {
    expect(baseUrl(trusted, { host: "192.168.1.5:8080" })).toMatchObject({ url: "http://192.168.1.5:8080", source: "Host header" });
    expect(baseUrl(open, { host: "[::1]:8080" })).toMatchObject({ url: "http://[::1]:8080" });
  });

  it("refuses a Host that is not a host name", () => {
    for (const host of ["evil.example/path", "a b", "ex ample.com", "rea.example@evil.example", "rea.example:99999x", ""]) {
      const result = baseUrl(open, { host });
      expect(result.ok, host).toBe(false);
    }
  });

  it("refuses a forwarded host that is not a host name, rather than falling back", () => {
    expect(baseUrl(trusted, { host: "rea.example", forwardedHost: "evil.example/path" }).ok).toBe(false);
  });

  it("explains what to do when there is no Host and no PUBLIC_BASE_URL, without echoing the header", () => {
    const missing = baseUrl(open, {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("PUBLIC_BASE_URL");
    const marker = "ZZ-marker-ZZ/x";
    const bad = baseUrl(open, { host: marker });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).not.toContain("ZZ-marker");
  });
});
