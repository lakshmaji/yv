WAILS := $(HOME)/go/bin/wails

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

.PHONY: run install fmt test test-go test-frontend build build-dev dmg \
        deps-linux build-linux run-linux deb install-linux uninstall-linux \
        doctor-linux

install:
	go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.1

# The `yvdev` tag compiles app_dev.go, which enables importing sample dashboard
# data. `build` deliberately omits it, so no seeding code ships to production.
run: $(WAILS)
ifeq ($(UNAME_S),Linux)
	$(WAILS) dev -tags "yvdev $(LINUX_TAGS)"
else
	$(WAILS) dev -tags yvdev
endif

# A production-shaped build with the dev tooling still available, for testing
# the packaged app against sample data.
build-dev: $(WAILS)
	$(WAILS) build -platform darwin/arm64 -tags yvdev

fmt:
	gofmt -w $(shell find . -name "*.go" -not -path "*/wailsjs/*")

test: test-go test-frontend

# ./... rather than ./internal/... so the root package's tests run too — the
# Wails-bound facade has logic worth covering (share payload construction).
test-go:
	go test ./... -v

test-frontend:
	cd frontend && bun run test

build: $(WAILS)
	$(WAILS) build -platform darwin/arm64

dmg: build
	mkdir -p /tmp/yv-dmg
	cp -r build/bin/yv.app /tmp/yv-dmg/
	hdiutil create -volname "yv" -srcfolder /tmp/yv-dmg -ov -format UDZO yv.dmg
	rm -rf /tmp/yv-dmg

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
	$(WAILS) build -platform linux/$(GOARCH) $(if $(LINUX_TAGS),-tags $(LINUX_TAGS),)
	@echo
	@echo "Built build/bin/yv — run it directly, or 'make deb' to package it."

# Same as build-linux but with the sample-data tooling compiled in.
run-linux: $(WAILS)
	$(WAILS) dev -tags "yvdev $(LINUX_TAGS)"

deb: build-linux
	@bash build/linux/package-deb.sh

# Convenience for a local machine: build, package, install. Separate from `deb`
# because packaging should never require root.
install-linux: deb
	sudo apt install -y ./build/bin/yv_*_$(shell dpkg --print-architecture 2>/dev/null).deb

uninstall-linux:
	sudo apt remove -y yv

$(WAILS):
	$(MAKE) install
