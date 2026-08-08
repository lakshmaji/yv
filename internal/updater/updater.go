package updater

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// feedURL is the release feed: the GitHub API for this repo's own releases.
//
// There is no manifest file and no appcast. The releases API already carries
// everything a check needs — tag, notes, asset names, sizes and download URLs —
// and a hand-maintained manifest would be a second thing to publish and a second
// thing to get out of step with what was actually uploaded.
//
// A var rather than a const so tests can point it at an httptest server. No test
// in this package reaches GitHub.
var feedURL = "https://api.github.com/repos/lakshmaji/yv/releases"

// ReleasePage is where the UI sends anyone who cannot self-update — a .deb
// install, or a macOS bundle running from a read-only image.
const ReleasePage = "https://github.com/lakshmaji/yv/releases/latest"

const (
	// Metadata is small and a check happens at startup, so a stuck request must
	// not hold the launch path open.
	metadataTimeout = 15 * time.Second

	// Sidecars hold one token each. The caps are generous for their content and
	// tight enough that a wrong URL answering with a web page is refused rather
	// than read into memory.
	maxHashSidecar = 256
	maxSigSidecar  = 4096
)

var (
	// ErrDevBuild is returned when the running build has no real version. Such a
	// build has nothing meaningful to compare, so the check never leaves the
	// machine.
	ErrDevBuild = errors.New("development build")

	// ErrUpToDate is the ordinary successful outcome of a check. It is an error
	// value rather than a nil release so a caller cannot forget to distinguish
	// it from "found one" by accident.
	ErrUpToDate = errors.New("already up to date")

	// ErrRateLimited is worth its own value because it is the one failure that
	// resolves itself, and telling someone to wait is different advice from
	// telling them something is broken.
	ErrRateLimited = errors.New("GitHub rate limited this machine, try again later")

	// ErrNoAsset means a newer release exists but carries nothing for this
	// platform — a partial release, or one published before this platform was
	// supported.
	ErrNoAsset = errors.New("that release has no download for this platform")

	// ErrUnsigned is deliberate and final. A release without both sidecars
	// cannot be verified, and an unverified update is not installed.
	ErrUnsigned = errors.New("that release is not signed")
)

// Release is one downloadable update, with everything needed to fetch and verify
// it already resolved.
type Release struct {
	Version     string `json:"version"`
	Notes       string `json:"notes"`
	AssetName   string `json:"assetName"`
	DownloadURL string `json:"downloadUrl"`
	AssetSize   int64  `json:"assetSize"`
	// FileHash is the hex SHA-256 from the .sha256 sidecar, and Signature is the
	// base64 RSA signature from the .sig sidecar. Both are mandatory; a Release
	// never reaches a caller with either missing.
	FileHash  string `json:"fileHash"`
	Signature string `json:"signature"`
}

// Updater checks for and installs new releases.
type Updater struct {
	current string
	client  *http.Client
}

// New builds an updater for a binary reporting the given version. Pass
// main.version verbatim, including "dev" — the dev check lives in here rather
// than at every call site.
func New(currentVersion string) *Updater {
	return &Updater{
		current: currentVersion,
		client:  &http.Client{Timeout: metadataTimeout},
	}
}

// Current reports the version this updater is comparing against.
func (u *Updater) Current() string { return u.current }

// IsDevBuild reports whether this build has a real version at all.
func (u *Updater) IsDevBuild() bool { return !isRealVersion(u.current) }

func isRealVersion(v string) bool {
	return parseVersion(v).ok
}

// Check finds the newest release that is newer than the running build.
//
// Returns ErrUpToDate when there is nothing to do, which is the common case and
// not a failure. ErrDevBuild short-circuits before any request is made.
func (u *Updater) Check(ctx context.Context) (*Release, error) {
	if u.IsDevBuild() {
		return nil, ErrDevBuild
	}

	releases, err := u.fetchReleases(ctx)
	if err != nil {
		return nil, err
	}

	best := pickNewest(releases, u.current)
	if best == nil {
		return nil, ErrUpToDate
	}

	asset := pickAsset(best.Assets)
	if asset == nil {
		return nil, ErrNoAsset
	}

	rel := &Release{
		Version:     CanonicalVersion(best.TagName),
		Notes:       strings.TrimSpace(best.Body),
		AssetName:   asset.Name,
		DownloadURL: asset.BrowserDownloadURL,
		AssetSize:   asset.Size,
	}

	// The sidecars are separate assets rather than fields, because they are
	// produced after the artifact exists and by a different step. Fetching them
	// here means a Release handed to the downloader is already complete: there
	// is no path where the download runs and only then discovers it cannot be
	// checked.
	if rel.FileHash, err = u.fetchHash(ctx, best.Assets, asset.Name); err != nil {
		return nil, err
	}
	if rel.Signature, err = u.fetchSignature(ctx, best.Assets, asset.Name); err != nil {
		return nil, err
	}

	return rel, nil
}

// ── the GitHub payload ──────────────────────────────────────────────────

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type ghRelease struct {
	TagName    string    `json:"tag_name"`
	Body       string    `json:"body"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	Assets     []ghAsset `json:"assets"`
}

func (u *Updater) fetchReleases(ctx context.Context) ([]ghRelease, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feedURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "yv-updater")

	resp, err := u.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach GitHub: %w", err)
	}
	defer resp.Body.Close()

	// Unauthenticated, so this shares a 60-per-hour budget with everything else
	// on the same IP. An office behind one NAT can exhaust it, and that reads as
	// a 403 rather than a 429.
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		return nil, ErrRateLimited
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered %s", resp.Status)
	}

	var releases []ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("could not read the release list: %w", err)
	}
	return releases, nil
}

// pickNewest returns the highest release strictly newer than current, or nil.
//
// The feed is ordered by publish date, not by version, so a patch backported to
// an old branch and published late would come first. Comparing every entry is
// what makes the answer the newest *version* rather than the newest upload.
func pickNewest(releases []ghRelease, current string) *ghRelease {
	// Someone running a prerelease has opted into them and should be offered the
	// next one; someone on a stable release should not be moved onto an rc by a
	// routine background check.
	wantPre := len(parseVersion(current).pre) > 0

	var best *ghRelease
	for i := range releases {
		r := &releases[i]
		if r.Draft {
			continue
		}
		if r.Prerelease && !wantPre {
			continue
		}
		if !Newer(r.TagName, current) {
			continue
		}
		if best == nil || Newer(r.TagName, best.TagName) {
			best = r
		}
	}
	return best
}

// pickAsset finds the artifact for the platform this binary was built for.
//
// Matching on the full platform token rather than just the extension: a release
// carrying both an arm64 and an amd64 macOS DMG would otherwise be a coin toss,
// and installing the wrong architecture produces a bundle that will not launch
// with no clue as to why.
func pickAsset(assets []ghAsset) *ghAsset {
	token, ext := platformToken()
	if token == "" {
		return nil
	}
	for i := range assets {
		name := assets[i].Name
		if strings.Contains(name, token) && strings.HasSuffix(name, ext) {
			return &assets[i]
		}
	}
	return nil
}

// platformToken returns the infix and extension of this platform's artifact,
// matching the names build.yml uploads.
//
// Only the shapes that can actually install themselves appear here. Linux is the
// AppImage alone: the .deb lands in root-owned /usr/bin and the tarball could be
// anywhere, so neither can be replaced by the running process, and offering a
// download that cannot be applied is worse than reporting there is none.
func platformToken() (token, ext string) {
	switch runtime.GOOS {
	case "darwin":
		return "-macos-" + runtime.GOARCH + "-", ".dmg"
	case "windows":
		return "-windows-" + runtime.GOARCH + "-", ".zip"
	case "linux":
		// AppImage names use the uname spelling of the architecture, which is
		// not Go's.
		arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[runtime.GOARCH]
		if arch == "" {
			return "", ""
		}
		return "-linux-" + arch + "-", ".AppImage"
	}
	return "", ""
}

// ── sidecars ────────────────────────────────────────────────────────────

func (u *Updater) fetchHash(ctx context.Context, assets []ghAsset, artifact string) (string, error) {
	raw, err := u.fetchSidecar(ctx, assets, artifact+".sha256", maxHashSidecar)
	if err != nil {
		return "", err
	}
	if !isHexSHA256(raw) {
		return "", fmt.Errorf("the checksum published for %s is not a SHA-256", artifact)
	}
	return strings.ToLower(raw), nil
}

func (u *Updater) fetchSignature(ctx context.Context, assets []ghAsset, artifact string) (string, error) {
	raw, err := u.fetchSidecar(ctx, assets, artifact+".sig", maxSigSidecar)
	if err != nil {
		return "", err
	}
	if _, err := base64.StdEncoding.DecodeString(raw); err != nil {
		return "", fmt.Errorf("the signature published for %s is not valid base64", artifact)
	}
	return raw, nil
}

// fetchSidecar reads the first whitespace-delimited token out of a small
// companion asset.
//
// First token, because `shasum` writes "<hash>  <filename>" and only the hash is
// wanted. Capped, because the alternative is reading whatever the URL happens to
// serve.
func (u *Updater) fetchSidecar(ctx context.Context, assets []ghAsset, name string, limit int64) (string, error) {
	var url string
	for _, a := range assets {
		if a.Name == name {
			url = a.BrowserDownloadURL
			break
		}
	}
	if url == "" {
		return "", fmt.Errorf("%w: %s is missing", ErrUnsigned, name)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "yv-updater")

	resp, err := u.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not fetch %s: %w", name, err)
	}
	defer resp.Body.Close()

	// Without this the body of an error page is parsed as content, and its first
	// word becomes the "hash" — which then fails verification with a message
	// about a checksum mismatch rather than about a failed download.
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("could not fetch %s: %s", name, resp.Status)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	if err != nil {
		return "", fmt.Errorf("could not read %s: %w", name, err)
	}

	fields := strings.Fields(string(body))
	if len(fields) == 0 {
		return "", fmt.Errorf("%s is empty", name)
	}
	return fields[0], nil
}

func isHexSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}
