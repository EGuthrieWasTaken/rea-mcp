#!/usr/bin/env bash
# Smoke test for the rea-mcp image (openspec: container-image, api-key-auth).
#
#   scripts/smoke_test.sh <image>          e.g.  scripts/smoke_test.sh rea-mcp:ci
#
# Starts the image the way the unRAID template does (--cap-drop=ALL, no-new-privileges, /samples
# read-only) with a throwaway key generated here, then checks that:
#   - the container reports healthy and GET /healthz answers 200 {"status":"ok"} without a key,
#   - an MCP `initialize` with the key succeeds, and the same request without a key, or with a
#     wrong one, gets 401 and starts no session,
#   - the gateway's own tools are listed (and no tool has an outputSchema), an upload ticket can be
#     asked for and used once with curl, an unknown upload path is a bare 404, and no ticket
#     secret reaches the log,
#   - the process runs as 99:100, the key is not in the container's logs, and `docker stop`
#     exits 0 well inside Docker's 10 s default,
#   - a container with no key, and one with a 31-character key, exits non-zero without serving.
# It does not run Ghidra; docs/DESIGN.md section 11 records those checks.
#
# The key lives only in this script's environment and in the container's: it is never written to a
# file, never printed, and never passed on a command line (curl reads it from stdin, grep from a
# process substitution, docker from the environment).
#
# Environment: REA_MCP_SMOKE_PREFIX names the containers (default rea-mcp-smoke), so that a caller
# sharing a Docker host can keep them apart from everything else. Needs docker, curl (7.55+) and openssl.
set -euo pipefail

image="${1:?usage: scripts/smoke_test.sh <image>}"
prefix="${REA_MCP_SMOKE_PREFIX:-rea-mcp-smoke}-$$"
samples=""
containers=()

for tool in docker curl openssl; do
  command -v "$tool" >/dev/null || { echo "smoke: $tool is required" >&2; exit 2; }
done

cleanup() {
  local c
  for c in "${containers[@]:-}"; do
    [ -n "$c" ] && docker rm -f -v "$c" >/dev/null 2>&1 || true
  done
  [ -n "$samples" ] && rmdir "$samples" 2>/dev/null || true
}
trap cleanup EXIT

step() { printf 'smoke: %s\n' "$*"; }
fail() {
  printf 'smoke: FAIL: %s\n' "$*" >&2
  local c="${containers[${#containers[@]}-1]:-}"
  [ -n "$c" ] && { echo "smoke: last container's log:" >&2; docker logs --tail 25 "$c" >&2 2>&1 || true; }
  exit 1
}

samples="$(mktemp -d "${TMPDIR:-/tmp}/rea-mcp-smoke-samples.XXXXXX")"
key="$(openssl rand -hex 32)"
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# post_init <url> [key]: POST `initialize`; prints "<http status>" then the response headers and body.
post_init() {
  local url="$1" k="${2:-}" out
  if [ -n "$k" ]; then
    out="$(printf 'x-api-key: %s\n' "$k" | curl -sS -m 20 -D - -w '\n%{http_code}' -H @- \
      -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$init" "$url")"
  else
    out="$(curl -sS -m 20 -D - -w '\n%{http_code}' \
      -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$init" "$url")"
  fi
  printf '%s\n' "${out##*$'\n'}"
  printf '%s\n' "${out%$'\n'*}"
}

# ---- 1. the normal run, hardened as the template will run it ------------------------------------------
main="$prefix-main"
containers+=("$main")
REA_MCP_API_KEY="$key" docker run -d --name "$main" \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  -e REA_MCP_API_KEY -p 127.0.0.1::8080 -v "$samples:/samples:ro" \
  --health-interval=2s --health-start-period=1s "$image" >/dev/null
step "started $main from $image"

status=""
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$main")"
  [ "$status" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$main")" = true ] || fail "the container stopped before it became healthy"
  sleep 1
done
[ "$status" = healthy ] || fail "the container did not become healthy within 60 s (status: $status)"
step "ok: the container is healthy"

port="$(docker port "$main" 8080/tcp | head -n1)"; port="${port##*:}"
base="http://127.0.0.1:$port"

user="$(docker inspect -f '{{.Config.User}}' "$main")"
[ "$user" = "99:100" ] || fail "the image's user is '$user', not 99:100"
[ "$(docker exec "$main" id -u)" = 99 ] && [ "$(docker exec "$main" id -g)" = 100 ] || fail "the process does not run as uid 99, gid 100"
step "ok: runs as 99:100"

body="$(curl -sS -m 10 -w '\n%{http_code}' "$base/healthz")"
[ "${body##*$'\n'}" = 200 ] || fail "/healthz returned ${body##*$'\n'}, not 200"
[ "${body%$'\n'*}" = '{"status":"ok"}' ] || fail "/healthz body was not exactly {\"status\":\"ok\"}"
step "ok: /healthz answers 200 {\"status\":\"ok\"} without a key"

reply="$(post_init "$base/mcp" "$key")"
[ "$(head -n1 <<<"$reply")" = 200 ] || fail "initialize with the key returned $(head -n1 <<<"$reply"), not 200"
grep -qi '^mcp-session-id: ' <<<"$reply" || fail "initialize with the key returned no Mcp-Session-Id header"
grep -q '"protocolVersion"' <<<"$reply" || fail "initialize with the key returned no initialize result"
sid="$(grep -i '^mcp-session-id: ' <<<"$reply" | head -n1 | tr -d '\r' | cut -d' ' -f2)"
step "ok: initialize with the key succeeds and starts a session"

reply="$(post_init "$base/mcp")"
[ "$(head -n1 <<<"$reply")" = 401 ] || fail "initialize without a key returned $(head -n1 <<<"$reply"), not 401"
grep -qi '^mcp-session-id: ' <<<"$reply" && fail "initialize without a key started a session"
step "ok: initialize without a key gets 401 and no session"

reply="$(post_init "$base/mcp" "$(openssl rand -hex 32)")"
[ "$(head -n1 <<<"$reply")" = 401 ] || fail "initialize with a wrong key returned $(head -n1 <<<"$reply"), not 401"
step "ok: initialize with a wrong key gets 401"

# post_session <json>: POST a JSON-RPC message inside the session; prints the response.
post_session() {
  printf 'x-api-key: %s\n' "$key" | curl -sS -m 30 -H @- -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $sid" --data "$1" "$base/mcp"
}
post_session '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

# The gateway's own tools (spec: file-transfer, result-paging).
tools="$(post_session '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
for tool in request_upload upload_status request_download read_result; do
  grep -q "\"name\":\"$tool\"" <<<"$tools" || fail "tools/list does not include $tool"
done
grep -q '"outputSchema"' <<<"$tools" && fail "a tool in tools/list still has an outputSchema"
step "ok: the gateway's four tools are listed and no tool has an outputSchema"

# An upload path with no such ticket: a bare 404 and nothing in the log.
nope="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X PUT --data x "$base/upload/u_smoke-unknown-id/smoke-unknown-secret")"
[ "$nope" = 404 ] || fail "an unknown upload ticket returned $nope, not 404"
step "ok: an unknown upload ticket is a bare 404"

# Ask for an upload, use the URL once with curl, and check it cannot be used twice.
reply="$(post_session '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"request_upload","arguments":{"name":"smoke.bin","max_bytes":1000}}}')"
ticket_path="$(grep -o 'upload/u_[A-Za-z0-9_-]*/[A-Za-z0-9_-]*' <<<"$reply" | head -n1)"
[ -n "$ticket_path" ] || fail "request_upload returned no upload URL"
secret="${ticket_path##*/}"
put="$(curl -sS -m 20 -w '\n%{http_code}' -X PUT --data 'smoke upload' "$base/$ticket_path")"
[ "${put##*$'\n'}" = 200 ] || fail "using the upload URL returned ${put##*$'\n'}, not 200"
grep -q '"path":"/work/inbox/smoke.bin"' <<<"$put" || fail "the upload's answer did not name /work/inbox/smoke.bin"
again="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X PUT --data 'smoke upload' "$base/$ticket_path")"
[ "$again" = 409 ] || fail "using the upload URL a second time returned $again, not 409"
[ "$(docker exec "$main" cat /work/inbox/smoke.bin)" = 'smoke upload' ] || fail "the uploaded file's content is not what was sent"
step "ok: an upload URL from request_upload works once and the file is in /work/inbox"

code="$(printf 'x-api-key: %s\n' "$key" | curl -sS -m 20 -o /dev/null -w '%{http_code}' -X DELETE -H @- \
  -H "mcp-session-id: $sid" "$base/mcp")"
[ "$code" = 200 ] || fail "DELETE /mcp with the key returned $code, not 200"
step "ok: DELETE /mcp ends the session"

# Read the log into a variable first: with `pipefail`, `docker logs | grep -q` could report a match as no match.
logs="$(docker logs "$main" 2>&1)"
if grep -qF -f <(printf '%s' "$key") <<<"$logs"; then
  fail "the key appears in the container's log"
fi
[ -n "$logs" ] || fail "the container's log is empty, so the key check proves nothing"
step "ok: the key is not in the container's log"
if grep -qF -f <(printf '%s' "$secret") <<<"$logs" || grep -qF 'smoke.bin' <<<"$logs" || grep -qF '/upload/u_' <<<"$logs"; then
  fail "an upload ticket's secret, path or file name appears in the container's log"
fi
step "ok: no upload secret, path or file name is in the container's log"

started="$(date +%s)"
docker stop "$main" >/dev/null
elapsed=$(( $(date +%s) - started ))
[ "$(docker inspect -f '{{.State.ExitCode}}' "$main")" = 0 ] || fail "docker stop ended with exit code $(docker inspect -f '{{.State.ExitCode}}' "$main"), not 0"
[ "$elapsed" -lt 10 ] || fail "docker stop took ${elapsed} s, not inside Docker's 10 s default"
step "ok: docker stop exits 0 in ${elapsed} s"

# ---- 2. refusals: the container must exit non-zero instead of serving -----------------------------------
for case_name in "no key" "a 31-character key"; do
  name="$prefix-refuse-$(tr -c 'a-z0-9' '-' <<<"$case_name" | cut -c1-12)"
  containers+=("$name")
  rc=0
  if [ "$case_name" = "no key" ]; then
    out="$(timeout 60 docker run --name "$name" --cap-drop=ALL --security-opt=no-new-privileges:true "$image" 2>&1)" || rc=$?
  else
    short="$(openssl rand -hex 16 | cut -c1-31)"
    out="$(REA_MCP_API_KEY="$short" timeout 60 docker run --name "$name" --cap-drop=ALL --security-opt=no-new-privileges:true \
      -e REA_MCP_API_KEY "$image" 2>&1)" || rc=$?
    if grep -qF -f <(printf '%s' "$short") <<<"$out"; then fail "the short key appears in the output"; fi
  fi
  [ "$rc" -ne 0 ] || fail "the container with $case_name exited 0"
  [ "$rc" -ne 124 ] || fail "the container with $case_name was still running after 60 s"
  grep -q 'REA_MCP_API_KEY' <<<"$out" || fail "the refusal with $case_name did not name REA_MCP_API_KEY"
  step "ok: with $case_name the container exits $rc and serves nothing"
done

step "all checks passed"
