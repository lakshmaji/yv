WAILS := $(HOME)/go/bin/wails

.PHONY: run install

install:
	go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.1

run: $(WAILS)
	$(WAILS) dev

$(WAILS):
	$(MAKE) install
