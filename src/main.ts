// Entry point. The gateway is wired up task by task (configuration, keys, HTTP
// server, sessions), following openspec/changes/bootstrap-rea-mcp-gateway/tasks.md.
// Until the server exists this exits non-zero, so nothing can run without
// authentication by accident.
process.stderr.write("rea-mcp: the gateway is not wired up yet\n");
process.exitCode = 1;
