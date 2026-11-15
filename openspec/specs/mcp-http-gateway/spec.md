# mcp-http-gateway Specification

## Purpose
Exposes REA's stdio MCP server to remote clients as an MCP streamable HTTP
endpoint, and keeps long-running analysis calls alive through intermediaries
that time out idle responses.

## Requirements

### Requirement: MCP streamable HTTP endpoint
The gateway SHALL serve the MCP streamable HTTP transport at `/mcp` for the
`POST`, `GET`, and `DELETE` methods, and SHALL relay MCP messages unchanged in
both directions between the HTTP client and the REA process bound to that
client's session, except as the next requirement says. Resources and prompts
exposed to the client SHALL be those REA reports.

#### Scenario: Initialize
- **WHEN** an authenticated client POSTs an MCP `initialize` request to `/mcp` without a session ID
- **THEN** the response carries REA's initialize result and an `Mcp-Session-Id` header

#### Scenario: Unknown session
- **WHEN** an authenticated request carries an `Mcp-Session-Id` that does not identify a live session
- **THEN** the response is `404`

#### Scenario: Unsupported method
- **WHEN** a request to `/mcp` uses a method other than `POST`, `GET`, or `DELETE`
- **THEN** the response is `405`

### Requirement: Exceptions to relaying unchanged
The gateway SHALL append the `file-transfer` and `result-paging` tools to the
tools REA reports and answer calls to them itself, and SHALL drop a REA tool that
has one of their names. While `RESULT_INLINE_LIMIT_CHARS` is above `0` it SHALL
also remove `outputSchema` from REA's tools and replace oversized `tools/call`
results, as `result-paging` says. If applying an exception fails, the original
message SHALL be delivered unchanged.

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

### Requirement: Health endpoint
The gateway SHALL serve `GET /healthz` without authentication, responding
`200` with exactly the JSON body `{"status":"ok"}`. The response SHALL NOT
include version, configuration, session, or dependency information in its body
or headers.

#### Scenario: Health check without a key
- **WHEN** a client sends `GET /healthz` with no `x-api-key` header
- **THEN** the response is `200` with body `{"status":"ok"}`

#### Scenario: No information disclosure
- **WHEN** a client inspects the `/healthz` response
- **THEN** it finds no version string, framework banner, session count, or configuration value

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

### Requirement: Keep-alive on open streams
While an SSE response stream is open and no other data has been written to it
for the keep-alive interval (approximately 15 seconds), the gateway SHALL write
an SSE comment to that stream, so that an intermediary with an idle timeout of
roughly 100 seconds does not terminate a long-running call.

#### Scenario: Slow tool call survives an idle timeout
- **WHEN** a tool call takes 120 seconds to produce a result and emits nothing in the meantime
- **THEN** the client receives keep-alive comments at roughly 15-second intervals and then the tool result on the same stream

#### Scenario: Keep-alives stop with the stream
- **WHEN** a response stream is closed by either side
- **THEN** no further keep-alive writes are attempted for that stream

### Requirement: Progress notification forwarding
The gateway SHALL forward MCP progress notifications emitted by REA during a
request to the client that issued the request, preserving the client's progress
token, and SHALL forward client cancellation notifications to REA.

#### Scenario: Progress during a long call
- **WHEN** a client calls a tool with a progress token and REA emits progress notifications
- **THEN** each notification reaches the client on the call's stream before the final result

#### Scenario: Cancellation
- **WHEN** a client cancels an in-flight request
- **THEN** the cancellation is delivered to the REA process for that session

### Requirement: Environment-variable configuration
The gateway SHALL be configured solely through environment variables with the
following defaults: `PORT` = `8080`, `MAX_SESSIONS` = `4`,
`SESSION_IDLE_TIMEOUT_SEC` = `300`, `TRUST_PROXY` = `false`, `ALLOWED_HOSTS` =
empty, `LOG_LEVEL` = `info`. A variable set to a value that cannot be parsed
for its type, or that is outside its range, SHALL cause the gateway to exit
non-zero at startup, naming the variable.

#### Scenario: Defaults
- **WHEN** only an API key is configured
- **THEN** the gateway listens on port 8080 with the documented defaults

#### Scenario: Invalid value
- **WHEN** `MAX_SESSIONS` is set to a non-numeric value
- **THEN** the gateway exits non-zero and names `MAX_SESSIONS` in its error

### Requirement: File-transfer and result settings
The gateway SHALL also read `PUBLIC_BASE_URL` (default empty),
`MAX_UPLOAD_BYTES` (`268435456`), `INBOX_MAX_BYTES` (`4294967296`),
`TRANSFER_TICKET_TTL_SEC` (`900`) and `RESULT_INLINE_LIMIT_CHARS` (`40000`, which
SHALL be `0` or from `2000` to `10000000`), with the same startup refusal for a
value that cannot be used.

#### Scenario: Out-of-range inline limit
- **WHEN** `RESULT_INLINE_LIMIT_CHARS` is set to `500`
- **THEN** the gateway exits non-zero and names `RESULT_INLINE_LIMIT_CHARS` in its error

#### Scenario: Inline limit zero
- **WHEN** `RESULT_INLINE_LIMIT_CHARS` is set to `0`
- **THEN** the gateway starts, relays every result unchanged, and keeps REA's output schemas

### Requirement: Analysis-engine settings passthrough
The gateway SHALL pass `REA_GHIDRA_STARTUP_TIMEOUT_MS` and
`REA_GHIDRA_CHECKPOINT_DIR` through to each REA child process unchanged when
they are set. `REA_GHIDRA_CHECKPOINT_DIR` SHALL be an absolute path and has no
default; when it is unset the REA children run without checkpointing. A relative
path SHALL cause the gateway to exit non-zero at startup, naming the variable.

#### Scenario: Startup timeout passthrough
- **WHEN** `REA_GHIDRA_STARTUP_TIMEOUT_MS` is set in the gateway's environment
- **THEN** the same value is present in each REA child's environment

#### Scenario: Checkpoint directory passthrough
- **WHEN** `REA_GHIDRA_CHECKPOINT_DIR` is set to an absolute path in the gateway's environment
- **THEN** the same value is present in every REA child's environment

#### Scenario: Checkpointing off by default
- **WHEN** `REA_GHIDRA_CHECKPOINT_DIR` is not set
- **THEN** no REA child's environment contains it

#### Scenario: Relative checkpoint directory
- **WHEN** `REA_GHIDRA_CHECKPOINT_DIR` is set to a relative path
- **THEN** the gateway exits non-zero and names `REA_GHIDRA_CHECKPOINT_DIR` in its error

### Requirement: Ghidra heap setting
The gateway SHALL apply `GHIDRA_MAX_HEAP` as the maximum Java heap of Ghidra
processes started by REA, by setting `GHIDRA_HEADLESS_MAXMEM` to its value in
each child's environment. `GHIDRA_MAX_HEAP` SHALL be a JVM heap size, a positive
integer optionally followed by `k`, `m` or `g` in either case; any other value
SHALL cause the gateway to exit non-zero at startup, naming the variable.

#### Scenario: Heap setting applied
- **WHEN** `GHIDRA_MAX_HEAP` is set to `8G` and REA launches Ghidra
- **THEN** each child's environment has `GHIDRA_HEADLESS_MAXMEM=8G` and the Ghidra JVM runs with a maximum heap of 8 GiB

#### Scenario: Invalid heap value
- **WHEN** `GHIDRA_MAX_HEAP` is set to a value that is not a JVM heap size, such as `lots`
- **THEN** the gateway exits non-zero and names `GHIDRA_MAX_HEAP` in its error

### Requirement: Child environment allowlist
The gateway SHALL build each REA child's environment from an allowlist and SHALL
NOT pass `REA_GHIDRA_PROJECT_PATH`, `REA_GHIDRA_SEED_FILE`,
`REA_GHIDRA_NATIVEAOT_JAR`, `REA_GHIDRA_LANGUAGE_ID` or
`REA_GHIDRA_DISABLED_ANALYZERS`, which REA refuses to combine with a checkpoint
directory.

#### Scenario: Settings that conflict with checkpointing are withheld
- **WHEN** the gateway starts with `REA_GHIDRA_PROJECT_PATH` or any of the other four conflicting settings in its environment
- **THEN** none of them is present in any REA child's environment

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
