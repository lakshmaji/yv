#!/usr/bin/env bash
#
# Packages an already-built Linux binary into an installable .deb.
#
# Run via `make deb` rather than directly — the Makefile is what guarantees the
# binary exists and was built against the right webkit.
#
# Runtime dependencies are derived from the binary with dpkg-shlibdeps rather
# than hardcoded, because the package names differ across Ubuntu releases
# (libwebkit2gtk-4.0-37 on 22.04 vs libwebkit2gtk-4.1-0 on 24.04, and the t64
# rename of libgtk-3-0 in 24.04). Asking the linker what it actually needs is
# both correct and release-agnostic.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BIN="${BIN:-build/bin/yv}"
OUT_DIR="${OUT_DIR:-build/bin}"
PKG_NAME="yv"

die() { printf 'package-deb: %s\n' "$1" >&2; exit 1; }

[[ -f "$BIN" ]] || die "no binary at $BIN — run 'make build-linux' first"
command -v dpkg-deb >/dev/null || die "dpkg-deb not found — run 'make deps-linux'"

# Version comes from wails.json so there is one source of truth. Parsed with sed
# rather than jq to avoid a dependency for one field.
VERSION="$(sed -n 's/.*"productVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' wails.json)"
VERSION="${VERSION:-0.0.0}"
ARCH="$(dpkg --print-architecture)"

# Scoped to the "author" block: wails.json also has a top-level "name" (the app
# name), which a first-match grep would pick up instead of the person.
AUTHOR_BLOCK="$(sed -n '/"author"/,/}/p' wails.json)"
NAME="$(printf '%s' "$AUTHOR_BLOCK" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
EMAIL="$(printf '%s' "$AUTHOR_BLOCK" | sed -n 's/.*"email"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
MAINTAINER="${NAME:-unknown} <${EMAIL:-unknown@example.com}>"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

ROOT="$STAGE/pkg"
install -Dm755 "$BIN" "$ROOT/usr/bin/$PKG_NAME"
install -Dm644 build/linux/yv.desktop "$ROOT/usr/share/applications/$PKG_NAME.desktop"

# Both icon locations on purpose: hicolor is what current desktops index, and
# pixmaps is the legacy path that everything still falls back to. The source
# icon is 1024x1024 and is not resized, so no ImageMagick dependency.
install -Dm644 build/appicon.png "$ROOT/usr/share/icons/hicolor/512x512/apps/$PKG_NAME.png"
install -Dm644 build/appicon.png "$ROOT/usr/share/pixmaps/$PKG_NAME.png"

# --- dependency discovery ---
#
# dpkg-shlibdeps insists on being run from a source tree with debian/control, so
# a throwaway one is staged next to the package root.
DEPENDS=""
if command -v dpkg-shlibdeps >/dev/null; then
  mkdir -p "$STAGE/debian"
  cat > "$STAGE/debian/control" <<CONTROL
Source: $PKG_NAME

Package: $PKG_NAME
Architecture: any
CONTROL

  if ( cd "$STAGE" \
        && dpkg-shlibdeps --ignore-missing-info -O "pkg/usr/bin/$PKG_NAME" \
             > shlibdeps.txt 2> shlibdeps.err ); then
    DEPENDS="$(sed -n 's/^shlibs:Depends=//p' "$STAGE/shlibdeps.txt")"
  else
    printf 'package-deb: dpkg-shlibdeps failed, falling back to a static list\n' >&2
    sed 's/^/  /' "$STAGE/shlibdeps.err" >&2 || true
  fi
fi

if [[ -z "$DEPENDS" ]]; then
  # Only reached when dpkg-shlibdeps is unavailable or unhappy. Alternatives
  # cover both the 22.04 and 24.04 package names so the .deb still installs.
  DEPENDS="libc6, libgtk-3-0 | libgtk-3-0t64, libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37"
fi

# procps is declared explicitly: the resource monitor shells out to `ps`, and
# dpkg-shlibdeps only ever sees linked libraries, never a subprocess.
DEPENDS="$DEPENDS, procps"

INSTALLED_KB="$(du -sk "$ROOT" | cut -f1)"

cat > "$STAGE/control" <<CONTROL
Package: $PKG_NAME
Version: $VERSION
Section: devel
Priority: optional
Architecture: $ARCH
Depends: $DEPENDS
Maintainer: $MAINTAINER
Installed-Size: $INSTALLED_KB
Description: Per-project dev command runner
 yv keeps each project's shell commands in one place and streams their
 output into collapsible inline terminals, with per-command resource
 usage and a Discovery view for sharing config with nearby machines.
CONTROL

install -Dm644 "$STAGE/control" "$ROOT/DEBIAN/control"

DEB="$OUT_DIR/${PKG_NAME}_${VERSION}_${ARCH}.deb"
mkdir -p "$OUT_DIR"
dpkg-deb --root-owner-group --build "$ROOT" "$DEB" >/dev/null

printf '\n  Built %s\n\n' "$DEB"
dpkg-deb --info "$DEB" | sed 's/^/  /'
printf '\n  Install with:  sudo apt install ./%s\n\n' "$DEB"
