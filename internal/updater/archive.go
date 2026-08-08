package updater

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Unpacking and swapping files, split out of apply_windows.go so it builds — and
// therefore runs — on every platform.
//
// Only Windows calls this today, and the test suite for the project is developed
// on macOS. Left behind a `windows` build tag, the zip-slip guard below would be
// the single highest-risk function in the updater and the only one nothing here
// could execute. Nothing in it is platform-specific: filepath handles the
// separator, and the logic is the same everywhere.

// extractZip unpacks an archive into dest, refusing any entry that would land
// outside it.
func extractZip(ctx context.Context, zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("could not open the downloaded archive: %w", err)
	}
	defer r.Close()

	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	// The trailing separator is load bearing. Without it, an entry resolving to
	// a sibling directory whose name merely starts with the same characters —
	// "…/staged-evil" against a root of "…/staged" — passes the prefix test and
	// is written outside the directory we chose.
	root := filepath.Clean(dest) + string(filepath.Separator)

	for _, f := range r.File {
		if err := ctx.Err(); err != nil {
			return err
		}

		// The entry name comes from the archive, which is to say from the
		// internet. An entry called "../../../../etc/cron.d/evil" is the
		// zip-slip write-anywhere bug, and it costs one comparison to close.
		target := filepath.Join(dest, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(target, root) {
			return fmt.Errorf("the archive contains an entry outside itself (%q)", f.Name)
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := writeZipEntry(f, target); err != nil {
			return err
		}
	}
	return nil
}

func writeZipEntry(f *zip.File, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}

	src, err := f.Open()
	if err != nil {
		return fmt.Errorf("could not read %s from the archive: %w", f.Name, err)
	}
	defer src.Close()

	// The owner-write bit is forced on: an archive entry recorded as read-only
	// cannot otherwise be replaced by the next update, which would break exactly
	// once and only in the field.
	dst, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode().Perm()|0o200)
	if err != nil {
		return err
	}
	defer dst.Close()

	// Bounded by the same ceiling the download is, so an archive that is small
	// on the wire cannot expand without limit on the disk.
	if _, err := io.Copy(dst, io.LimitReader(src, maxArtifactBytes)); err != nil {
		return fmt.Errorf("could not extract %s: %w", f.Name, err)
	}
	return nil
}

// copyTree copies src over dst, moving anything it is about to overwrite into
// backup first.
//
// Files in dst that the update does not carry are left alone. An update is not a
// reinstall, and removing a file the user's own state lives in would make it one.
//
// Displaced files are moved rather than copied: same volume, so it costs a
// directory entry instead of the bytes, which matters when what is being
// replaced is the whole install.
func copyTree(src, dst, backup string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}

		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}

		if _, err := os.Stat(target); err == nil {
			saved := filepath.Join(backup, rel)
			if err := os.MkdirAll(filepath.Dir(saved), 0o755); err != nil {
				return err
			}
			if err := os.Rename(target, saved); err != nil {
				return fmt.Errorf("could not set %s aside: %w", rel, err)
			}
		}

		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode.Perm()|0o200)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// restoreBackup puts displaced files back where they were.
//
// Every error is swallowed. This runs only when the update has already failed,
// and returning a second error would replace the one explaining what actually
// went wrong with one about the cleanup.
func restoreBackup(backup, dst string) {
	_ = filepath.Walk(backup, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(backup, path)
		if err != nil {
			return nil
		}
		target := filepath.Join(dst, rel)
		_ = os.MkdirAll(filepath.Dir(target), 0o755)
		_ = os.Remove(target)
		_ = os.Rename(path, target)
		return nil
	})
	_ = os.RemoveAll(backup)
}
