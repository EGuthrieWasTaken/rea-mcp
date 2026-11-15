# file-transfer Specification

## Purpose
Lets an agent give REA a file, and fetch a stored result whole, with a single-use URL
and `curl` from its own shell, so that file bytes never pass through the model's
context. Uploaded files land in a writable inbox; `/samples` stays read-only.

## Requirements

### Requirement: Upload tickets
The gateway SHALL provide an MCP tool `request_upload` that takes a file `name` and
optionally `overwrite` (default `false`), `max_bytes` and `expect_sha256`. It SHALL
return a single-use `upload_url`, a `curl_command` that uploads a local file to it, the
absolute `path` the file will have in the inbox, `expires_at`, the applicable
`max_bytes`, and an `upload_id`.

#### Scenario: A ticket for a new file
- **WHEN** an authenticated session calls `request_upload` with the name `sample.dll`
- **THEN** the result has an `upload_url`, a `curl_command`, the path `/work/inbox/sample.dll`, an expiry, and no file exists yet

#### Scenario: A larger limit than the server allows
- **WHEN** `request_upload` is called with a `max_bytes` above `MAX_UPLOAD_BYTES`
- **THEN** the returned `max_bytes` is `MAX_UPLOAD_BYTES`

### Requirement: Upload file names
The gateway SHALL validate the name when the ticket is requested, so that the agent is
refused before it uploads anything. A name SHALL be a single path component of at most
200 bytes in UTF-8, SHALL NOT be `.` or `..` or start with `.`, and SHALL NOT contain
`/`, `\`, NUL, a control character, or a character that changes the direction of text (such as the right-to-left override), and SHALL be valid Unicode text (no unpaired surrogate).

#### Scenario: A name that would leave the inbox
- **WHEN** `request_upload` is called with a name containing `/` or `\`, or equal to `..`, or starting with `.`, or containing a control character or a right-to-left override
- **THEN** the call returns a tool error and no ticket exists

#### Scenario: A name that is too long
- **WHEN** `request_upload` is called with a name longer than 200 bytes in UTF-8
- **THEN** the call returns a tool error and no ticket exists

#### Scenario: A name with multi-byte characters
- **WHEN** `request_upload` is called with a name of 60 characters that is 180 bytes in UTF-8 and has no forbidden character
- **THEN** a ticket is issued

### Requirement: Upload ticket arguments
`request_upload` SHALL refuse a name that already exists in the inbox when `overwrite`
is false, and SHALL refuse an `expect_sha256` that is not 64 hexadecimal characters.
It SHALL clamp `max_bytes` to `MAX_UPLOAD_BYTES`, and SHALL refuse a `max_bytes` that is
not a positive integer.

#### Scenario: A name that already exists
- **WHEN** `request_upload` is called with `overwrite` false for a name that is already in the inbox
- **THEN** the call returns a tool error naming the conflict and no ticket exists

#### Scenario: Overwrite requested
- **WHEN** `request_upload` is called with `overwrite` true for a name that is already in the inbox
- **THEN** a ticket is issued

#### Scenario: A malformed hash
- **WHEN** `request_upload` is called with an `expect_sha256` that is not 64 hexadecimal characters
- **THEN** the call returns a tool error and no ticket exists

### Requirement: Upload endpoint
The gateway SHALL accept the bytes of an upload at `PUT` or `POST /upload/<id>/<secret>`,
where the path carries a ticket's id and secret and the request needs no `x-api-key`.
On success the response SHALL be `200` with a JSON body holding `upload_id`, `name`,
`path`, `size` and `sha256`. A request with any other method SHALL receive `405` with
an `Allow` header and SHALL NOT claim the ticket.

#### Scenario: A successful upload
- **WHEN** the `curl_command` from `request_upload` is run with a 10 MiB file
- **THEN** the response is `200` with the file's size and SHA-256, and `/work/inbox/<name>` holds exactly those bytes

#### Scenario: Another method
- **WHEN** a `GET` is sent to `/upload/<id>/<secret>`
- **THEN** the response is `405` with an `Allow` header and the ticket is not claimed

#### Scenario: The `POST` alias
- **WHEN** a client that cannot send `PUT` sends the same body with `POST`
- **THEN** the upload succeeds as it would with `PUT`

### Requirement: Tickets are claimed once
The first request that presents a ticket's correct secret SHALL claim it. Any later
request for a claimed ticket SHALL receive `409`. A ticket that has expired SHALL be
refused with `410` and SHALL NOT be claimed. A transfer that began before the expiry
MAY finish after it.

#### Scenario: A ticket cannot be reused
- **WHEN** a second request presents the id and secret of a ticket that has already been claimed
- **THEN** the response is `409` and the file is unchanged

#### Scenario: An expired ticket
- **WHEN** a request presents the correct id and secret after the ticket's expiry and before it was claimed
- **THEN** the response is `410` and nothing is written

#### Scenario: A transfer started before the expiry
- **WHEN** an upload that began before the ticket's expiry is still receiving after it
- **THEN** the upload is allowed to finish

### Requirement: Uploads are streamed, counted and hashed
The gateway SHALL stream an upload to a temporary file inside the inbox, counting and
hashing the bytes as they arrive, and SHALL make the file visible under its final name
only after the whole body has been received and checked. It SHALL enforce the ticket's
`max_bytes` while streaming, not only from `Content-Length`, and SHALL answer `413` and
remove the temporary file when the limit is passed.

#### Scenario: Over the size limit
- **WHEN** a body larger than the ticket's `max_bytes` is sent, with or without a `Content-Length`
- **THEN** the response is `413`, no file and no temporary file remain, and the ticket is `failed`

#### Scenario: A large body is not held in memory
- **WHEN** a body of several hundred megabytes is uploaded
- **THEN** the gateway's memory use does not grow by anything like the body's size

#### Scenario: A long upload is not cut off by the server
- **WHEN** a client sends a body steadily for longer than 300 seconds
- **THEN** the upload is not ended by the server's own whole-request timeout

### Requirement: Upload hash check
When the ticket has `expect_sha256` and the received bytes hash to something else, the
gateway SHALL answer `422`, SHALL NOT commit the file, and SHALL mark the ticket
`failed`.

#### Scenario: A hash that does not match
- **WHEN** the ticket has `expect_sha256` and the uploaded bytes hash differently
- **THEN** the response is `422`, the inbox holds no file under that name and no temporary file, and the ticket is `failed`

#### Scenario: A hash that matches
- **WHEN** the ticket has `expect_sha256` and the uploaded bytes hash to it
- **THEN** the upload succeeds

### Requirement: Upload commit
When the ticket's `overwrite` is false, the commit SHALL NOT replace an existing file,
even one created after the ticket was issued, and SHALL answer `409`. When `overwrite`
is true, the commit SHALL replace a regular file atomically and SHALL NOT replace a
symlink or a directory.

#### Scenario: A file appears after the ticket was issued
- **WHEN** a ticket with `overwrite` false was issued, then a file with that name was created, then the upload completes
- **THEN** the response is `409` and the earlier file is unchanged

#### Scenario: A symlink planted at the name
- **WHEN** a ticket with `overwrite` true was issued, then a symlink was placed at that name in the inbox, then the upload completes
- **THEN** the upload fails, nothing outside the inbox is written, and the symlink is unchanged

#### Scenario: A reader never sees a partial file
- **WHEN** a large upload is in progress for a name that does not yet exist
- **THEN** no file with that name exists until the upload has been received in full

### Requirement: A failed upload leaves nothing behind
An upload that fails for any reason, whose client disconnects, or that sends no data for
60 seconds (answered `408`) SHALL leave no temporary file, SHALL leave any existing file
at the name unchanged, and SHALL mark the ticket `failed`.

#### Scenario: The client hangs up
- **WHEN** a client disconnects halfway through an upload
- **THEN** no temporary file remains, the file at that name (if any) is unchanged, and the ticket is `failed`

#### Scenario: A stalled client
- **WHEN** a client sends part of a body and then nothing for 60 seconds
- **THEN** the response is `408`, no temporary file remains, and the ticket is `failed`

### Requirement: The inbox
Uploaded files SHALL be written only to `/work/inbox`, one flat directory shared by all
sessions, with mode `0640` and no execute bit. The gateway SHALL NOT execute them. The
gateway SHALL provide no tool that deletes, moves or lists inbox files, and SHALL remove
stray temporary files left in the inbox by an earlier run when it starts.

#### Scenario: Samples stay read-only
- **WHEN** a file is uploaded while `/samples` is mounted read-only
- **THEN** the upload succeeds, and nothing is written under `/samples`

#### Scenario: A file in the inbox can be analysed
- **WHEN** a file has been uploaded and `open_binary` is called with the returned `path`
- **THEN** REA opens the file

#### Scenario: Another session can use it
- **WHEN** a file was uploaded in one session and another session calls `open_binary` with its path
- **THEN** REA opens the file

#### Scenario: Stray temporary files
- **WHEN** the gateway starts and `/work/inbox` holds an `.upload-*.tmp` file from a previous run
- **THEN** the file is removed

#### Scenario: Files are not executable
- **WHEN** a file has been uploaded
- **THEN** its mode has no execute bit

### Requirement: Inbox quota
The gateway SHALL refuse a ticket request if the bytes already in the inbox, plus the
`max_bytes` of every live upload ticket, plus the new ticket's `max_bytes`, exceed
`INBOX_MAX_BYTES`. The error SHALL say that the operator must clear `/work/inbox`.

#### Scenario: The inbox is full
- **WHEN** the inbox plus pending tickets plus the new ticket would exceed `INBOX_MAX_BYTES`
- **THEN** `request_upload` returns a tool error that tells the operator to clear `/work/inbox`, and no ticket exists

#### Scenario: Pending tickets count
- **WHEN** live tickets already reserve the whole quota and another is requested
- **THEN** the call returns a tool error even though the inbox itself is empty

### Requirement: Upload status
The gateway SHALL provide an MCP tool `upload_status` that takes an `upload_id` and
returns its `state` (`pending`, `receiving`, `complete`, `failed` or `expired`),
`bytes_received`, and, when finished, the `size`, `sha256` and, for a failure, an
error `code` and `message`. An unknown id SHALL be a tool error.

#### Scenario: Progress while uploading
- **WHEN** `upload_status` is called while a large upload is streaming
- **THEN** the state is `receiving` and `bytes_received` is above zero and increases between calls

#### Scenario: After completion
- **WHEN** `upload_status` is called after a successful upload
- **THEN** the state is `complete` with the same `size` and `sha256` the upload returned

#### Scenario: Unknown id
- **WHEN** `upload_status` is called with an id that is not a live ticket
- **THEN** the result is a tool error

### Requirement: Download tickets
The gateway SHALL provide an MCP tool `request_download` that takes the `result_id` of a
result stored by the calling session (see `result-paging`) and returns a single-use
`download_url`, a `curl_command` that saves the file to a local path, the result's
`size` and `sha256`, an `expires_at` and a `download_id`.

#### Scenario: A ticket for a stored result
- **WHEN** a session calls `request_download` with the id of a result it stored
- **THEN** the result has a `download_url`, a `curl_command`, the stored text's `size` and its `sha256`

#### Scenario: A result of another session
- **WHEN** a session calls `request_download` with a `result_id` stored by a different session
- **THEN** the result is a tool error and no ticket exists

### Requirement: Download endpoint
The gateway SHALL serve `GET /download/<id>/<secret>` without an API key, claiming the
ticket as for uploads (`409` when already claimed, `410` when expired). It SHALL stream
the stored file with `Content-Length`, `Content-Disposition: attachment`, the SHA-256 in
a response header, and `Cache-Control: no-store`.

#### Scenario: A successful download
- **WHEN** the `curl_command` from `request_download` is run
- **THEN** the saved file has the returned `size` and its SHA-256 equals the returned `sha256`

#### Scenario: A download ticket cannot be reused
- **WHEN** a second request presents a download ticket that has already been claimed
- **THEN** the response is `409`

#### Scenario: Another method
- **WHEN** a `PUT` is sent to `/download/<id>/<secret>`
- **THEN** the response is `405` with an `Allow` header and the ticket is not claimed

### Requirement: Only stored results can be downloaded
`request_download` SHALL accept only the id of a result the gateway stored, and the
download route SHALL serve only that file; there SHALL be no download of an inbox file, a
sample, or any other path. A download ticket SHALL be revoked when the session that
requested it ends, and a request for a revoked ticket SHALL receive `404`.

#### Scenario: Only stored results
- **WHEN** `request_download` is called with a path, a file name, or an id that is not a stored result
- **THEN** the result is a tool error and no ticket exists

#### Scenario: The session has ended
- **WHEN** the session that requested a download ticket ends before the ticket is used
- **THEN** a request for the ticket receives `404`

### Requirement: Ticket secrets
A ticket's secret SHALL be 32 bytes from a cryptographically secure random source,
carried only in the URL path. The gateway SHALL hold only a SHA-256 digest of it and
compare digests with a constant-time primitive. An API key and a ticket secret SHALL NOT
be interchangeable.

#### Scenario: Only a digest is kept
- **WHEN** the gateway's in-memory ticket store is examined after a ticket is issued
- **THEN** it holds the SHA-256 of the secret and not the secret itself

#### Scenario: A ticket is not an API key
- **WHEN** a ticket's secret is sent as an `x-api-key` to `/mcp`
- **THEN** the response is `401`

#### Scenario: A key is not a ticket
- **WHEN** an accepted API key is used as the secret in a transfer path
- **THEN** the response is `404`

### Requirement: Guessing resistance
A request whose id is unknown and a request whose id is known but whose secret is wrong
SHALL receive the same bare `404`, with no detail. Both SHALL count as failures against
the requester's source address in the same limiter that counts failed API-key attempts,
so that a source over the limit receives `429` with a `Retry-After` header without its
ticket being looked at. A request with the correct secret SHALL NOT count as a failure.

#### Scenario: Unknown id and wrong secret look the same
- **WHEN** one request names a ticket that does not exist and another names a live ticket with the wrong secret
- **THEN** both responses are `404` with the same empty body and headers

#### Scenario: Guessing is limited
- **WHEN** one source sends more failed transfer requests than the limit allows within the window
- **THEN** its next request receives `429`, even one that carries a correct secret

### Requirement: Secrets stay out of the logs
The gateway SHALL NOT write a ticket secret, a ticket URL, the request path of a
transfer route, or an uploaded file's name to any log at any level, and SHALL log the
transfer routes under a fixed label.

#### Scenario: Secrets are not logged
- **WHEN** an upload and a download are made with `LOG_LEVEL=debug`
- **THEN** no log line contains the ticket's secret, its URL, the request path, or the file name

#### Scenario: A failed attempt is logged by label
- **WHEN** a request to a transfer route fails with `404`
- **THEN** the log line names the route label and the source address and nothing from the request path

### Requirement: Ticket lifetime
A ticket SHALL expire `TRANSFER_TICKET_TTL_SEC` seconds after it was issued if it has
not been claimed. Finished and expired tickets SHALL be dropped one lifetime after they
ended or expired, and until then SHALL still answer `upload_status`.

#### Scenario: Unused tickets expire
- **WHEN** a ticket is not claimed within `TRANSFER_TICKET_TTL_SEC`
- **THEN** `upload_status` reports `expired` and the URL receives `410`

#### Scenario: A finished ticket is remembered for a while
- **WHEN** an upload finished less than one lifetime ago
- **THEN** `upload_status` still reports `complete`

### Requirement: Ticket limit and storage
At most 100 tickets SHALL be live at once, counting upload and download tickets
together; a request for another SHALL be refused with a tool error. Tickets SHALL be kept
in memory only, so none survives a restart.

#### Scenario: The ticket cap
- **WHEN** 100 tickets are live and another is requested
- **THEN** the call returns a tool error and no ticket is created

#### Scenario: Restart
- **WHEN** the gateway restarts after a ticket was issued
- **THEN** the old URL receives `404`

### Requirement: Public URL construction
The gateway SHALL build the base of every ticket URL, in this order, from
`PUBLIC_BASE_URL` if it is set; otherwise, only when `TRUST_PROXY=true`, from
`X-Forwarded-Proto` (`https` or `http`, defaulting to `http`) and `X-Forwarded-Host` or
`Host`; otherwise from `http://` and the `Host` header. The tool result SHALL say which
rule applied (`url_source`). A `Host` that is not a valid host name, or a request with
none and no `PUBLIC_BASE_URL`, SHALL produce a tool error.

#### Scenario: Configured base URL
- **WHEN** `PUBLIC_BASE_URL` is `https://<host>` and a ticket is requested
- **THEN** the `upload_url` begins with `https://<host>/upload/` and `url_source` names `PUBLIC_BASE_URL`

#### Scenario: Forwarded headers
- **WHEN** `PUBLIC_BASE_URL` is unset, `TRUST_PROXY=true`, and the request carries `X-Forwarded-Proto: https` and `X-Forwarded-Host: <host>`
- **THEN** the `upload_url` begins with `https://<host>/upload/`

#### Scenario: Forwarded headers ignored when the proxy is not trusted
- **WHEN** `PUBLIC_BASE_URL` is unset, `TRUST_PROXY` is not `true`, and the request carries `X-Forwarded-Host: <other>`
- **THEN** the `upload_url` is built from `Host`, not from `<other>`

#### Scenario: A bad Host header
- **WHEN** `PUBLIC_BASE_URL` is unset and the request's `Host` is not a valid host name
- **THEN** the call returns a tool error and no ticket exists

### Requirement: Public base URL setting
`PUBLIC_BASE_URL` SHALL be an `http` or `https` URL with no path, query, fragment or
credentials. A trailing slash SHALL be ignored. Any other value SHALL stop the gateway
at startup, naming the variable.

#### Scenario: An invalid configured URL
- **WHEN** `PUBLIC_BASE_URL` contains a path or credentials
- **THEN** the gateway exits non-zero and names `PUBLIC_BASE_URL` in its error

#### Scenario: A trailing slash
- **WHEN** `PUBLIC_BASE_URL` is `https://<host>/`
- **THEN** the gateway starts and ticket URLs have a single slash before `upload`
