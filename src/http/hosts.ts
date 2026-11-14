// Host header allowlist (spec: mcp-http-gateway, "Host header allowlist").
//
// When ALLOWED_HOSTS is set, a /mcp request is accepted only if its Host header
// names one of the listed hosts, compared case-insensitively and ignoring any
// port. When it is empty or unset, nothing is restricted. The check is for DNS
// rebinding and misrouted traffic, not authentication, so it is deliberately
// strict about what counts as a well-formed Host value: anything odd is refused.

// A DNS name or a bracketed IPv6 literal, optionally followed by :port.
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.?)(:\d{1,5})?$/;

/** The comparable host of a Host header value, or undefined if it is malformed. */
export function hostOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = HOST_HEADER.exec(header.toLowerCase());
  const host = match?.[1];
  if (host === undefined) return undefined;
  // A fully qualified name may end in a dot; it names the same host.
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

export interface HostCheck {
  /** Whether a /mcp request with this Host header may proceed. */
  allows(hostHeader: string | undefined): boolean;
}

/** `allowed` holds configured hosts: lower-case, without ports (see config.ts). */
export function createHostCheck(allowed: readonly string[]): HostCheck {
  if (allowed.length === 0) return { allows: () => true };
  const hosts = new Set(allowed.map((entry) => (entry.endsWith(".") ? entry.slice(0, -1) : entry)));
  return {
    allows(hostHeader) {
      const host = hostOf(hostHeader);
      return host !== undefined && hosts.has(host);
    },
  };
}
