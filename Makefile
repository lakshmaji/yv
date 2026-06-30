WAILS := $(HOME)/go/bin/wails

.PHONY: run install fmt test build dmg

install:
	go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.1

run: $(WAILS)
	$(WAILS) dev

fmt:
	gofmt -w $(shell find . -name "*.go" -not -path "*/wailsjs/*")

test:
	go test ./internal/... -v

build: $(WAILS)
	$(WAILS) build -platform darwin/arm64

dmg: build
	mkdir -p /tmp/yv-dmg
	cp -r build/bin/yv.app /tmp/yv-dmg/
	hdiutil create -volname "yv" -srcfolder /tmp/yv-dmg -ov -format UDZO yv.dmg
	rm -rf /tmp/yv-dmg

$(WAILS):
	$(MAKE) install
