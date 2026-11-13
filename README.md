# rea-mcp

REA + Ghidra as a remote MCP server, packaged for unRAID.

> **Status: specification stage.** Nothing here is runnable yet. The repository
> currently contains the project's [OpenSpec](https://github.com/Fission-AI/OpenSpec)
> planning artifacts; the gateway, Docker image, and unRAID template described
> below are proposed, not built.

## What this will be

A single Docker container that exposes
[REA](https://github.com/morluto/rea) ("Reverse Engineer Anything", npm package
`rea-agents`) and its analysis engines (Ghidra, tshark, objdump/Rizin) as a
**remote MCP server over streamable HTTP**, so it can be added as a custom
connector in Claude and used from Claude Code.

REA is designed as a local stdio MCP server. This project is a thin gateway that
spawns one REA process per MCP session and serves it over HTTP, authenticating
every request with a static API key in an `x-api-key` header.

```
Claude (connector) -> HTTPS (Cloudflare Tunnel, terminated outside this project)
  -> container:8080  gateway (auth + MCP streamable HTTP)
     -> per-session child process: REA MCP server (stdio)
        -> Ghidra (headless), tshark, objdump/Rizin, procps
```

## Where to read the plan

| File | Contents |
|---|---|
| [`openspec/changes/bootstrap-rea-mcp-gateway/proposal.md`](openspec/changes/bootstrap-rea-mcp-gateway/proposal.md) | Why, what, and scope |
| [`openspec/changes/bootstrap-rea-mcp-gateway/design.md`](openspec/changes/bootstrap-rea-mcp-gateway/design.md) | Technical decisions, risks, open questions |
| [`openspec/changes/bootstrap-rea-mcp-gateway/tasks.md`](openspec/changes/bootstrap-rea-mcp-gateway/tasks.md) | Ordered implementation checklist |
| [`openspec/changes/bootstrap-rea-mcp-gateway/specs/`](openspec/changes/bootstrap-rea-mcp-gateway/specs/) | Behavioural requirements, one spec per capability |
| [`openspec/config.yaml`](openspec/config.yaml) | Hard constraints applied to every change |

To work with the specs:

```bash
npx @fission-ai/openspec validate bootstrap-rea-mcp-gateway --strict
```

```bash
npx @fission-ai/openspec show bootstrap-rea-mcp-gateway
```

## Ground rules

- **No secrets in this repository, ever.** The API key is supplied at runtime
  only. There is no default key.
- No third-party software under analysis (including TI software) is bundled,
  downloaded, or committed. Never commit anything under `samples/` or `work/`.
- Only analyze software you are permitted to analyze.

## License

Copyright (C) 2026 rea-mcp contributors.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, version 3. It is distributed WITHOUT ANY WARRANTY. See
[`LICENSE`](LICENSE) for the full text.

REA (`rea-agents`) is a separate MIT-licensed project and Ghidra is a separate
Apache-2.0-licensed project; neither is part of this repository.
