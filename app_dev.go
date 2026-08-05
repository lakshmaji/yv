//go:build yvdev

package main

import (
	_ "embed"
	"fmt"
	"os"
	"time"
)

// This file is compiled only under `-tags yvdev`, which `make run` and
// `make build-dev` pass and `make build` does not. A production binary gets
// the stub in app_nodev.go instead, so none of this ships.

// sampleSpec is the checked-in three-month dashboard sample. Embedding it
// keeps "Load sample data" a single click with no file picker — and the file
// stays editable in the repo for anyone who wants different shaped data.
//
//go:embed testdata/dashboard-sample-3months.json
var sampleSpec []byte

// sampleSpecEnv overrides the embedded spec with a file on disk, for iterating
// on the sample without rebuilding.
const sampleSpecEnv = "YV_SAMPLE_SPEC"

// SampleDataAvailable reports whether this build can seed sample metrics.
//
// The frontend asks Go rather than checking import.meta.env.DEV, because Vite
// still does a production build under `make build-dev` — the Go build tag is
// the only thing that actually decides whether the seeder exists.
func (a *App) SampleDataAvailable() bool { return true }

// ImportSampleMetrics replaces the metrics store with generated sample data so
// the dashboard has something to render during development.
func (a *App) ImportSampleMetrics() (string, error) {
	raw := sampleSpec
	source := "the built-in sample"

	if path := os.Getenv(sampleSpecEnv); path != "" {
		fromDisk, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", sampleSpecEnv, err)
		}
		raw, source = fromDisk, path
	}

	samples, runs, err := a.metrics.ImportSample(raw, time.Now())
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Loaded %s: %d samples, %d runs", source, samples, runs), nil
}
