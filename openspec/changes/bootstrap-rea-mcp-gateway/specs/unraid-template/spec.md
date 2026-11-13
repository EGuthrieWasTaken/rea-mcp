# Spec Delta

## Purpose

Provides a native unRAID Docker template so the container can be installed and
configured from the unRAID web interface with secure defaults.

## ADDED Requirements

### Requirement: Template file and container metadata
The repository SHALL provide `unraid/rea-mcp.xml` as a well-formed unRAID
Docker template with root element `<Container version="2">` containing `Name`,
`Repository`, `Registry`, `Shell`, `Support`, `Project`, `Overview`,
`Category`, `TemplateURL`, and `Icon` elements. `Repository` SHALL be
`ghcr.io/eguthriewastaken/rea-mcp:latest`, all lowercase, and `Category` SHALL
be `Tools:`.

#### Scenario: Well-formed XML
- **WHEN** the template is parsed by an XML parser
- **THEN** parsing succeeds with `Container` as the root element

#### Scenario: Lowercase image reference
- **WHEN** the `Repository` value is read
- **THEN** it contains no uppercase characters

#### Scenario: Missing metadata element
- **WHEN** any of the listed metadata elements is absent or empty
- **THEN** the template check fails

### Requirement: Project links
`Project` SHALL be the GitHub repository URL, `Support` SHALL be that
repository's issues page, and `TemplateURL` SHALL be the
raw.githubusercontent.com URL of `unraid/rea-mcp.xml` on the `main` branch.

#### Scenario: Template URL points at itself
- **WHEN** the `TemplateURL` value is read
- **THEN** it is a raw.githubusercontent.com URL whose path ends in `/main/unraid/rea-mcp.xml`

### Requirement: Network and hardening defaults
The template SHALL set `Network` to `bridge`, `Privileged` to `false`, and
`ExtraParams` to `--security-opt=no-new-privileges:true --cap-drop=ALL`. The
template SHALL NOT define a `WebUI`, because the container is API-only.

#### Scenario: Hardening flags
- **WHEN** the `ExtraParams` and `Privileged` values are read
- **THEN** `ExtraParams` contains both `--cap-drop=ALL` and `--security-opt=no-new-privileges:true`, and `Privileged` is `false`

#### Scenario: No web UI
- **WHEN** the template is read
- **THEN** it has no non-empty `WebUI` element

### Requirement: Required configuration entries
The template SHALL define these `<Config>` entries, each with `Type`, `Target`,
`Default`, `Mode`, `Display`, `Required`, and `Mask` attributes:

- Port `8080` / `tcp`, required.
- Variable `REA_MCP_API_KEY`: empty default, `Mask="true"`, `Required="true"`,
  with a description telling the user to generate a long random key.
- Path `/samples`: `Mode="ro"`, no default, required.
- Path `/work`: default `/mnt/user/appdata/rea-mcp`, `Mode="rw"`.

#### Scenario: API key entry is safe by default
- **WHEN** the `REA_MCP_API_KEY` entry is read
- **THEN** its default and value are empty, `Mask` is `true`, and `Required` is `true`

#### Scenario: Samples are read-only with no default
- **WHEN** the `/samples` entry is read
- **THEN** its `Mode` is `ro`, its default is empty, and `Required` is `true`

#### Scenario: Work path default
- **WHEN** the `/work` entry is read
- **THEN** its default is `/mnt/user/appdata/rea-mcp` and its `Mode` is `rw`

### Requirement: Advanced configuration entries
The template SHALL expose `MAX_SESSIONS`, `SESSION_IDLE_TIMEOUT_SEC`,
`TRUST_PROXY`, `ALLOWED_HOSTS`, `GHIDRA_MAX_HEAP`,
`REA_GHIDRA_STARTUP_TIMEOUT_MS`, and `LOG_LEVEL` as variables shown only in
unRAID's advanced view, with defaults equal to the gateway's documented
defaults.

#### Scenario: Advanced variables present
- **WHEN** the template's variable entries are enumerated
- **THEN** all seven advanced variables are present with an advanced display mode

#### Scenario: Defaults agree with the gateway
- **WHEN** a template default is compared with the gateway default for the same variable
- **THEN** they are equal

### Requirement: Original icon
The repository SHALL provide `unraid/icon.png`, a small PNG of original
artwork, and the template's `Icon` SHALL reference its raw URL on `main`. The
icon SHALL NOT reproduce third-party logos or trademarks.

#### Scenario: Icon exists and is referenced
- **WHEN** the `Icon` URL's path is resolved against the repository
- **THEN** it identifies `unraid/icon.png`, which is a valid PNG

### Requirement: No secrets or site-specific values in the template
The template SHALL NOT contain any API key, token, real hostname other than
public GitHub and GHCR locations, or user-specific host path other than the
conventional appdata default.

#### Scenario: Template scan
- **WHEN** the template is scanned for secrets
- **THEN** none are found and every variable that holds a secret has an empty default

### Requirement: Automated template validation
Continuous integration SHALL fail when `unraid/rea-mcp.xml` is not well-formed
XML or is missing any required element or `<Config>` entry defined in this
specification.

#### Scenario: Malformed template blocks CI
- **WHEN** a change makes the template malformed or removes a required entry
- **THEN** the CI template check fails
