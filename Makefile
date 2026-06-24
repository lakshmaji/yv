WAILS := $(HOME)/go/bin/wails

.PHONY: run install fmt test

install:
	go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.1

run: $(WAILS)
	$(WAILS) dev

fmt:
	gofmt -w $(shell find . -name "*.go" -not -path "*/wailsjs/*")

test:
	go test ./internal/... -v

$(WAILS):
	$(MAKE) install
