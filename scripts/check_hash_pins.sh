#!/usr/bin/env bash
# Hash-pin check for docker/Dockerfile (openspec: container-image, "Pinned, verified Ghidra" and the JDK).
#
#   scripts/check_hash_pins.sh [tag-prefix]        (default prefix: rea-mcp-hashcheck)
#
# Builds the image once for each pinned archive with that archive's SHA-256 altered by one character, and
# requires that the build FAILS because of the checksum (not for some other reason) and that no image is
# produced. The downloads are cached by the first build of the same Dockerfile, so run this after a normal
# build to avoid fetching the archives again. Needs docker with buildx, run from anywhere inside the repository.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

prefix="${1:-rea-mcp-hashcheck}"
log="$(mktemp "${TMPDIR:-/tmp}/rea-mcp-hashcheck.XXXXXX")"
trap 'rm -f "$log"' EXIT

for arg in GHIDRA_SHA256 JDK_SHA256; do
  good="$(sed -n "s/^ARG ${arg}=\([0-9a-f]\{64\}\)\$/\1/p" docker/Dockerfile)"
  [ -n "$good" ] || { echo "hash pins: cannot read ARG ${arg} (64 hex digits) from docker/Dockerfile" >&2; exit 1; }
  swap=a; [ "${good:0:1}" = a ] && swap=b
  bad="${swap}${good:1}"                    # differs from the pin in exactly one character
  tag="${prefix}:$(printf '%s' "$arg" | tr 'A-Z_' 'a-z-')"
  docker image rm "$tag" >/dev/null 2>&1 || true

  if docker buildx build --platform linux/amd64 -f docker/Dockerfile --build-arg "${arg}=${bad}" -t "$tag" . >"$log" 2>&1; then
    echo "hash pins: FAIL: the build succeeded with an altered ${arg}" >&2
    exit 1
  fi
  grep -q 'FAILED' "$log" && grep -q 'did NOT match' "$log" \
    || { echo "hash pins: FAIL: the build with an altered ${arg} failed, but not on the checksum:" >&2; tail -n 15 "$log" >&2; exit 1; }
  if docker image inspect "$tag" >/dev/null 2>&1; then
    echo "hash pins: FAIL: an image was produced with an altered ${arg}" >&2
    exit 1
  fi
  echo "hash pins: ok: an altered ${arg} fails the build on the checksum and produces no image"
done
