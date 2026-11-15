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
5. **Set `PUBLIC_BASE_URL=https://<host>`** so that upload and download URLs name your public host over HTTPS. The agent
   runs `curl` against that URL from its own machine. Without it the URL is built from the `Host` header with
   `http://`; Cloudflare answers `http` with a `301` to `https` (it did, on the maintainer's host) and `curl` does not
   follow it, so the upload fails. (`TRUST_PROXY=true` also works if the tunnel sets `X-Forwarded-Proto`; that was
   not checked.)
6. **Use the standard HTTPS port.** Claude connects from Anthropic's cloud and only to port 443 (**Source**,
   Anthropic's custom connector page), which a tunnel hostname provides.

Then follow the client steps in the [README](../README.md#connect-a-client).

## Uploads and downloads through the tunnel

`PUT /upload/<id>/<secret>` and `GET /download/<id>/<secret>` are served at the same host name as `/mcp` and need
no API key (see [`SECURITY.md`](SECURITY.md)). Tried on 2026-11-15 through the maintainer's own tunnel (evidence:
[`DESIGN.md`](DESIGN.md) 18.8), with `PUBLIC_BASE_URL`, `TRUST_PROXY=true` and `ALLOWED_HOSTS` set as above:

- **Request-body limit: 100 MiB (104,857,600 bytes) (Ran).** Uploads of 1 MiB, 90 MB, 99 MB, 100 MB and exactly
  104,857,600 bytes went through and were saved; 104,857,601 bytes and 105 MB were refused with an HTML
  `413 Payload Too Large` that did not come from the gateway (the gateway's log has no 413 and its own answer is JSON).
  This matches Cloudflare's published 100 MB figure for the Free and Pro plans (a plan with a higher limit may allow
  more; which plan this is was not checked). So set `MAX_UPLOAD_BYTES=104857600` behind a tunnel on those plans: the
  agent is then told the limit when it asks for an upload, and an oversized file gets the gateway's readable `413`
  instead of Cloudflare's page. For a larger file use the `/samples` share, or point `PUBLIC_BASE_URL` at an address on
  your own network.
- **`http` is redirected (Ran).** Cloudflare answers a plain-`http` request to this host with a `301` to `https`, and
  `curl` does not follow a redirect unless told to, so an upload URL that begins with `http://` fails. That is what
  `PUBLIC_BASE_URL` prevents.
- **Cloudflare Access: not in use on this host name, so nothing was bypassed.** If an Access application covers the
  host name, `curl` would meet its login instead of the gateway, and the upload and download paths would need a bypass
  policy (an Access application for `/upload/*` and `/download/*` with a Bypass action). How to write that was **not
  verified**. (Section "Set-up", step 4, already says not to put a service-token policy on the host.)
- **Whether the agent can reach you.** `curl` run on the unRAID host itself reached the public host name. A local
  Claude Code session can do the same. The claude.ai code-execution sandbox has a network allowlist, and whether your
  host name is on it was **not checked**.

A test you can run from the machine the agent runs on, with a throwaway file and a ticket from the agent:

```bash
# Ask the agent: "Call request_upload for a file named test.bin and show me only the curl_command."
head -c 1048576 /dev/urandom > test.bin
curl -sS --fail-with-body -T test.bin '<the upload_url the agent gave you>'    # expect 200 and a sha256
sha256sum test.bin                                                           # expect the same hash
```

Then try a file just over the limit you expect (for example 101 MB) and see which error you get and from whom.

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
- An upload through the tunnel: the test below, which was run on 2026-11-15 (above).
