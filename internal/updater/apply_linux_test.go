package updater

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The install shape decides everything on Linux, and getting it wrong in the
// permissive direction means offering a download that cannot be applied.
func TestClassifyLinuxInstall(t *testing.T) {
	alwaysWritable := func(string) bool { return true }
	neverWritable := func(string) bool { return false }

	tests := []struct {
		name     string
		appImage string
		writable func(string) bool
		wantOK   bool
		wantSays string
	}{
		{
			name:     "AppImage in a directory the user owns",
			appImage: "/home/x/Applications/yv.AppImage",
			writable: alwaysWritable,
			wantOK:   true,
		},
		{
			// The .deb and the tarball both land here: neither sets APPIMAGE.
			// The message has to point at the package manager, because a
			// download button would be a lie.
			name:     "installed from a package",
			appImage: "",
			writable: alwaysWritable,
			wantSays: "package manager",
		},
		{
			name:     "AppImage somewhere an administrator put it",
			appImage: "/opt/yv/yv.AppImage",
			writable: neverWritable,
			wantSays: "cannot write to /opt/yv",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyLinuxInstall(tt.appImage, tt.writable)
			if got.CanSelfUpdate != tt.wantOK {
				t.Fatalf("CanSelfUpdate = %v, want %v (reason %q)", got.CanSelfUpdate, tt.wantOK, got.Reason)
			}
			if tt.wantOK {
				return
			}
			if !strings.Contains(got.Reason, tt.wantSays) {
				t.Errorf("reason = %q, want one containing %q", got.Reason, tt.wantSays)
			}
		})
	}
}

// APPIMAGE's presence is the entire test for "is this an AppImage", so the
// values it will not accept matter as much as the one it will.
func TestAppImagePath(t *testing.T) {
	real := filepath.Join(t.TempDir(), "yv.AppImage")
	if err := os.WriteFile(real, []byte("ELF"), 0o755); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()

	tests := []struct {
		name string
		env  string
		want string
	}{
		{"a real AppImage", real, real},
		{"unset — a .deb or tarball install", "", ""},
		// Relative would be resolved against whatever directory the app happens
		// to be running in, which is not where the image is.
		{"relative path", "yv.AppImage", ""},
		{"points at a directory", dir, ""},
		{"points at nothing", filepath.Join(dir, "absent.AppImage"), ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("APPIMAGE", tt.env)
			if got := appImagePath(); got != tt.want {
				t.Errorf("appImagePath() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestReplaceAppImage(t *testing.T) {
	dir := t.TempDir()
	current := filepath.Join(dir, "yv.AppImage")
	if err := os.WriteFile(current, []byte("the old version"), 0o755); err != nil {
		t.Fatal(err)
	}

	artifact := filepath.Join(t.TempDir(), "downloaded.AppImage")
	// Downloads land 0644; the installed image has to end up executable
	// regardless, or it stops being an application.
	if err := os.WriteFile(artifact, []byte("the new version"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := replaceAppImage(current, artifact); err != nil {
		t.Fatalf("replaceAppImage: %v", err)
	}

	got, err := os.ReadFile(current)
	if err != nil {
		t.Fatalf("read the installed image: %v", err)
	}
	if string(got) != "the new version" {
		t.Errorf("installed image = %q, want the new version", got)
	}

	info, err := os.Stat(current)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("installed image is not executable (mode %v)", info.Mode().Perm())
	}
	if _, err := os.Stat(current + ".new"); !os.IsNotExist(err) {
		t.Error("the staged .new file survived a successful replacement")
	}
}

// A failure must leave the working version in place. The user still has an app.
func TestReplaceAppImageLeavesTheOldVersionOnFailure(t *testing.T) {
	dir := t.TempDir()
	current := filepath.Join(dir, "yv.AppImage")
	if err := os.WriteFile(current, []byte("the old version"), 0o755); err != nil {
		t.Fatal(err)
	}

	err := replaceAppImage(current, filepath.Join(t.TempDir(), "never-downloaded"))
	if err == nil {
		t.Fatal("replaceAppImage succeeded with no artifact")
	}

	got, readErr := os.ReadFile(current)
	if readErr != nil {
		t.Fatalf("the running version is gone: %v", readErr)
	}
	if string(got) != "the old version" {
		t.Errorf("current image = %q, want the old version untouched", got)
	}
	if _, err := os.Stat(current + ".new"); !os.IsNotExist(err) {
		t.Error("a failed replacement left a .new file behind")
	}
}

// The staged file goes beside the current image, not in the update directory.
// $XDG_CONFIG_HOME is often on a different device from where an AppImage lives,
// and a cross-device rename fails rather than silently copying.
func TestReplacementIsStagedBesideTheCurrentImage(t *testing.T) {
	dir := t.TempDir()
	current := filepath.Join(dir, "yv.AppImage")
	if err := os.WriteFile(current, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	artifact := filepath.Join(t.TempDir(), "new.AppImage")
	if err := os.WriteFile(artifact, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := replaceAppImage(current, artifact); err != nil {
		t.Fatalf("replaceAppImage: %v", err)
	}
	// Proven by the rename having worked at all: had it been staged elsewhere on
	// a different device, this test would fail on any machine with /tmp on
	// tmpfs and the temp dir elsewhere. Asserted directly for the machines where
	// it would not.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "yv.AppImage" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("directory holds %v, want only yv.AppImage", names)
	}
}

func TestSweepStaleRemovesAPartialReplacement(t *testing.T) {
	isolateHome(t)

	dir := t.TempDir()
	current := filepath.Join(dir, "yv.AppImage")
	if err := os.WriteFile(current, []byte("running"), 0o755); err != nil {
		t.Fatal(err)
	}
	leftover := current + ".new"
	if err := os.WriteFile(leftover, []byte("half-written"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APPIMAGE", current)

	New("0.1.0").SweepStale()

	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Error("SweepStale left a partial replacement behind")
	}
	if _, err := os.Stat(current); err != nil {
		t.Errorf("SweepStale removed the running image: %v", err)
	}
}
