//go:build !yvdev

package main

import "fmt"

// Production stub. The real implementation lives in app_dev.go behind the
// `yvdev` build tag, so a `make build` binary contains no sample-seeding code at
// all. The method itself still exists so the generated TypeScript bindings are
// identical in both builds and the frontend never has to feature-detect.
// SampleDataAvailable is false here, so the dashboard hides its sample-data
// button entirely rather than offering an action that always fails.
func (a *App) SampleDataAvailable() bool { return false }

func (a *App) ImportSampleMetrics() (string, error) {
	return "", fmt.Errorf("sample metrics can only be imported in a development build")
}
