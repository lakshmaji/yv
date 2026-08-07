//go:build !darwin

package share

// markQuarantine does nothing off macOS.
//
// The quarantine xattr is a Gatekeeper mechanism; no other platform reads it,
// and inventing a local equivalent would be a policy this app has no business
// setting. Received files are still written without the execute bit and are
// never run.
func markQuarantine(string) {}
