# Spec Delta

## MODIFIED Requirements

### Requirement: MCP streamable HTTP endpoint
The gateway SHALL serve the MCP streamable HTTP transport at `/mcp` for the
`POST`, `GET`, and `DELETE` methods, and SHALL relay MCP messages unchanged in
both directions between the HTTP client and the REA process bound to that
client's session, with these exceptions and no others: the gateway SHALL append
the tools defined by the `result-paging` and `file-transfer` capabilities to the
tools REA reports and answer calls to them itself; SHALL remove `outputSchema`
from REA's tools and replace oversized `tools/call` results, as the
`result-paging` capability defines, when `RESULT_INLINE_LIMIT_CHARS` is above
`0`; and SHALL drop a REA tool that has the name of one of its own. Resources and
prompts exposed to the client SHALL be those REA reports. A failure while
applying an exception SHALL result in the original message being delivered
unchanged.

#### Scenario: Initialize
- **WHEN** an authenticated client POSTs an MCP `initialize` request to `/mcp` without a session ID
- **THEN** the response carries REA's initialize result and an `Mcp-Session-Id` header

#### Scenario: List tools
- **WHEN** an initialized client sends `tools/list`
- **THEN** the response contains the tools reported by the underlying REA process and the gateway's own tools, and nothing else

#### Scenario: Call tool
- **WHEN** an initialized client sends `tools/call` for a tool REA provides and REA's result is within the inline limit
- **THEN** the response contains the result produced by REA for that call, unchanged

#### Scenario: Call a gateway tool
- **WHEN** an initialized client sends `tools/call` for one of the gateway's own tools
- **THEN** the gateway answers it and REA receives no message for that call

#### Scenario: Interception fails
- **WHEN** the gateway cannot rewrite a `tools/list` result or replace a `tools/call` result
- **THEN** the client receives the message REA sent, unchanged

#### Scenario: Unknown session
- **WHEN** an authenticated request carries an `Mcp-Session-Id` that does not identify a live session
- **THEN** the response is `404`

#### Scenario: Unsupported method
- **WHEN** a request to `/mcp` uses a method other than `POST`, `GET`, or `DELETE`
- **THEN** the response is `405`

### Requirement: Unknown paths
The gateway SHALL respond `404` with no detail to any path other than `/mcp`,
`/healthz`, `/upload/<id>/<secret>` and `/download/<id>/<secret>`. A path under
`/upload/` or `/download/` that does not have exactly an id and a secret segment
SHALL be treated as an unknown path.

#### Scenario: Unknown path
- **WHEN** a client requests `/` or any other undefined path
- **THEN** the response is `404` and reveals nothing about the service

#### Scenario: A malformed transfer path
- **WHEN** a client requests `/upload/`, `/upload/<id>` or `/upload/<id>/<secret>/extra`
- **THEN** the response is `404` with no detail and no failed-attempt is recorded for a ticket

### Requirement: Host header allowlist
When `ALLOWED_HOSTS` is set to a non-empty comma-separated list, the gateway
SHALL reject with `403` any request to `/mcp`, `/upload/...` or `/download/...`
whose `Host` header, compared case-insensitively and ignoring any port, is not in
the list. When `ALLOWED_HOSTS` is empty or unset, the gateway SHALL NOT restrict
by `Host`. `/healthz` SHALL NOT be subject to the allowlist, so that in-container
health checks work.

#### Scenario: Allowed host
- **WHEN** `ALLOWED_HOSTS` lists a hostname and a request arrives with that `Host`
- **THEN** the request proceeds to authentication

#### Scenario: Disallowed host
- **WHEN** `ALLOWED_HOSTS` is set and a request to `/mcp` arrives with a `Host` not in the list
- **THEN** the response is `403`, even if the request carries a correct key

#### Scenario: Disallowed host on a transfer route
- **WHEN** `ALLOWED_HOSTS` is set and a request to `/upload/<id>/<secret>` arrives with a `Host` not in the list
- **THEN** the response is `403`, even if the id and secret are those of a live ticket, and the ticket is not claimed

#### Scenario: Allowlist disabled
- **WHEN** `ALLOWED_HOSTS` is unset
- **THEN** requests are not rejected on the basis of `Host`

#### Scenario: Health check exempt
- **WHEN** `ALLOWED_HOSTS` is set and `GET /healthz` arrives with `Host: localhost:8080`
- **THEN** the response is `200`

### Requirement: Environment-variable configuration
The gateway SHALL be configured solely through environment variables with the
following defaults: `PORT` = `8080`, `MAX_SESSIONS` = `4`,
`SESSION_IDLE_TIMEOUT_SEC` = `300`, `TRUST_PROXY` = `false`, `ALLOWED_HOSTS` =
empty, `LOG_LEVEL` = `info`, `PUBLIC_BASE_URL` = empty, `MAX_UPLOAD_BYTES` =
`268435456`, `INBOX_MAX_BYTES` = `4294967296`, `TRANSFER_TICKET_TTL_SEC` = `900`,
`RESULT_INLINE_LIMIT_CHARS` = `40000`. `RESULT_INLINE_LIMIT_CHARS` SHALL be `0` or
from `2000` to `10000000`. A variable set to a value that cannot be parsed for its
type, or that is outside its range, SHALL cause the gateway to exit non-zero at
startup, naming the variable.

#### Scenario: Defaults
- **WHEN** only an API key is configured
- **THEN** the gateway listens on port 8080 with the documented defaults

#### Scenario: Invalid value
- **WHEN** `MAX_SESSIONS` is set to a non-numeric value
- **THEN** the gateway exits non-zero and names `MAX_SESSIONS` in its error

#### Scenario: Out-of-range inline limit
- **WHEN** `RESULT_INLINE_LIMIT_CHARS` is set to `500`
- **THEN** the gateway exits non-zero and names `RESULT_INLINE_LIMIT_CHARS` in its error

#### Scenario: Inline limit zero
- **WHEN** `RESULT_INLINE_LIMIT_CHARS` is set to `0`
- **THEN** the gateway starts, relays every result unchanged, and keeps REA's output schemas

### Requirement: Structured logging
The gateway SHALL write logs to stdout as one JSON object per line, each with
at least a timestamp, level, and message, filtered by `LOG_LEVEL`. Log entries
SHALL NOT contain request headers, request or response bodies, API keys, ticket
secrets or URLs, the path of a transfer route, uploaded file names, or the content
of a tool result. Output written by REA child processes to stderr SHALL be
captured into the gateway's log stream rather than discarded.

#### Scenario: JSON lines
- **WHEN** the gateway handles a request at `LOG_LEVEL=info`
- **THEN** every line it writes to stdout parses as a JSON object with a level and timestamp

#### Scenario: Level filtering
- **WHEN** `LOG_LEVEL=warn`
- **THEN** no `info` or `debug` entries are written

#### Scenario: Headers are not logged at any level
- **WHEN** `LOG_LEVEL=debug` and a request with an `x-api-key` header is handled
- **THEN** no log entry contains the header name-value pair or the key

#### Scenario: Transfers are not logged with their secrets
- **WHEN** `LOG_LEVEL=debug` and an upload is made through a ticket URL
- **THEN** no log entry contains the ticket's secret, the request path, or the uploaded file's name

#### Scenario: Result content is not logged
- **WHEN** `LOG_LEVEL=debug` and a result is stored
- **THEN** no log entry contains any part of the result's text
