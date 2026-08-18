WAILS := $(HOME)/go/bin/wails

# The version the binary reports, taken from wails.json so there is exactly one
# place to bump — the same field build/linux/package-deb.sh reads. `bun run
# version` (changesets) writes it; version_test.go fails if package.json and
# wails.json ever disagree.
#
# Only the packaging targets pass this. `make run` deliberately does not, so the
# dev build keeps the "dev" default and the updater stays off the network.
VERSION := $(shell sed -n 's/.*"productVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' wails.json)
LDFLAGS := -X main.version=$(VERSION)

# Host detection. The darwin targets stay explicit about their platform (this is
# an Apple Silicon app), while the linux ones follow the machine they run on so a
# clone builds correctly on both amd64 and arm64 Ubuntu.
UNAME_S := $(shell uname -s)
GOARCH  := $(shell go env GOARCH 2>/dev/null)

# Ubuntu 22.04 ships webkit2gtk 4.0; 24.04 ships 4.1 and dropped 4.0. Wails needs
# a build tag to target 4.1, so the tag is chosen by looking at which -dev package
# is actually installed rather than by hardcoding a release.
WEBKIT_41 := $(shell pkg-config --exists webkit2gtk-4.1 2>/dev/null && echo yes)
ifeq ($(WEBKIT_41),yes)
  LINUX_TAGS := webkit2_41
  WEBKIT_DEV := libwebkit2gtk-4.1-dev
else
  LINUX_TAGS :=
  WEBKIT_DEV := libwebkit2gtk-4.0-dev
endif

.PHONY: run install fmt test test-go test-frontend build dmg dmg-background \
        appicon build-windows installer-windows embed-update-key \
        deps-linux build-linux run-linux deb install-linux uninstall-linux \
        doctor-linux update-keys appimage

install:
	go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.1

run: $(WAILS)
ifeq ($(UNAME_S),Linux)
	$(WAILS) dev $(if $(LINUX_TAGS),-tags $(LINUX_TAGS),)
else
	$(WAILS) dev
endif

fmt:
	gofmt -w $(shell find . -name "*.go" -not -path "*/wailsjs/*")

test: test-go test-frontend

# ./... rather than ./internal/... so the root package's tests run too — the
# Wails-bound facade has logic worth covering (share payload construction).
# -race because config.Store and settings.Store serialise read-modify-write
# cycles by hand; a dropped lock there silently loses a user's projects and
# nothing else in the suite would notice.
test-go:
	go test ./... -race -v

test-frontend:
	cd frontend && bun run test

build: $(WAILS)
	$(WAILS) build -platform darwin/arm64 -ldflags "$(LDFLAGS)"

# ── Update signing keys ─────────────────────────────────────────────────
#
# Generates the pair that signs releases. Run once, ever — see RELEASING.md for
# why rotating this is a two-release dance and why losing the private half is
# unrecoverable.
#
# The refusal to overwrite is the important line here. An accidental second run
# would replace the key every installed copy trusts, and there is no way to
# notice that until updates start being refused in the field.
update-keys:
	@if [ -f yv-update-private.pem ]; then \
	  echo "yv-update-private.pem already exists — refusing to overwrite it."; \
	  echo "Every installed copy trusts the matching public key; replacing it strands them."; \
	  exit 1; \
	fi
	openssl genrsa -out yv-update-private.pem 4096
	@chmod 600 yv-update-private.pem
	openssl rsa -in yv-update-private.pem -pubout -out yv-update-public.pem
	@echo
	@echo "  Two files written. Neither is committed (.gitignore covers both)."
	@echo
	@echo "  1. make embed-update-key      # writes the public half into"
	@echo "                                # internal/updater/signature.go"
	@echo "  2. Put yv-update-private.pem in the YV_UPDATE_PRIVATE_KEY repository"
	@echo "     secret, and keep an offline copy. It cannot be regenerated."
	@echo "  3. Delete yv-update-private.pem once both of those are done."
	@echo

# Writes yv-update-public.pem into updatePublicKeyPEM. Separate from update-keys
# because a rotation runs this one alone, against a key generated long before —
# and, per RELEASING.md, in a release of its own before CI signs with the new
# private half.
embed-update-key:
	@bash scripts/embed-update-key.sh

# ── macOS disk image ────────────────────────────────────────────────────
#
# The image users install from: yv.app beside an alias to /Applications, so the
# app ends up somewhere it can update itself from. Named like every other
# artifact, because internal/updater matches on these names.
#
# create-dmg is what positions the icons over the backdrop. Without it the script
# still builds the same image, just with Finder's default layout.
dmg: build
	@command -v create-dmg >/dev/null 2>&1 || \
	  echo "  (brew install create-dmg for the laid-out window)"
	@bash build/darwin/package-dmg.sh

# Redraws build/darwin/dmg-background.png. The PNG is committed, so this is only
# needed when the window size or the icon positions in package-dmg.sh change —
# Finder tiles a backdrop that no longer matches the window.
dmg-background:
	go run ./cmd/dmg-background build/darwin/dmg-background.png

# ── App icon ────────────────────────────────────────────────────────────
#
# Redraws build/appicon.png from build/appicon-source.png. Both are committed,
# so this is only needed when the artwork changes — but build/appicon.png is the
# single icon everything derives from (Wails makes the .icns and the .ico from
# it; the Linux packaging scripts copy it), so changing it is one command.
appicon:
	go run ./cmd/appicon

# ── Windows ─────────────────────────────────────────────────────────────
#
# Cross-compiled from macOS or Linux: the Windows build is cgo-free, unlike the
# Linux one. These are for trying the packaging locally; CI is what ships.
build-windows: $(WAILS)
	$(WAILS) build -platform windows/amd64 -ldflags "$(LDFLAGS)"

# Produces build/bin/yv-amd64-installer.exe from build/windows/installer/project.nsi.
#
# The makensis check is not redundant: `wails build -nsis` treats a missing
# makensis as a warning, finishes successfully, and simply does not write an
# installer — so without this the target would look like it worked.
installer-windows: $(WAILS)
	@command -v makensis >/dev/null 2>&1 || { \
	  echo "makensis not found — install NSIS first (macOS: brew install nsis)."; \
	  exit 1; \
	}
	$(WAILS) build -platform windows/amd64 -nsis -ldflags "$(LDFLAGS)"
	@test -f build/bin/yv-amd64-installer.exe || \
	  { echo "no installer was produced"; exit 1; }
	@echo
	@echo "  Built build/bin/yv-amd64-installer.exe"
	@echo

# ── Linux / Ubuntu ──────────────────────────────────────────────────────
#
# These are meant to run *on* Ubuntu, on a fresh clone. Wails needs cgo against
# webkit2gtk and gtk3, so there is no cross-compiling this from macOS — build it
# on the machine (or a VM/container) you intend to run it on.
#
#   make deps-linux    # one time: system libraries + build tools
#   make build-linux   # produces build/bin/yv
#   make deb           # produces build/bin/yv_<version>_<arch>.deb
#
# `sudo apt install ./build/bin/yv_*.deb` then installs it with its dependencies.

# Installs everything needed to build. Kept separate from build-linux so the
# build itself never needs sudo.
deps-linux:
	@set -e; \
	. /etc/os-release; \
	echo "Detected $$PRETTY_NAME"; \
	if dpkg --compare-versions "$$VERSION_ID" ge 24.04 2>/dev/null; then \
	  WEBKIT=libwebkit2gtk-4.1-dev; \
	else \
	  WEBKIT=libwebkit2gtk-4.0-dev; \
	fi; \
	echo "Installing $$WEBKIT and build tools…"; \
	sudo apt-get update; \
	sudo apt-get install -y \
	  build-essential pkg-config libgtk-3-dev $$WEBKIT \
	  dpkg-dev fakeroot procps
	@echo
	@echo "System libraries installed."
	@command -v go   >/dev/null || echo "  ! Go is not installed — needs $$(sed -n 's/^go //p' go.mod). The apt version is usually too old; see https://go.dev/dl/"
	@command -v bun  >/dev/null || echo "  ! Bun is not installed — run 'curl -fsSL https://bun.sh/install | bash'"

# Reports whether this machine can build, and what it would build against.
# Cheaper to run than a failed build with a confusing cgo error.
doctor-linux:
	@echo "os:      $$(. /etc/os-release; echo $$PRETTY_NAME)"
	@echo "arch:    $(GOARCH)"
	@echo "go:      $$(go version 2>/dev/null || echo 'MISSING')"
	@echo "bun:     $$(bun --version 2>/dev/null || echo 'MISSING')"
	@echo "gtk3:    $$(pkg-config --modversion gtk+-3.0 2>/dev/null || echo 'MISSING')"
	@# An if rather than && || chaining: the latter prints both branches, because
	@# the echo that follows a successful match succeeds too and re-triggers the
	@# next &&.
	@if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then \
	  echo "webkit:  $$(pkg-config --modversion webkit2gtk-4.1) (4.1)"; \
	elif pkg-config --exists webkit2gtk-4.0 2>/dev/null; then \
	  echo "webkit:  $$(pkg-config --modversion webkit2gtk-4.0) (4.0)"; \
	else \
	  echo "webkit:  MISSING — run 'make deps-linux'"; \
	fi
	@echo "tags:    $(if $(LINUX_TAGS),$(LINUX_TAGS),none)"
	@if command -v dpkg-deb >/dev/null; then echo "dpkg-deb: ok"; else echo "dpkg-deb: MISSING"; fi

build-linux: $(WAILS)
	$(WAILS) build -platform linux/$(GOARCH) $(if $(LINUX_TAGS),-tags $(LINUX_TAGS),) -ldflags "$(LDFLAGS)"
	@echo
	@echo "Built build/bin/yv — run it directly, or 'make deb' to package it."

# The dev server on Linux, where the webkit tag matters.
run-linux: $(WAILS)
	$(WAILS) dev $(if $(LINUX_TAGS),-tags $(LINUX_TAGS),)

deb: build-linux
	@bash build/linux/package-deb.sh

# The AppImage is the only Linux artifact yv can update in place — see the
# comment at the top of the script for why the .deb and the tarball cannot.
# Needs appimagetool on PATH, or APPIMAGETOOL pointing at it.
appimage: build-linux
	@bash build/linux/package-appimage.sh

# Repacks the binary build-linux just produced as a snap. Classic confinement,
# so nothing here is sandboxed at runtime — see specs/001-snap-store/design.md
# for why that is required rather than convenient.
#
# --use-lxd because the default destructive mode would install core24 build
# dependencies onto this machine.
snap: build-linux
	@command -v snapcraft >/dev/null || { echo "snapcraft is missing — 'sudo snap install snapcraft --classic'"; exit 1; }
	snapcraft --use-lxd
	@echo
	@echo "Built yv-tool_$(VERSION)_amd64.snap"
	@echo "Install it with: sudo snap install --classic --dangerous ./yv-tool_*.snap"

# Convenience for a local machine: build, package, install. Separate from `deb`
# because packaging should never require root.
install-linux: deb
	sudo apt install -y ./build/bin/yv_*_$(shell dpkg --print-architecture 2>/dev/null).deb

uninstall-linux:
	sudo apt remove -y yv

$(WAILS):
	$(MAKE) install
