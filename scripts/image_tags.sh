#!/usr/bin/env bash
# Which image references to publish for a git ref (used by .github/workflows/publish.yml, task 6.4).
#
#   scripts/image_tags.sh <owner/repo> <git ref> <commit sha>
#
# Prints one fully qualified, all-lowercase reference per line, or exits 1 for a ref that must not publish.
# PROPOSED policy, pending the maintainer's answer to design open question 4:
#   refs/heads/main        ->  ghcr.io/<owner>/<repo>:latest  and  :sha-<first 12 of the commit>
#   refs/tags/vX.Y.Z       ->  ghcr.io/<owner>/<repo>:X.Y.Z   and  :sha-<first 12 of the commit>
# Anything else (a pull request, another branch, a tag that is not vX.Y.Z) publishes nothing.
set -euo pipefail

repo="${1:?usage: image_tags.sh <owner/repo> <git ref> <commit sha>}"
ref="${2:?usage: image_tags.sh <owner/repo> <git ref> <commit sha>}"
sha="${3:?usage: image_tags.sh <owner/repo> <git ref> <commit sha>}"

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "image_tags: not an owner/repo: $repo" >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "image_tags: not a full commit sha" >&2; exit 1; }

image="ghcr.io/${repo,,}"
short="sha-${sha:0:12}"

if [ "$ref" = refs/heads/main ]; then
  printf '%s\n' "$image:latest" "$image:$short"
elif [[ "$ref" =~ ^refs/tags/v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  printf '%s\n' "$image:${BASH_REMATCH[1]}" "$image:$short"
else
  echo "image_tags: $ref is not refs/heads/main or a refs/tags/vX.Y.Z tag, so nothing is published" >&2
  exit 1
fi
