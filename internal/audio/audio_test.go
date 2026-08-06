package audio

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMimeType(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{"mp3", "/clips/roar.mp3", "audio/mpeg"},
		{"wav", "/clips/roar.wav", "audio/wav"},
		{"m4a", "/clips/roar.m4a", "audio/mp4"},
		{"ogg", "/clips/roar.ogg", "audio/ogg"},
		{"flac", "/clips/roar.flac", "audio/flac"},
		{"aac", "/clips/roar.aac", "audio/aac"},
		{"uppercase extension still matches", "/clips/ROAR.MP3", "audio/mpeg"},
		{"unsupported extension", "/clips/roar.aiff", ""},
		{"no extension", "/clips/roar", ""},
		{"not audio at all", "/clips/notes.txt", ""},
		{"empty", "", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := MimeType(tc.path); got != tc.want {
				t.Errorf("MimeType(%q) = %q, want %q", tc.path, got, tc.want)
			}
		})
	}
}

func TestDialogPattern(t *testing.T) {
	got := DialogPattern()
	for _, ext := range SupportedExts() {
		if !strings.Contains(got, "*"+ext) {
			t.Errorf("DialogPattern() = %q, missing %q", got, ext)
		}
	}
	if strings.Contains(got, ",") || strings.Contains(got, " ") {
		t.Errorf("DialogPattern() = %q, want semicolon-separated with no spaces", got)
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()

	good := filepath.Join(dir, "roar.mp3")
	payload := []byte{0xff, 0xfb, 0x90, 0x00, 'r', 'o', 'a', 'r'}
	if err := os.WriteFile(good, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	wrongExt := filepath.Join(dir, "roar.aiff")
	if err := os.WriteFile(wrongExt, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	oversize := filepath.Join(dir, "huge.wav")
	if err := os.WriteFile(oversize, make([]byte, MaxClipBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}

	subdir := filepath.Join(dir, "nested.mp3")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		path    string
		wantErr string // substring; "" means success
	}{
		{"valid mp3", good, ""},
		{"unsupported extension", wrongExt, "unsupported audio file"},
		{"missing file", filepath.Join(dir, "gone.mp3"), "cannot read"},
		{"directory with an audio extension", subdir, "is not a file"},
		{"over the size cap", oversize, "the limit is"},
		{"empty path", "", "no clip path given"},
		{"whitespace path", "   ", "no clip path given"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			url, err := Load(tc.path)

			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("Load(%q) succeeded, want error containing %q", tc.path, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("Load(%q) error = %v, want it to contain %q", tc.path, err, tc.wantErr)
				}
				if url != "" {
					t.Errorf("Load(%q) returned a URL alongside an error: %q", tc.path, url)
				}
				return
			}

			if err != nil {
				t.Fatalf("Load(%q) = %v, want success", tc.path, err)
			}
			const prefix = "data:audio/mpeg;base64,"
			if !strings.HasPrefix(url, prefix) {
				t.Fatalf("Load(%q) = %q, want prefix %q", tc.path, url, prefix)
			}
			// The bytes must survive the round trip — a corrupted clip fails
			// silently in the webview, so verify it here instead.
			decoded, decErr := base64.StdEncoding.DecodeString(strings.TrimPrefix(url, prefix))
			if decErr != nil {
				t.Fatalf("payload is not valid base64: %v", decErr)
			}
			if string(decoded) != string(payload) {
				t.Errorf("decoded payload = %v, want %v", decoded, payload)
			}
		})
	}
}

func TestNormalizePaths(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []string
	}{
		{"nil stays nil", nil, nil},
		{"empty stays nil", []string{}, nil},
		{"keeps insertion order", []string{"/b.mp3", "/a.wav"}, []string{"/b.mp3", "/a.wav"}},
		{"drops duplicates, keeps the first", []string{"/a.mp3", "/b.mp3", "/a.mp3"}, []string{"/a.mp3", "/b.mp3"}},
		{"drops unsupported", []string{"/a.mp3", "/notes.txt"}, []string{"/a.mp3"}},
		{"drops blanks", []string{"", "  ", "/a.mp3"}, []string{"/a.mp3"}},
		{"trims surrounding space", []string{"  /a.mp3  "}, []string{"/a.mp3"}},
		{"all invalid collapses to nil", []string{"/notes.txt", ""}, nil},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizePaths(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("NormalizePaths(%v) = %v, want %v", tc.in, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("NormalizePaths(%v) = %v, want %v", tc.in, got, tc.want)
				}
			}
		})
	}
}

func TestValidatePaths(t *testing.T) {
	tests := []struct {
		name    string
		in      []string
		wantErr string
	}{
		{"nil is fine", nil, ""},
		{"all supported", []string{"/a.mp3", "/b.wav"}, ""},
		{"blanks are ignored, not rejected", []string{"", "  "}, ""},
		{"unsupported is named", []string{"/a.mp3", "/dir/notes.txt"}, "notes.txt"},
		{"several unsupported", []string{"/x.aiff", "/y.mid"}, "x.aiff, y.mid"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePaths(tc.in)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("ValidatePaths(%v) = %v, want nil", tc.in, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("ValidatePaths(%v) = nil, want error containing %q", tc.in, tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("ValidatePaths(%v) = %v, want it to contain %q", tc.in, err, tc.wantErr)
			}
		})
	}
}
