#!/bin/sh
# rea-mcp container entrypoint (openspec: container-image, "Volumes and working directory" and
# "Writable runtime locations"). It runs as the unprivileged runtime user, under tini, before the gateway.
#
# 1. Checks that /work and /tmp can really be written by this user, and says so plainly when they
#    cannot, instead of letting the first analysis fail obscurely. A bind mount owned by root is the
#    usual cause. It tests by creating a file, which also catches read-only mounts and ACLs that
#    `test -w` misses.
# 2. Creates /work/home (the user's HOME) and /work/sessions (one directory per MCP session), which
#    are missing whenever an empty directory is mounted over /work.
# 3. Replaces itself with the command it was given (the gateway), so signals from tini reach it.
#
# Errors are written to stdout as one JSON object per line, in the same shape as the gateway's own log,
# and the exit status is 1. Nothing here reads, prints or derives anything from an API key: the key is
# checked by the gateway.
set -eu

uid="$(id -u)"
gid="$(id -g)"

fail() { # $1 = fixed message, $2 = directory concerned, $3 = what to do about it
  printf '{"time":"%s","level":"error","message":"%s","path":"%s","reason":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$1" "$2" "$3"
  exit 1
}

# $1 = directory, $2 = what the directory is for. Leaves nothing behind.
require_writable() {
  probe="$1/rea-mcp-write-test.$$"
  if ! ( : > "$probe" ) 2>/dev/null; then
    fail "a directory the gateway needs is not writable" "$1" \
      "$1 ($2) is not writable by uid ${uid}, gid ${gid}, the user this container runs as. For a bind mount, make the host directory writable by that uid and gid (on unRAID, nobody:users), or mount a different directory. If the root filesystem is read-only, mount a writable /tmp."
  fi
  rm -f "$probe"
}

require_writable /work "persistent output, per-session directories and the optional checkpoint root"
require_writable /tmp "each Ghidra session's private runtime"

for dir in /work/home /work/sessions; do
  if ! mkdir -p -m 0700 "$dir" 2>/dev/null; then
    fail "a directory the gateway needs cannot be created" "$dir" \
      "$dir could not be created under /work, which is writable. Something else may already exist at that path."
  fi
done
# They may already exist, for example from a run as another user, so check them as well.
require_writable /work/home "the runtime user's HOME"
require_writable /work/sessions "one working directory per MCP session"

[ "$#" -gt 0 ] || fail "no command to run" "" "the container was started without a command; the image's default is node /app/dist/main.js"
exec "$@"
