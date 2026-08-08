//go:build !darwin

package updater

import "context"

// The fallback for any platform without an apply implementation, following the
// openfolder_other.go pattern already in this repo: the build stays green
// everywhere and the feature reports honestly that it is unavailable, rather
// than the package failing to compile.

func (u *Updater) InstallCheck() InstallState {
	return InstallState{
		CanSelfUpdate: false,
		Reason:        "Updates have to be installed by hand on this platform.",
	}
}

func (u *Updater) Apply(_ context.Context, _ string) error { return ErrNotSupported }

func (u *Updater) Relaunch() error { return ErrNotSupported }

func (u *Updater) SweepStale() {}
