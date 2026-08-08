package updater

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// progressInterval matches the cadence internal/share uses for its own
	// transfers. A 500 MB download at 32 KB a chunk would otherwise emit tens of
	// thousands of events nobody can perceive.
	progressInterval = 250 * time.Millisecond

	// A download has no overall timeout — a large artifact on a slow connection
	// is not a failure. What is bounded is silence: stallTimeout without a single
	// byte arriving means the far end is gone, whatever the connection says.
	stallTimeout = 60 * time.Second

	// Nothing published is anywhere near this. It exists so that a wrong URL
	// serving an endless stream cannot fill the disk.
	maxArtifactBytes = 2 << 30 // 2 GiB
)

// ErrChecksumMismatch means the bytes that arrived are not the bytes the release
// said it published.
var ErrChecksumMismatch = errors.New("the download does not match its published checksum")

// UpdateDir is where downloads are staged: the app's own config directory, the
// same root internal/settings and internal/env already use, so there is one
// place holding this app's data rather than two.
func UpdateDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("UserConfigDir: %w", err)
	}
	updates := filepath.Join(dir, "yv", "updates")
	if err := os.MkdirAll(updates, 0o755); err != nil {
		return "", fmt.Errorf("MkdirAll: %w", err)
	}
	return updates, nil
}

// Progress reports how far a download has got. Total is 0 when the release did
// not publish a size, which the UI shows as an indeterminate bar rather than
// inventing a percentage.
type Progress struct {
	Downloaded int64
	Total      int64
}

// Download fetches a release artifact, verifies it, and returns the path it was
// written to.
//
// Verification is not a separate step a caller can forget: the file is written
// to a .part name and only renamed into place once the checksum, the size and
// the signature have all passed. There is no arrangement of calls that yields a
// verified-looking path to something unverified.
func (u *Updater) Download(ctx context.Context, rel *Release, onProgress func(Progress)) (string, error) {
	// Asked before a byte moves rather than after. A build with no key will
	// refuse this artifact whatever it contains, and finding that out at the end
	// costs someone hundreds of megabytes to learn nothing.
	if !HasTrustedKey() {
		return "", ErrNoTrustedKey
	}
	if rel.FileHash == "" || rel.Signature == "" {
		return "", ErrUnsigned
	}

	dir, err := UpdateDir()
	if err != nil {
		return "", err
	}

	name, err := safeAssetName(rel.AssetName)
	if err != nil {
		return "", err
	}
	final := filepath.Join(dir, name)
	partial := final + ".part"

	// A previous attempt may have died mid-write. Resuming would mean trusting a
	// prefix we never verified, so the remains are discarded — the alternative
	// saves bandwidth by reintroducing exactly the uncertainty this function
	// exists to remove.
	_ = os.Remove(partial)

	hash, size, err := u.streamTo(ctx, rel, partial, onProgress)
	if err != nil {
		_ = os.Remove(partial)
		return "", err
	}

	if err := verifyArtifact(rel, hash, size); err != nil {
		// A file that failed verification is not left on disk to be found later
		// and mistaken for a download worth keeping.
		_ = os.Remove(partial)
		return "", err
	}

	if err := os.Rename(partial, final); err != nil {
		_ = os.Remove(partial)
		return "", fmt.Errorf("could not finalise the download: %w", err)
	}
	return final, nil
}

func verifyArtifact(rel *Release, hash string, size int64) error {
	// Constant time, matching internal/share/helpers.go. The timing of a hash
	// comparison is not a realistic attack here, but a hash compared with == is
	// the kind of thing that gets copied into somewhere it does matter.
	if subtle.ConstantTimeCompare([]byte(strings.ToLower(hash)), []byte(rel.FileHash)) != 1 {
		return fmt.Errorf("%w (got %s, expected %s)", ErrChecksumMismatch, hash, rel.FileHash)
	}

	// The checksum already covers the content, so this catches only a release
	// whose published size disagrees with its published hash — which means the
	// two sidecars describe different builds, and nothing downstream should
	// proceed on a release that inconsistent.
	if rel.AssetSize > 0 && size != rel.AssetSize {
		return fmt.Errorf("the download is %d bytes, but the release lists %d", size, rel.AssetSize)
	}

	return verifySignature(rel.FileHash, rel.Signature)
}

// streamTo writes the body to path while hashing it, and returns the hex digest
// and the byte count.
func (u *Updater) streamTo(ctx context.Context, rel *Release, path string, onProgress func(Progress)) (string, int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rel.DownloadURL, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("User-Agent", "yv-updater")

	// A client of its own, without the metadata client's overall timeout — that
	// one is 15 seconds, which a 500 MB artifact would trip every time.
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("could not start the download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("download failed: %s", resp.Status)
	}

	f, err := os.Create(path)
	if err != nil {
		return "", 0, fmt.Errorf("could not open a file to download into: %w", err)
	}
	defer f.Close()

	total := rel.AssetSize
	if total <= 0 {
		total = resp.ContentLength
	}

	h := sha256.New()
	written, err := copyWithProgress(ctx, io.MultiWriter(f, h), resp.Body, total, onProgress)
	if err != nil {
		return "", 0, err
	}
	if err := f.Sync(); err != nil {
		return "", 0, fmt.Errorf("could not flush the download: %w", err)
	}

	return hex.EncodeToString(h.Sum(nil)), written, nil
}

// copyWithProgress is io.Copy with three additions: cancellation, a stall
// deadline, and throttled progress.
//
// Written out rather than using io.Copy with a wrapping reader because the
// cancellation check belongs between chunks, where it can stop promptly, and a
// reader wrapper would only see it on the next read — which on a dead connection
// is exactly the read that never returns.
func copyWithProgress(ctx context.Context, dst io.Writer, src io.Reader, total int64, onProgress func(Progress)) (int64, error) {
	buf := make([]byte, 32*1024)
	var written int64
	lastReport := time.Now()
	lastData := time.Now()

	report := func() {
		if onProgress != nil {
			onProgress(Progress{Downloaded: written, Total: total})
		}
	}

	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}

		n, readErr := src.Read(buf)
		if n > 0 {
			lastData = time.Now()
			if written+int64(n) > maxArtifactBytes {
				return written, fmt.Errorf("the download exceeded %d bytes and was stopped", int64(maxArtifactBytes))
			}
			if _, err := dst.Write(buf[:n]); err != nil {
				return written, fmt.Errorf("could not write the download: %w", err)
			}
			written += int64(n)

			if time.Since(lastReport) >= progressInterval {
				lastReport = time.Now()
				report()
			}
		}

		if readErr == io.EOF {
			report() // so the bar reaches its end rather than stopping short
			return written, nil
		}
		if readErr != nil {
			return written, fmt.Errorf("the download was interrupted: %w", readErr)
		}
		if n == 0 && time.Since(lastData) > stallTimeout {
			return written, fmt.Errorf("the download stalled for %s", stallTimeout)
		}
	}
}

// safeAssetName reduces a release-supplied name to a bare filename.
//
// The name comes from the release feed, which is to say from outside, and it is
// about to be joined to a path we then write to. A name of "../../../.bashrc" is
// not a realistic GitHub asset, but the cost of not being able to construct one
// is this function.
func safeAssetName(name string) (string, error) {
	base := filepath.Base(filepath.Clean(name))
	if base == "" || base == "." || base == ".." || base == string(filepath.Separator) {
		return "", fmt.Errorf("the release asset has no usable filename (%q)", name)
	}
	// Base already strips both separators on Windows, but a name arriving with a
	// Windows separator on a Unix host is not decomposed by it — and a release
	// built on Windows can name assets either way.
	if strings.ContainsAny(base, `/\`) {
		return "", fmt.Errorf("the release asset name contains a path separator (%q)", name)
	}
	return base, nil
}
