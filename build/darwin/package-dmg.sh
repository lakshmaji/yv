#!/usr/bin/env bash
#
# Packages an already-built yv.app into the disk image users install from.
#
# The window has to show two things: the app, and an alias to /Applications for
# it to be dragged onto. Without the alias the image is a single icon and a
# double-click, and a double-click runs yv *from the mounted volume* — which
# internal/updater/apply_darwin.go then permanently refuses to update ("yv is
# running from a disk image"). The alias is not decoration; it is what stops a
# user installing a copy that can never update itself.
#
# Run via `make dmg`, which guarantees the bundle exists first.
#
# Two ways of building it, one output:
#
#   create-dmg  — positions the icons over build/darwin/dmg-background.png. It
#                 drives Finder over AppleScript to do that, which is the part
#                 that occasionally fails on a headless runner.
#   hdiutil     — the plain image: same contents, same alias, icons wherever
#                 Finder decides to put them.
#
# The fallback is not a lesser product, it is the same disk image without the
# layout, so a flaky Finder degrades the window rather than failing the release.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

APP="${APP:-build/bin/yv.app}"
OUT_DIR="${OUT_DIR:-build/bin}"
VOLNAME="yv"
BACKGROUND="build/darwin/dmg-background.png"

die() { printf 'package-dmg: %s\n' "$1" >&2; exit 1; }

[[ -d "$APP" ]] || die "no app bundle at $APP — run 'make build' first"

# Defaults to wails.json, like package-deb.sh and package-appimage.sh. CI
# overrides it with the tag, which keeps its leading "v" — internal/updater
# matches on these names, so the DMG cannot be the one that spells it
# differently.
VERSION="${VERSION:-$(sed -n 's/.*"productVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' wails.json)}"
VERSION="${VERSION:-0.0.0}"

# Go's spelling, because that is what platformToken() in internal/updater
# compares against — unlike the AppImage, which carries the uname one.
#
# Fixed rather than read from `go env GOARCH`: this labels the bundle that was
# built, and both `make build` and CI build darwin/arm64 explicitly, so on an
# Intel host the host's answer would name the file after an architecture the
# app is not — and the updater matches on that name.
ARCH="${ARCH:-arm64}"

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/yv-macos-${ARCH}-${VERSION}.dmg"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"

# A volume of this name left mounted — from opening a previous image, which is
# exactly how the user installed the copy being replaced — makes hdiutil refuse
# to overwrite and makes create-dmg address the wrong window.
if [[ -d "/Volumes/$VOLNAME" ]]; then
  hdiutil detach "/Volumes/$VOLNAME" -quiet 2>/dev/null ||
    hdiutil detach "/Volumes/$VOLNAME" -force -quiet 2>/dev/null || true
fi

plain() {
  rm -f "$OUT"
  # The alias, and the reason findBundle() in apply_darwin.go still works: it
  # returns the first entry whose name ends in ".app", and this one is called
  # "Applications". A future rename that gave it a .app suffix would silently
  # make the updater install the alias.
  ln -sfn /Applications "$STAGE/Applications"
  hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >&2
}

styled() {
  rm -f "$OUT"
  # create-dmg makes its own /Applications link, so the staging directory must
  # not already contain one — two aliases in one window.
  rm -f "$STAGE/Applications"

  local args=(
    --volname "$VOLNAME"
    --window-pos 200 120
    --window-size 600 400
    --icon-size 128
    --icon "$(basename "$APP")" 150 205
    --app-drop-link 450 205
    --hide-extension "$(basename "$APP")"
    --no-internet-enable
  )
  # Passed only if it is there: a missing backdrop should cost the window its
  # arrow, not the release its disk image.
  if [[ -f "$BACKGROUND" ]]; then
    args+=(--background "$BACKGROUND")
  fi

  create-dmg "${args[@]}" "$OUT" "$STAGE" >&2
}

if command -v create-dmg >/dev/null 2>&1; then
  if ! styled; then
    printf 'package-dmg: create-dmg failed, falling back to a plain image\n' >&2
    plain
  fi
else
  printf 'package-dmg: create-dmg not found (brew install create-dmg) — building a plain image\n' >&2
  plain
fi

[[ -f "$OUT" ]] || die "no disk image was produced"

printf '\n  Built %s\n\n' "$OUT"
