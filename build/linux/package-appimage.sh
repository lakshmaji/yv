#!/usr/bin/env bash
#
# Packages an already-built Linux binary into a self-updating AppImage.
#
# This is the *only* Linux artifact yv can update in place. The .deb installs to
# root-owned /usr/bin, where replacing the binary means a graphical sudo prompt on
# every update and going behind dpkg's back so apt keeps believing the old version
# is installed; the tarball is a loose binary with nothing marking it as ours. An
# AppImage is one file the user owns, so the update is a rename.
#
# Run via `make appimage`, which guarantees the binary exists first.
#
# The AppImage runtime sets APPIMAGE to this file's path when it runs, and
# internal/updater/apply_linux.go treats that variable's presence as the entire
# test for "can this copy replace itself". Nothing else distinguishes an AppImage
# install from a tarball — the payload sees an ordinary filesystem either way.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BIN="${BIN:-build/bin/yv}"
OUT_DIR="${OUT_DIR:-build/bin}"
APP="yv"

die() { printf 'package-appimage: %s\n' "$1" >&2; exit 1; }

[[ -f "$BIN" ]] || die "no binary at $BIN — run 'make build-linux' first"

# The filename label. Defaults to wails.json — the same source package-deb.sh
# and the Makefile's ldflags use — but CI overrides it, because there the label
# is the tag and the tag keeps its leading "v". Every other artifact in a release
# is named that way, and internal/updater matches on these names, so the AppImage
# cannot be the one that spells it differently.
VERSION="${VERSION:-$(sed -n 's/.*"productVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' wails.json)}"
VERSION="${VERSION:-0.0.0}"

# AppImage names carry the uname spelling of the architecture, not Go's, and
# internal/updater matches on it — so this mapping and the one in platformToken
# have to agree.
case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
  amd64|x86_64)  ARCH=x86_64 ;;
  arm64|aarch64) ARCH=aarch64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

APPDIR="$(mktemp -d)/${APP}.AppDir"
trap 'rm -rf "$(dirname "$APPDIR")"' EXIT

# appimagetool wants the desktop file, the icon and the entrypoint at the AppDir
# root, matching the Name/Icon in the .desktop. build/linux/yv.desktop already
# says Exec=yv and Icon=yv, so it is reused rather than duplicated here — one
# desktop entry for the .deb and the AppImage keeps the menu entry identical
# however yv was installed.
install -Dm755 "$BIN" "$APPDIR/usr/bin/$APP"
install -Dm644 build/linux/yv.desktop "$APPDIR/usr/share/applications/$APP.desktop"
install -Dm644 build/appicon.png "$APPDIR/usr/share/icons/hicolor/512x512/apps/$APP.png"

cp build/linux/yv.desktop "$APPDIR/$APP.desktop"
cp build/appicon.png "$APPDIR/$APP.png"
# .DirIcon is what file managers read; without it the AppImage shows a generic
# icon in the very place a user goes looking for it.
cp build/appicon.png "$APPDIR/.DirIcon"

cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/sh
# exec, not a subshell: the app should be the process the AppImage runtime
# started, so a desktop launcher or a shell job tracks it directly.
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/yv" "$@"
APPRUN
chmod 755 "$APPDIR/AppRun"

# appimagetool is itself an AppImage. --appimage-extract-and-run avoids needing
# FUSE, which a CI runner and most containers do not have.
TOOL="${APPIMAGETOOL:-}"
if [[ -z "$TOOL" ]]; then
  TOOL="$(command -v appimagetool || true)"
fi
[[ -n "$TOOL" ]] || die "appimagetool not found — set APPIMAGETOOL=/path/to/appimagetool"

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/${APP}-linux-${ARCH}-${VERSION}.AppImage"

# ARCH is read from the environment by appimagetool, which otherwise guesses
# from the binary and fails on a cross-built AppDir.
# No update information is embedded: yv does its own checking against the
# GitHub releases API, and a zsync URL would be a second, unused mechanism.
ARCH="$ARCH" "$TOOL" --appimage-extract-and-run --no-appstream "$APPDIR" "$OUT" >&2

chmod 755 "$OUT"
printf '\n  Built %s\n\n' "$OUT"
