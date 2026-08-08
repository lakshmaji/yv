package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

// assetName builds the artifact name for the platform the test binary is running
// on, so the fixtures match what pickAsset will look for wherever the suite runs.
func assetName(version string) string {
	token, ext := platformToken()
	return "yv" + token + version + ext
}

// feed spins up a stand-in for the GitHub releases API and points the package at
// it. Nothing in this package's tests touches the network.
func feed(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	previous := feedURL
	feedURL = srv.URL
	t.Cleanup(func() { feedURL = previous })

	return srv
}

// release builds one entry with its artifact and both sidecars, served from srv.
func release(srv *httptest.Server, tag string, opts ...func(*ghRelease)) ghRelease {
	name := assetName(strings.TrimPrefix(tag, "v"))
	asset := func(n string) ghAsset {
		return ghAsset{Name: n, BrowserDownloadURL: srv.URL + "/dl/" + n, Size: 1024}
	}
	r := ghRelease{
		TagName: tag,
		Body:    "notes for " + tag,
		Assets:  []ghAsset{asset(name), asset(name + ".sha256"), asset(name + ".sig")},
	}
	for _, o := range opts {
		o(&r)
	}
	return r
}

const (
	testHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	testSig  = "c2lnbmF0dXJl"
)

// serve answers the release list plus whatever sidecar bodies the test wants.
func serve(releases []ghRelease, sidecars map[string]string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if name, ok := strings.CutPrefix(r.URL.Path, "/dl/"); ok {
			body, known := sidecars[name]
			if !known {
				switch {
				case strings.HasSuffix(name, ".sha256"):
					body = testHash + "  " + strings.TrimSuffix(name, ".sha256")
				case strings.HasSuffix(name, ".sig"):
					body = testSig
				default:
					body = "artifact bytes"
				}
			}
			fmt.Fprint(w, body)
			return
		}
		_ = json.NewEncoder(w).Encode(releases)
	}
}

func TestCheckFindsANewerRelease(t *testing.T) {
	var srv *httptest.Server
	srv = feed(t, func(w http.ResponseWriter, r *http.Request) {
		serve([]ghRelease{release(srv, "v0.3.0"), release(srv, "v0.2.0")}, nil)(w, r)
	})

	rel, err := New("0.2.0").Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if rel.Version != "0.3.0" {
		t.Errorf("version = %q, want 0.3.0", rel.Version)
	}
	if rel.Notes != "notes for v0.3.0" {
		t.Errorf("notes = %q", rel.Notes)
	}
	if rel.FileHash != testHash {
		t.Errorf("hash = %q, want %q", rel.FileHash, testHash)
	}
	if rel.Signature != testSig {
		t.Errorf("signature = %q, want %q", rel.Signature, testSig)
	}
	if !strings.HasSuffix(rel.AssetName, assetSuffix()) {
		t.Errorf("asset %q is not for this platform", rel.AssetName)
	}
}

func assetSuffix() string {
	_, ext := platformToken()
	return ext
}

// The feed is ordered by publish date, so a patch backported to an old branch and
// published late arrives first. The newest *version* has to win regardless.
func TestCheckPicksTheHighestVersionNotTheFirstListed(t *testing.T) {
	var srv *httptest.Server
	srv = feed(t, func(w http.ResponseWriter, r *http.Request) {
		serve([]ghRelease{
			release(srv, "v0.2.4"), // published most recently
			release(srv, "v0.9.0"),
			release(srv, "v0.3.1"),
		}, nil)(w, r)
	})

	rel, err := New("0.2.0").Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if rel.Version != "0.9.0" {
		t.Errorf("version = %q, want 0.9.0", rel.Version)
	}
}

func TestCheckOutcomes(t *testing.T) {
	tests := []struct {
		name     string
		current  string
		releases func(*httptest.Server) []ghRelease
		want     error
	}{
		{
			name:     "already newest",
			current:  "0.3.0",
			releases: func(s *httptest.Server) []ghRelease { return []ghRelease{release(s, "v0.3.0")} },
			want:     ErrUpToDate,
		},
		{
			name:     "running ahead of the feed",
			current:  "0.4.0",
			releases: func(s *httptest.Server) []ghRelease { return []ghRelease{release(s, "v0.3.0")} },
			want:     ErrUpToDate,
		},
		{
			name:     "no releases at all",
			current:  "0.1.0",
			releases: func(*httptest.Server) []ghRelease { return nil },
			want:     ErrUpToDate,
		},
		{
			name:    "drafts are not offered",
			current: "0.1.0",
			releases: func(s *httptest.Server) []ghRelease {
				return []ghRelease{release(s, "v0.9.0", func(r *ghRelease) { r.Draft = true })}
			},
			want: ErrUpToDate,
		},
		{
			name:    "prereleases are not offered to a stable build",
			current: "0.1.0",
			releases: func(s *httptest.Server) []ghRelease {
				return []ghRelease{release(s, "v0.9.0-rc.1", func(r *ghRelease) { r.Prerelease = true })}
			},
			want: ErrUpToDate,
		},
		{
			name:    "no artifact for this platform",
			current: "0.1.0",
			releases: func(s *httptest.Server) []ghRelease {
				r := release(s, "v0.9.0")
				r.Assets = []ghAsset{{Name: "yv-solaris-sparc-0.9.0.tar.gz", BrowserDownloadURL: s.URL + "/dl/x"}}
				return []ghRelease{r}
			},
			want: ErrNoAsset,
		},
		{
			name:    "artifact published without a checksum",
			current: "0.1.0",
			releases: func(s *httptest.Server) []ghRelease {
				r := release(s, "v0.9.0")
				r.Assets = r.Assets[:1] // the artifact alone
				return []ghRelease{r}
			},
			want: ErrUnsigned,
		},
		{
			name:    "artifact published without a signature",
			current: "0.1.0",
			releases: func(s *httptest.Server) []ghRelease {
				r := release(s, "v0.9.0")
				r.Assets = r.Assets[:2] // artifact and .sha256, no .sig
				return []ghRelease{r}
			},
			want: ErrUnsigned,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var srv *httptest.Server
			srv = feed(t, func(w http.ResponseWriter, r *http.Request) {
				serve(tt.releases(srv), nil)(w, r)
			})

			_, err := New(tt.current).Check(context.Background())
			if !errors.Is(err, tt.want) {
				t.Errorf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

// Someone on a prerelease has opted in and should be offered the next one.
func TestPrereleasesAreOfferedToAPrereleaseBuild(t *testing.T) {
	var srv *httptest.Server
	srv = feed(t, func(w http.ResponseWriter, r *http.Request) {
		serve([]ghRelease{
			release(srv, "v0.9.0-rc.2", func(r *ghRelease) { r.Prerelease = true }),
		}, nil)(w, r)
	})

	rel, err := New("0.9.0-rc.1").Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if rel.Version != "0.9.0-rc.2" {
		t.Errorf("version = %q, want 0.9.0-rc.2", rel.Version)
	}
}

// A dev build must not generate traffic. The server counts requests rather than
// the test merely asserting on the error, because the error is easy to return
// from the wrong place — after the request.
func TestDevBuildNeverReachesTheNetwork(t *testing.T) {
	var hits int
	feed(t, func(w http.ResponseWriter, r *http.Request) {
		hits++
		serve(nil, nil)(w, r)
	})

	for _, v := range []string{"dev", "", "latest", "not-a-version"} {
		t.Run(v, func(t *testing.T) {
			_, err := New(v).Check(context.Background())
			if !errors.Is(err, ErrDevBuild) {
				t.Errorf("err = %v, want ErrDevBuild", err)
			}
		})
	}
	if hits != 0 {
		t.Errorf("made %d request(s) from a dev build, want 0", hits)
	}
}

func TestRateLimitIsItsOwnAnswer(t *testing.T) {
	for _, code := range []int{http.StatusForbidden, http.StatusTooManyRequests} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			feed(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
			})
			_, err := New("0.1.0").Check(context.Background())
			if !errors.Is(err, ErrRateLimited) {
				t.Errorf("err = %v, want ErrRateLimited", err)
			}
		})
	}
}

// A sidecar URL that answers with an error page must be refused, not parsed.
// Without the status check the page's first word becomes the "hash", and the
// failure then surfaces as a checksum mismatch — which reads as a corrupted
// download rather than as a release that was never published properly.
func TestSidecarErrorPageIsNotReadAsContent(t *testing.T) {
	var srv *httptest.Server
	srv = feed(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, "<html>Not Found</html>")
			return
		}
		serve([]ghRelease{release(srv, "v0.9.0")}, nil)(w, r)
	})

	_, err := New("0.1.0").Check(context.Background())
	if err == nil {
		t.Fatal("accepted a 404 sidecar")
	}
	if strings.Contains(err.Error(), "SHA-256") {
		t.Errorf("reported a malformed hash rather than a failed fetch: %v", err)
	}
}

func TestMalformedSidecarsAreRejected(t *testing.T) {
	tests := []struct {
		name    string
		hash    string
		sig     string
		wantErr string
	}{
		{"hash too short", "abc123", testSig, "not a SHA-256"},
		{"hash not hex", strings.Repeat("z", 64), testSig, "not a SHA-256"},
		{"hash empty", "", testSig, "is empty"},
		{"signature not base64", testHash, "not!base64!", "not valid base64"},
		{"signature empty", testHash, "", "is empty"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			name := assetName("0.9.0")
			var srv *httptest.Server
			srv = feed(t, func(w http.ResponseWriter, r *http.Request) {
				serve([]ghRelease{release(srv, "v0.9.0")}, map[string]string{
					name + ".sha256": tt.hash,
					name + ".sig":    tt.sig,
				})(w, r)
			})

			_, err := New("0.1.0").Check(context.Background())
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("err = %v, want one mentioning %q", err, tt.wantErr)
			}
		})
	}
}

// A `shasum`-shaped sidecar is "<hash>  <filename>"; only the first token is the
// hash.
func TestSidecarTakesTheFirstTokenOnly(t *testing.T) {
	name := assetName("0.9.0")
	var srv *httptest.Server
	srv = feed(t, func(w http.ResponseWriter, r *http.Request) {
		serve([]ghRelease{release(srv, "v0.9.0")}, map[string]string{
			name + ".sha256": testHash + "  " + name + "\n",
		})(w, r)
	})

	rel, err := New("0.1.0").Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if rel.FileHash != testHash {
		t.Errorf("hash = %q, want %q", rel.FileHash, testHash)
	}
}

// Installing the wrong architecture produces a bundle that will not launch and
// gives no clue why, so the extension alone is not enough to match on.
func TestAssetSelectionMatchesTheWholePlatformToken(t *testing.T) {
	token, ext := platformToken()
	if token == "" {
		t.Skipf("no artifact shape defined for %s/%s", runtime.GOOS, runtime.GOARCH)
	}

	other := "-macos-ppc64-"
	if strings.Contains(token, "ppc64") {
		other = "-macos-riscv-"
	}

	assets := []ghAsset{
		{Name: "yv" + other + "0.9.0" + ext},
		{Name: "yv" + token + "0.9.0" + ext},
	}
	got := pickAsset(assets)
	if got == nil {
		t.Fatal("no asset matched")
	}
	if !strings.Contains(got.Name, token) {
		t.Errorf("matched %q, which is not for %s/%s", got.Name, runtime.GOOS, runtime.GOARCH)
	}
}

// The .deb and the tarball cannot replace themselves, so a Linux build must
// match only the AppImage. Offering a download that cannot be applied is worse
// than reporting there is none.
func TestLinuxMatchesOnlyTheAppImage(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux only")
	}
	assets := []ghAsset{
		{Name: "yv_0.9.0_amd64.deb"},
		{Name: "yv-linux-amd64-0.9.0.tar.gz"},
	}
	if got := pickAsset(assets); got != nil {
		t.Errorf("matched %q, which cannot be self-installed", got.Name)
	}
}

// The artifact naming lives in two places that cannot see each other: the
// packaging steps in .github/workflows/build.yml (plus
// build/linux/package-appimage.sh) produce these names, and platformToken picks
// them. Nothing else connects them, so drift on either side means a release that
// builds and publishes perfectly and offers no update to anyone.
//
// These literals are the names CI actually uploads, written out rather than
// derived — a test that builds the name from platformToken and then matches it
// with platformToken proves only that the function is self-consistent.
func TestAssetNamesMatchWhatCIUploads(t *testing.T) {
	published := []string{
		"yv-macos-arm64-v0.1.0.dmg",
		"yv-windows-amd64-v0.1.0.zip",
		"yv-linux-x86_64-v0.1.0.AppImage",
		"yv-linux-aarch64-v0.1.0.AppImage",
		// Also uploaded, and deliberately never matched: neither can replace
		// itself in place.
		"yv_0.1.0_amd64.deb",
		"yv-linux-amd64-v0.1.0.tar.gz",
		"yv-windows-amd64-v0.1.0.exe",
	}

	wantFor := map[string]string{
		"darwin/arm64":  "yv-macos-arm64-v0.1.0.dmg",
		"windows/amd64": "yv-windows-amd64-v0.1.0.zip",
		"linux/amd64":   "yv-linux-x86_64-v0.1.0.AppImage",
		"linux/arm64":   "yv-linux-aarch64-v0.1.0.AppImage",
	}

	key := runtime.GOOS + "/" + runtime.GOARCH
	want, covered := wantFor[key]
	if !covered {
		t.Skipf("no artifact published for %s", key)
	}

	var assets []ghAsset
	for _, name := range published {
		assets = append(assets, ghAsset{Name: name})
	}

	got := pickAsset(assets)
	if got == nil {
		t.Fatalf("no asset matched for %s — CI publishes %v", key, published)
	}
	if got.Name != want {
		t.Errorf("picked %q for %s, want %q", got.Name, key, want)
	}
}

func TestIsRealVersion(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"0.1.0", true},
		{"v0.1.0", true},
		{"1.0.0-rc.1", true},
		{"dev", false},
		{"", false},
		{"1.0", false},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := !New(tt.in).IsDevBuild(); got != tt.want {
				t.Errorf("IsDevBuild(%q): real = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}
