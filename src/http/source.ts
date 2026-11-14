// Source address resolution (spec: api-key-auth, "Source address resolution").
//
// The address used for rate limiting and logging is the socket peer, unless
// TRUST_PROXY=true, in which case it is taken from CF-Connecting-IP if present,
// otherwise from the first X-Forwarded-For entry. Forwarding headers are ignored
// by default because anyone can send them; they are honoured only when the
// operator says a trusted proxy (a tunnel) sets them.
import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

export interface RequestSource {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string | undefined };
}

const UNKNOWN = "unknown";

/** A valid IP address in a canonical form: lower-case, with IPv4-mapped IPv6 unwrapped. */
const normalize = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  if (isIP(text) === 0) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  return mapped?.[1] ?? text;
};

const first = (header: string | string[] | undefined): string | undefined =>
  Array.isArray(header) ? header[0] : header;

export function sourceIp(request: RequestSource, trustProxy: boolean): string {
  const peer = normalize(request.socket.remoteAddress) ?? UNKNOWN;
  if (!trustProxy) return peer;

  const cloudflare = normalize(first(request.headers["cf-connecting-ip"]));
  if (cloudflare !== undefined) return cloudflare;

  const forwarded = first(request.headers["x-forwarded-for"])?.split(",", 1)[0];
  return normalize(forwarded) ?? peer;
}
