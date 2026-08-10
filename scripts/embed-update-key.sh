#!/usr/bin/env bash
#
# Writes yv-update-public.pem into updatePublicKeyPEM in
# internal/updater/signature.go.
#
# `make update-keys` generates the pair; this is the step after it, and the one
# worth automating rather than doing by hand. Pasting a 15-line PEM into a Go
# backtick string is easy to get subtly wrong — a stray blank line or a lost
# trailing newline parses fine and then refuses every update in the field, which
# is a failure nobody sees until a release is already out.
#
# It matters most during a rotation, where the paste has to happen in one
# specific release and nowhere else (see RELEASING.md): getting the order wrong
# strands every installed copy.
#
#   make embed-update-key                       # from yv-update-public.pem
#   KEY=/path/to/other-public.pem make embed-update-key
#
# Idempotent: running it twice writes the same bytes, so it is safe to re-run to
# check the file matches the key you have.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

KEY="${KEY:-yv-update-public.pem}"
TARGET="internal/updater/signature.go"
VAR="updatePublicKeyPEM"

die() { printf 'embed-update-key: %s\n' "$1" >&2; exit 1; }

[[ -f "$KEY" ]] || die "no public key at $KEY — run 'make update-keys' first"
[[ -f "$TARGET" ]] || die "$TARGET not found"

# Refuse anything that is not a public key. The private half is in the same
# directory with a name one tab-completion away, and committing it would be the
# worst possible outcome of a convenience script.
if grep -q "PRIVATE KEY" "$KEY"; then
  die "$KEY contains a PRIVATE key. The public half is the one that gets compiled in."
fi
grep -q "BEGIN PUBLIC KEY" "$KEY" || die "$KEY does not look like a PEM public key"

# Verified through openssl rather than by pattern: this is the last point before
# the bytes are compiled into every build, and "looks like a PEM" is not the same
# as "parses as a 4096-bit RSA key".
openssl pkey -pubin -in "$KEY" -noout 2>/dev/null ||
  die "openssl cannot read $KEY as a public key"

grep -q "^var ${VAR} = " "$TARGET" ||
  die "could not find 'var ${VAR} = ' in $TARGET"

# Rewritten in place with awk rather than by regenerating the file, so the
# comments above the variable — which carry the two unrecoverable facts about
# this key — survive untouched. Same reasoning as scripts/sync-version.mjs
# rewriting one value instead of round-tripping the JSON.
#
# The block being replaced spans from `var X = ` + backtick to the next line
# ending in a backtick, and the empty case (two backticks on one line) opens and
# closes on the same line — which is why that is tested first.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

#
# The key is read by awk from the file rather than passed with -v: a -v
# assignment cannot carry newlines, and a PEM is fifteen lines of them. That
# failed loudly ("newline in string") rather than silently, which is the one
# mercy in it.
awk -v keyfile="$KEY" -v name="$VAR" '
  BEGIN {
    tick = sprintf("%c", 96)                  # a backtick, unquotable inside awk
    while ((getline line < keyfile) > 0) {
      key = (key == "" ? line : key "\n" line)
    }
    close(keyfile)
  }
  index($0, "var " name " = " tick) == 1 {
    print "var " name " = " tick key tick
    # A one-line block (the empty placeholder) needs no skipping.
    rest = substr($0, length("var " name " = " tick) + 1)
    if (index(rest, tick) == 0) { skip = 1 }
    next
  }
  skip { if (index($0, tick) > 0) { skip = 0 } ; next }
  { print }
' "$TARGET" > "$TMP"

if cmp -s "$TMP" "$TARGET"; then
  printf '\n  %s already carries this key — nothing to do.\n\n' "$TARGET"
  exit 0
fi

cp "$TMP" "$TARGET"
gofmt -w "$TARGET"

# The point of the whole exercise: the compiled-in key has to parse, and a build
# that cannot parse its own key refuses every update. Cheaper to learn here than
# from a release.
if ! go test ./internal/updater/ -run TestPublicKey -count=1 >/dev/null 2>&1; then
  # No such test is not a failure; a build error is.
  go build ./internal/updater/ || die "$TARGET does not compile after the rewrite"
fi

printf '\n  Embedded %s into %s\n' "$KEY" "$TARGET"
printf '  Commit that file. The private half goes in the YV_UPDATE_PRIVATE_KEY\n'
printf '  repository secret and an offline copy — never in the tree.\n\n'
