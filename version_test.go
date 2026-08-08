package main

import (
	"encoding/json"
	"os"
	"testing"
)

// The app's version lives in two files by necessity: changesets can only bump a
// package.json, and the build can only read wails.json (the Makefile's -ldflags,
// build/linux/package-deb.sh, and CI's tag check all take productVersion from
// there). `bun run version` keeps them in step via scripts/sync-version.mjs.
//
// This test is what makes that a guarantee rather than a habit. Without it, a
// hand-edit of one file ships a .deb whose package version disagrees with the
// binary inside it — and the updater then compares the wrong number against the
// release feed, which is the one bug in this feature nobody would notice until
// an update refused to install.
func TestVersionFilesAgree(t *testing.T) {
	var pkg struct {
		Version string `json:"version"`
	}
	readJSON(t, "package.json", &pkg)

	var wails struct {
		Info struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	readJSON(t, "wails.json", &wails)

	if pkg.Version == "" {
		t.Fatal("package.json has no version")
	}
	if wails.Info.ProductVersion == "" {
		t.Fatal("wails.json has no info.productVersion")
	}

	if pkg.Version != wails.Info.ProductVersion {
		t.Errorf("version drift: package.json %q, wails.json %q\n"+
			"run `bun run sync-version` to bring wails.json into line",
			pkg.Version, wails.Info.ProductVersion)
	}
}

func readJSON(t *testing.T, path string, into any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}
