//go:build darwin

package main

// openFolder reveals a directory in Finder.
//
// `open` rather than the Wails runtime's BrowserOpenURL: that validates the
// scheme and accepts only http(s), so a file:// URL is refused before anything
// is shown.
//
// The exit status is waited for — see runOpener. `open` returns as soon as it
// has handed the path to LaunchServices, so this does not block on Finder, but
// it does mean a path Finder rejects is reported instead of silently claiming
// to have worked.
func openFolder(dir string) error {
	return runOpener("open", dir)
}
