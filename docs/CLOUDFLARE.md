# Exposing rea-mcp through a Cloudflare Tunnel

rea-mcp speaks plain HTTP and does not terminate TLS. To reach it from Claude you need an HTTPS endpoint in
front of it. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
is one way: `cloudflared` makes an outbound-only connection to Cloudflare, so you open no inbound port.
The tunnel is set up and run by you, outside this project. Use `<host>` for your public host name and `<key>` for
your API key; neither belongs in the repository.

Evidence labels as in [`DESIGN.md`](DESIGN.md): **Source** is a vendor page read on 2026-11-14; **Ran** was run
against this project; **UNVERIFIED** has not been confirmed.

## Set-up

1. **Point a public hostname at the container.** In the tunnel's public hostname settings, route
   `<host>` to the service `http://<container>:8080`, where `<container>` is a name or address `cloudflared`
   can resolve and reach.
   - If `cloudflared` runs as a container too, put both on one user-defined Docker network and use the
     container's name. Docker's default `bridge` network does not resolve container names (Docker documents
     this; not re-checked here); there, use the host's address and the published port.
   - Prefer not to publish port 8080 to your LAN at all. If the tunnel reaches the container over a Docker
     network, the unRAID template's port mapping can be left unused or removed.
2. **Set `TRUST_PROXY=true`** on the rea-mcp container. Behind a tunnel every connection comes from
   `cloudflared`, so without it the failed-login limiter sees one source address and a single abuser can lock
   everyone out. With it, the client address is read from `CF-Connecting-IP` (then `X-Forwarded-For`).
   **Only do this when the container is reachable only through the tunnel**: if it is also open on your LAN,
   anyone there can forge those headers to dodge the limiter. (The key is still required either way.)
3. **Set `ALLOWED_HOSTS=<host>`** so `/mcp` answers only requests addressed to your host name (`403`
   otherwise). `/healthz` is exempt, so in-container health checks keep working.
4. **Do not put a Cloudflare Access service-token policy on the hostname.** The gateway authenticates with the
   `x-api-key` header, and that is the only layer clients are set up for. Access applications require their
   own `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, and "set the policy action to Service
   Auth; otherwise, Access will prompt for an identity provider login" (**Source**, Cloudflare's service-token
   page): an MCP client cannot complete that login, and the Claude connector would have to carry a second
   credential on every request. Whether the connector's request headers can carry both was not tried.
5. **Use the standard HTTPS port.** Claude connects from Anthropic's cloud and only to port 443 (**Source**,
   Anthropic's custom connector page), which a tunnel hostname provides.

Then follow the client steps in the [README](../README.md#connect-a-client).

## Timeouts and long analyses

- Cloudflare documents a default **125 s** Proxy Read Timeout, after which it returns error 524 if the origin
  has not answered; Enterprise plans can raise it (**Source**, Cloudflare's error 524 page). The design planned for
  "roughly 100 s" to leave margin. What Cloudflare does with a response that has started but then goes quiet,
  and the idle limit for a tunnel specifically, are **UNVERIFIED**; plan for the lower figure.
- The gateway answers a request with an event stream at once and writes an SSE comment (`: keepalive`) every
  15 s while a call is open, which keeps an idle timeout from firing (**Ran**, with a time-scaled 120 s call
  through a proxy stub that drops silent connections, and with real Ghidra calls of 11 to 45 s). It also forwards
  REA's progress notifications.
- Keep-alives do not help against an **absolute** cap on duration. Analysis of a very large binary that runs
  past the cap will fail at the proxy. What the gateway and REA then do with the call, whose stream is closed
  (the code drops messages for a closed stream), and whether a retry succeeds, were not tested: **UNVERIFIED**.
  Measure with your own targets: `docs/DESIGN.md` section 11.5 has the timings of the samples.

## The failed-login limiter and Claude

The gateway answers `429` with `Retry-After` after 10 failed key checks from one source address in 60 s, and
does not check the key while an address is limited. Claude's connectors connect from Anthropic's shared
addresses (**Source**), so with `TRUST_PROXY=true` that address is what the limiter sees for them. A connector
configured with the wrong key can therefore trip the limit for every connector call from that address until the
window ends. If calls suddenly return `429`, check the key first.

## Checks

- `curl -i https://<host>/healthz` returns `200` and `{"status":"ok"}`.
- The same with a request to `https://<host>/mcp` and no key returns `401` and an empty body.
- Not yet done: the same from the claude.ai connector and from Claude Code through the tunnel (task 8.3).
