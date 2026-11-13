#!/usr/bin/env bash
# Repository hygiene check (openspec: secret-hygiene). Fails when something that must never be
# committed is tracked: analysis inputs/outputs, captures, Ghidra projects, TI software, other
# binaries, or an environment file with a key in it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
report() { echo "hygiene: $1" >&2; fail=1; }

# 1. Nothing under samples/ or work/, at any depth.
while IFS= read -r f; do
  report "tracked file under samples/ or work/: $f"
done < <(git ls-files | grep -E '(^|/)(samples|work)/' || true)

# 2. No environment files other than the example.
while IFS= read -r f; do
  report "tracked environment file: $f"
done < <(git ls-files | grep -E '(^|/)\.env(\..*)?$' | grep -vE '(^|/)\.env\.example$' || true)

# 3. No captures, Ghidra projects, TI files, installers or key material by extension.
forbidden='\.(pcap|pcapng|gpr|rep|tns|tnc|tno|tco|tcc|tmo|tmc|tilp|8xp|8xk|8xu|89u|89k|9xu|v2u|rom|exe|msi|dmg|pkg|apk|ipa|pem|key)$'
while IFS= read -r f; do
  report "tracked file with a forbidden extension: $f"
done < <(git ls-files | grep -iE "$forbidden" || true)

# 4. The only binary allowed in the tree is the unRAID icon.
while IFS= read -r f; do
  [ "$f" = "unraid/icon.png" ] || report "tracked binary file: $f"
done < <(git ls-files --eol | awk -F'\t' '$1 ~ /^i\/-text/ { print $2 }')

# 5. .env.example, once it exists, must leave every key variable empty.
if [ -f .env.example ] && grep -nE '^[[:space:]]*REA_MCP_API_KEY[A-Z_]*=.+' .env.example >&2; then
  report ".env.example sets an API key variable; it must be empty"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "hygiene: ok"
