// The base of ticket URLs (spec: file-transfer, "Public URL construction"; design D9).
//
// The URL goes to the agent's own shell, so it must be an address that shell can reach, which is not
// necessarily the one the gateway sees. In order:
//   1. PUBLIC_BASE_URL, when the operator set it;
//   2. only when TRUST_PROXY is true: X-Forwarded-Proto and X-Forwarded-Host (or Host), as a trusted
//      proxy or tunnel sets them;
//   3. otherwise http:// and the request's Host.
// A Host that is not a well-formed host name is refused. Nothing here is logged.
import { wellFormedHost } from "../http/hosts.js";

export type UrlSource = "PUBLIC_BASE_URL" | "forwarded headers" | "Host header";

/** The few request headers a ticket URL may depend on. */
export interface RequestOrigin {
  host?: string | undefined;
  forwardedProto?: string | undefined;
  forwardedHost?: string | undefined;
}

export type BaseUrl =
  | { readonly ok: true; readonly url: string; readonly source: UrlSource }
  | { readonly ok: false; readonly reason: string };

export interface BaseUrlSettings {
  publicBaseUrl: string | undefined;
  trustProxy: boolean;
}

const firstValue = (header: string | undefined): string | undefined => header?.split(",", 1)[0]?.trim();

export function baseUrl(settings: BaseUrlSettings, origin: RequestOrigin): BaseUrl {
  if (settings.publicBaseUrl !== undefined) {
    return { ok: true, url: settings.publicBaseUrl, source: "PUBLIC_BASE_URL" };
  }

  if (settings.trustProxy) {
    const forwardedHost = firstValue(origin.forwardedHost);
    if (forwardedHost !== undefined && forwardedHost !== "") {
      const host = wellFormedHost(forwardedHost);
      if (host === undefined) return { ok: false, reason: "the forwarded host is not a valid host name" };
      const proto = firstValue(origin.forwardedProto)?.toLowerCase();
      return { ok: true, url: `${proto === "https" ? "https" : "http"}://${host}`, source: "forwarded headers" };
    }
    const proto = firstValue(origin.forwardedProto)?.toLowerCase();
    if (proto === "https" || proto === "http") {
      const host = wellFormedHost(origin.host);
      if (host === undefined) return noHost(origin.host);
      return { ok: true, url: `${proto}://${host}`, source: "forwarded headers" };
    }
  }

  const host = wellFormedHost(origin.host);
  if (host === undefined) return noHost(origin.host);
  return { ok: true, url: `http://${host}`, source: "Host header" };
}

const noHost = (host: string | undefined): BaseUrl => ({
  ok: false,
  reason:
    host === undefined
      ? "the request has no Host header and PUBLIC_BASE_URL is not set, so there is no address to build the URL on; the operator must set PUBLIC_BASE_URL"
      : "the request's Host header is not a valid host name, and PUBLIC_BASE_URL is not set; the operator must set PUBLIC_BASE_URL",
});
