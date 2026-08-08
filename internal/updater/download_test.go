package updater

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"yv/internal/updatesign"
)

// isolateHome points the update directory at a temp dir, following the helper
// pattern in internal/settings: XDG_CONFIG_HOME is cleared too, because GitHub
// runners set it and a HOME-only override would still land in the real
// ~/.config/yv.
func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("AppData", home) // os.UserConfigDir on Windows
	return home
}

// artifact bundles some bytes with the release describing them, signed by a key
// the package is made to trust for the duration of the test.
type artifact struct {
	body []byte
	rel  *Release
}

func signedArtifact(t *testing.T, srv *httptest.Server, body []byte) artifact {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	withTrustedKey(t, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})))

	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	sig, err := updatesign.Sign(key, hash)
	if err != nil {
		t.Fatal(err)
	}

	return artifact{
		body: body,
		rel: &Release{
			Version:     "9.9.9",
			AssetName:   "yv-update-9.9.9.bin",
			DownloadURL: srv.URL + "/artifact",
			AssetSize:   int64(len(body)),
			FileHash:    hash,
			Signature:   sig,
		},
	}
}

func serveBytes(t *testing.T, body *[]byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(*body)))
		_, _ = w.Write(*body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestDownloadVerifiesAndLands(t *testing.T) {
	isolateHome(t)

	body := []byte(strings.Repeat("release bytes ", 5000))
	served := body
	srv := serveBytes(t, &served)
	a := signedArtifact(t, srv, body)

	var last Progress
	path, err := New("0.1.0").Download(context.Background(), a.rel, func(p Progress) { last = p })
	if err != nil {
		t.Fatalf("Download: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if string(got) != string(body) {
		t.Error("downloaded bytes differ from what was served")
	}
	if filepath.Base(path) != a.rel.AssetName {
		t.Errorf("landed at %q, want the asset name", filepath.Base(path))
	}
	// The final report fires on EOF, so the bar reaches its end rather than
	// stopping a chunk short.
	if last.Downloaded != int64(len(body)) {
		t.Errorf("final progress = %d, want %d", last.Downloaded, len(body))
	}
	if last.Total != int64(len(body)) {
		t.Errorf("progress total = %d, want %d", last.Total, len(body))
	}
}

// Every rejection has to leave nothing behind. A rejected artifact sitting in the
// update directory is one an "install the pending download" path could later
// pick up.
func TestRejectedDownloadsLeaveNothingOnDisk(t *testing.T) {
	tests := []struct {
		name    string
		corrupt func(t *testing.T, a *artifact, served *[]byte)
		wantErr error
	}{
		{
			name: "bytes do not match the checksum",
			corrupt: func(_ *testing.T, _ *artifact, served *[]byte) {
				*served = append([]byte("tampered"), (*served)[8:]...)
			},
			wantErr: ErrChecksumMismatch,
		},
		{
			name: "signature is from another key",
			corrupt: func(t *testing.T, a *artifact, _ *[]byte) {
				other, err := rsa.GenerateKey(rand.Reader, 2048)
				if err != nil {
					t.Fatal(err)
				}
				sig, err := updatesign.Sign(other, a.rel.FileHash)
				if err != nil {
					t.Fatal(err)
				}
				a.rel.Signature = sig
			},
			wantErr: updatesign.ErrBadSignature,
		},
		{
			name:    "release published no signature",
			corrupt: func(_ *testing.T, a *artifact, _ *[]byte) { a.rel.Signature = "" },
			wantErr: ErrUnsigned,
		},
		{
			name:    "release published no checksum",
			corrupt: func(_ *testing.T, a *artifact, _ *[]byte) { a.rel.FileHash = "" },
			wantErr: ErrUnsigned,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isolateHome(t)

			body := []byte("a release worth verifying")
			served := body
			srv := serveBytes(t, &served)
			a := signedArtifact(t, srv, body)
			tt.corrupt(t, &a, &served)

			_, err := New("0.1.0").Download(context.Background(), a.rel, nil)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}

			dir, err := UpdateDir()
			if err != nil {
				t.Fatal(err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				var names []string
				for _, e := range entries {
					names = append(names, e.Name())
				}
				t.Errorf("left %v behind after a rejected download", names)
			}
		})
	}
}

// The size is published separately from the hash, so a mismatch means the two
// sidecars describe different builds. Nothing should proceed on a release that
// inconsistent, even though the bytes themselves hashed correctly.
func TestSizeDisagreeingWithTheHashIsRefused(t *testing.T) {
	isolateHome(t)

	body := []byte("consistent bytes")
	served := body
	srv := serveBytes(t, &served)
	a := signedArtifact(t, srv, body)
	a.rel.AssetSize = int64(len(body)) + 100

	_, err := New("0.1.0").Download(context.Background(), a.rel, nil)
	if err == nil || !strings.Contains(err.Error(), "the release lists") {
		t.Errorf("err = %v, want a size mismatch", err)
	}
}

// A build with no key refuses the artifact whatever it contains, so it must say
// so before spending someone's bandwidth on finding that out.
func TestNoTrustedKeyRefusesBeforeDownloading(t *testing.T) {
	isolateHome(t)

	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
	}))
	t.Cleanup(srv.Close)

	withTrustedKey(t, "")
	rel := &Release{
		AssetName:   "yv-update.bin",
		DownloadURL: srv.URL,
		FileHash:    strings.Repeat("a", 64),
		Signature:   "c2ln",
	}

	if _, err := New("0.1.0").Download(context.Background(), rel, nil); !errors.Is(err, ErrNoTrustedKey) {
		t.Errorf("err = %v, want ErrNoTrustedKey", err)
	}
	if hits != 0 {
		t.Errorf("made %d request(s) despite having no key", hits)
	}
}

func TestDownloadHonoursCancellation(t *testing.T) {
	isolateHome(t)

	// Trickles, so the cancellation lands mid-transfer rather than racing the
	// whole body.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000000")
		for i := 0; i < 1000; i++ {
			if _, err := w.Write(make([]byte, 1000)); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			time.Sleep(2 * time.Millisecond)
		}
	}))
	t.Cleanup(srv.Close)

	body := []byte("unused")
	a := signedArtifact(t, srv, body)
	a.rel.DownloadURL = srv.URL
	a.rel.AssetSize = 1000000

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()

	if _, err := New("0.1.0").Download(ctx, a.rel, nil); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}

	dir, _ := UpdateDir()
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("a cancelled download left %d file(s) behind", len(entries))
	}
}

// A stale .part from a process that died mid-write must not be resumed: the
// prefix was never verified, and trusting it reintroduces exactly the
// uncertainty the checksum exists to remove.
func TestStalePartialIsDiscardedNotResumed(t *testing.T) {
	isolateHome(t)

	body := []byte("the real release")
	served := body
	srv := serveBytes(t, &served)
	a := signedArtifact(t, srv, body)

	dir, err := UpdateDir()
	if err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, a.rel.AssetName+".part")
	if err := os.WriteFile(stale, []byte("leftover garbage from a crash"), 0o644); err != nil {
		t.Fatal(err)
	}

	path, err := New("0.1.0").Download(context.Background(), a.rel, nil)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(body) {
		t.Errorf("downloaded file = %q, want the freshly fetched body", got)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("the .part file survived a successful download")
	}
}

// The asset name comes from the release feed and is joined to a path we write
// to. Nothing that escapes the update directory may get that far.
func TestSafeAssetName(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"ordinary", "yv-macos-arm64-v0.1.0.dmg", "yv-macos-arm64-v0.1.0.dmg", false},
		{"spaces are fine", "yv 0.1.0.dmg", "yv 0.1.0.dmg", false},
		{"unix traversal", "../../../.bashrc", ".bashrc", false},
		{"absolute unix path", "/etc/passwd", "passwd", false},
		{"windows separators", `..\..\system32\evil.dll`, "", true},
		{"empty", "", "", true},
		{"just a dot", ".", "", true},
		{"just dots", "..", "", true},
		{"just a slash", "/", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := safeAssetName(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("safeAssetName(%q) = %q, want an error", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("safeAssetName(%q): %v", tt.in, err)
			}
			if got != tt.want {
				t.Errorf("safeAssetName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// The property behind the table: whatever the feed says, the result lands inside
// the update directory.
func TestDownloadsStayInsideTheUpdateDirectory(t *testing.T) {
	isolateHome(t)

	dir, err := UpdateDir()
	if err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{
		"normal.dmg", "../escape.dmg", "../../../../etc/passwd",
		"/absolute.dmg", "./nested/../thing.zip",
	} {
		base, err := safeAssetName(name)
		if err != nil {
			continue // refused outright, which is also inside the directory
		}
		full := filepath.Join(dir, base)
		if filepath.Dir(full) != filepath.Clean(dir) {
			t.Errorf("asset %q resolved to %q, outside %q", name, full, dir)
		}
	}
}

func TestUpdateDirIsUnderTheAppConfigDir(t *testing.T) {
	isolateHome(t)

	dir, err := UpdateDir()
	if err != nil {
		t.Fatalf("UpdateDir: %v", err)
	}
	if filepath.Base(dir) != "updates" || filepath.Base(filepath.Dir(dir)) != "yv" {
		t.Errorf("UpdateDir = %q, want …/yv/updates", dir)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		t.Errorf("UpdateDir did not create the directory: %v", err)
	}
}
