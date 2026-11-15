# Spec Delta

## MODIFIED Requirements

### Requirement: Advanced configuration entries
The template SHALL expose `MAX_SESSIONS`, `SESSION_IDLE_TIMEOUT_SEC`,
`TRUST_PROXY`, `ALLOWED_HOSTS`, `PUBLIC_BASE_URL`, `MAX_UPLOAD_BYTES`,
`INBOX_MAX_BYTES`, `TRANSFER_TICKET_TTL_SEC`, `RESULT_INLINE_LIMIT_CHARS`,
`GHIDRA_MAX_HEAP`, `REA_GHIDRA_STARTUP_TIMEOUT_MS`, `REA_GHIDRA_CHECKPOINT_DIR`,
and `LOG_LEVEL` as variables shown only in unRAID's advanced view, with defaults
equal to the gateway's documented defaults. The description of `PUBLIC_BASE_URL`
SHALL say that it is the address the agent's `curl` uses to reach the container, that
it should be set when the container is behind a TLS proxy such as a Cloudflare
Tunnel, and that it holds a host name and no secret.

#### Scenario: Advanced variables present
- **WHEN** the template's variable entries are enumerated
- **THEN** all thirteen advanced variables are present with an advanced display mode

#### Scenario: Defaults agree with the gateway
- **WHEN** a template default is compared with the gateway default for the same variable
- **THEN** they are equal

#### Scenario: The public URL entry explains itself
- **WHEN** the `PUBLIC_BASE_URL` description is read
- **THEN** it says that it is used for upload and download URLs and that it should be set behind a TLS proxy
