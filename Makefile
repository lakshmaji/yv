WAILS := $(HOME)/go/bin/wails

.PHONY: run install fmt test test-go test-frontend build build-dev dmg

install:
	go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.1

# The `yvdev` tag compiles app_dev.go, which enables importing sample dashboard
# data. `build` deliberately omits it, so no seeding code ships to production.
run: $(WAILS)
	$(WAILS) dev -tags yvdev

# A production-shaped build with the dev tooling still available, for testing
# the packaged app against sample data.
build-dev: $(WAILS)
	$(WAILS) build -platform darwin/arm64 -tags yvdev

fmt:
	gofmt -w $(shell find . -name "*.go" -not -path "*/wailsjs/*")

test: test-go test-frontend

test-go:
	go test ./internal/... -v

test-frontend:
	cd frontend && npm run test

build: $(WAILS)
	$(WAILS) build -platform darwin/arm64

dmg: build
	mkdir -p /tmp/yv-dmg
	cp -r build/bin/yv.app /tmp/yv-dmg/
	hdiutil create -volname "yv" -srcfolder /tmp/yv-dmg -ov -format UDZO yv.dmg
	rm -rf /tmp/yv-dmg

$(WAILS):
	$(MAKE) install
