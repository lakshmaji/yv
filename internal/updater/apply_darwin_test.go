package updater

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The mount point is parsed from hdiutil's output, and getting it wrong means
// copying a bundle out of the wrong volume.
func TestParseAttachOutput(t *testing.T) {
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>system-entities</key>
	<array>
		<dict>
			<key>content-hint</key>
			<string>GUID_partition_scheme</string>
		</dict>
		<dict>
			<key>mount-point</key>
			<string>/Volumes/yv</string>
		</dict>
	</array>
</dict>
</plist>`

	tests := []struct {
		name string
		out  string
		want string
	}{
		{"plist", plist, "/Volumes/yv"},
		{
			// The columns are tab-separated and a volume name may contain
			// spaces. Splitting on whitespace truncates this to "/Volumes/yv",
			// which is a path that very likely exists and is a different volume.
			name: "plain output with a space in the mount point",
			out:  "/dev/disk4          \tGUID_partition_scheme\t\n/dev/disk4s1        \tApple_HFS            \t/Volumes/yv 1\n",
			want: "/Volumes/yv 1",
		},
		{
			name: "plain output, ordinary name",
			out:  "/dev/disk4s1\tApple_HFS\t/Volumes/yv\n",
			want: "/Volumes/yv",
		},
		{"nothing mounted", "/dev/disk4\tGUID_partition_scheme\t\n", ""},
		{"empty", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseAttachOutput([]byte(tt.out)); got != tt.want {
				t.Errorf("parseAttachOutput = %q, want %q", got, tt.want)
			}
		})
	}
}

// A path is about to be interpolated into an AppleScript literal that runs as
// root. Anything that could close the literal early has to be escaped.
func TestAsStringEscapesAppleScriptLiterals(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"ordinary", "/Applications/yv.app", `"/Applications/yv.app"`},
		{"space", "/Users/a b/yv.app", `"/Users/a b/yv.app"`},
		{"quote", `/tmp/ev"il.app`, `"/tmp/ev\"il.app"`},
		{"backslash", `/tmp/ev\il.app`, `"/tmp/ev\\il.app"`},
		{
			name: "an attempt to close the literal and append a command",
			in:   `/tmp/x" & (do shell script "rm -rf /") & "`,
			want: `"/tmp/x\" & (do shell script \"rm -rf /\") & \""`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := asString(tt.in)
			if got != tt.want {
				t.Errorf("asString(%q) = %s, want %s", tt.in, got, tt.want)
			}
			// The property behind the table: after the opening quote, every
			// quote in the result is preceded by a backslash, so the literal
			// cannot end early.
			body := got[1 : len(got)-1]
			for i, r := range body {
				if r == '"' && (i == 0 || body[i-1] != '\\') {
					t.Errorf("asString(%q) = %s has an unescaped quote", tt.in, got)
				}
			}
		})
	}
}

func TestShQuote(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"ordinary", "/Applications/yv.app", `'/Applications/yv.app'`},
		{"space", "/Users/a b/yv.app", `'/Users/a b/yv.app'`},
		{"double quote is literal inside single quotes", `/tmp/a"b`, `'/tmp/a"b'`},
		{"dollar is literal inside single quotes", "/tmp/$HOME", `'/tmp/$HOME'`},
		{"single quote is closed and reopened", "/tmp/it's", `'/tmp/it'\''s'`},
		{
			name: "an attempt to end the quoting and append a command",
			in:   `/tmp/x'; rm -rf /; echo '`,
			want: `'/tmp/x'\''; rm -rf /; echo '\'''`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shQuote(tt.in); got != tt.want {
				t.Errorf("shQuote(%q) = %s, want %s", tt.in, got, tt.want)
			}
		})
	}
}

// Every destructive sweep is scoped by this. A user's own mounted disk image, or
// their own directory that happens to be named like ours, is not ours to delete.
func TestIsWithin(t *testing.T) {
	tests := []struct {
		name string
		root string
		path string
		want bool
	}{
		{"direct child", "/a/b", "/a/b/c", true},
		{"deep child", "/a/b", "/a/b/c/d/e", true},
		{"the root itself", "/a/b", "/a/b", true},
		{"parent", "/a/b", "/a", false},
		{"sibling", "/a/b", "/a/c", false},
		{"a prefix that is not a parent", "/a/b", "/a/bc", false},
		{"traversal back out", "/a/b", "/a/b/../../etc", false},
		{"unrelated", "/a/b", "/etc/passwd", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isWithin(tt.root, tt.path); got != tt.want {
				t.Errorf("isWithin(%q, %q) = %v, want %v", tt.root, tt.path, got, tt.want)
			}
		})
	}
}

// The test binary is not a bundle, so bundlePath must say so rather than
// returning three directories up from wherever `go test` put it — which is a
// real path, and one an update would then try to delete.
func TestBundlePathRejectsANonBundle(t *testing.T) {
	if got := bundlePath(); got != "" {
		t.Errorf("bundlePath() = %q for a test binary, want \"\"", got)
	}
}

func TestInstallCheckRefusesANonBundle(t *testing.T) {
	state := New("0.1.0").InstallCheck()
	if state.CanSelfUpdate {
		t.Error("a test binary reported that it can replace itself")
	}
	if state.Reason == "" {
		t.Error("refused without saying why")
	}
}

// The refusals a user actually meets. Each needs its own message, because
// "macOS made a read-only copy" and "you are running from the disk image" are
// different situations with different fixes, and neither is discoverable from a
// generic failure.
func TestClassifyBundle(t *testing.T) {
	tests := []struct {
		name     string
		app      string
		writable bool
		wantOK   bool
		wantSays string
	}{
		{
			name:     "installed in Applications",
			app:      "/Applications/yv.app",
			writable: true,
			wantOK:   true,
		},
		{
			name:     "not a bundle at all",
			app:      "",
			writable: true,
			wantSays: "not an app bundle",
		},
		{
			name:     "translocated by Gatekeeper",
			app:      "/private/var/folders/xy/AppTranslocation/ABC123/d/yv.app",
			writable: true,
			wantSays: "Move yv into Applications",
		},
		{
			// Checked before writability on purpose: a mounted image can be
			// writable, and "cannot write there" would be both wrong and
			// useless advice.
			name:     "running from the mounted disk image",
			app:      "/Volumes/yv/yv.app",
			writable: true,
			wantSays: "Drag yv into Applications",
		},
		{
			name:     "installed somewhere unwritable",
			app:      "/Applications/yv.app",
			writable: false,
			wantSays: "cannot write to /Applications",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyBundle(tt.app, tt.writable)
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

func TestFindBundle(t *testing.T) {
	t.Run("finds the app", func(t *testing.T) {
		mount := t.TempDir()
		if err := os.MkdirAll(filepath.Join(mount, "yv.app", "Contents"), 0o755); err != nil {
			t.Fatal(err)
		}
		// Disk images carry an Applications symlink for the drag-to-install
		// gesture; it must not be mistaken for the app.
		_ = os.Symlink("/Applications", filepath.Join(mount, "Applications"))

		got, err := findBundle(mount)
		if err != nil {
			t.Fatalf("findBundle: %v", err)
		}
		if filepath.Base(got) != "yv.app" {
			t.Errorf("findBundle = %q, want yv.app", got)
		}
	})

	t.Run("reports an image with no app", func(t *testing.T) {
		if _, err := findBundle(t.TempDir()); err == nil {
			t.Error("accepted a disk image containing no application")
		}
	})
}

// The swap must never end with no application present. If the new bundle cannot
// be moved into place, the old one goes back.
func TestSwapBundleRestoresTheOldVersionOnFailure(t *testing.T) {
	dir := t.TempDir()
	current := filepath.Join(dir, "yv.app")
	if err := os.MkdirAll(filepath.Join(current, "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(current, "Contents", "old")
	if err := os.WriteFile(marker, []byte("the working version"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A staged path that does not exist, so the second rename fails.
	err := swapBundle(current, filepath.Join(dir, stagingName, "yv.app"))
	if err == nil {
		t.Fatal("swapBundle succeeded with nothing staged")
	}

	if _, statErr := os.Stat(marker); statErr != nil {
		t.Errorf("the old bundle was not restored: %v", statErr)
	}
}

func TestSwapBundleReplacesAndClearsTheBackup(t *testing.T) {
	dir := t.TempDir()
	current := filepath.Join(dir, "yv.app")
	staging := filepath.Join(dir, stagingName)
	staged := filepath.Join(staging, "yv.app")

	for _, p := range []string{current, staged} {
		if err := os.MkdirAll(filepath.Join(p, "Contents"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(current, "Contents", "which"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staged, "Contents", "which"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := swapBundle(current, staged); err != nil {
		t.Fatalf("swapBundle: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(current, "Contents", "which"))
	if err != nil {
		t.Fatalf("read installed bundle: %v", err)
	}
	if string(got) != "new" {
		t.Errorf("installed bundle says %q, want \"new\"", got)
	}
	if _, err := os.Stat(current + ".old"); !os.IsNotExist(err) {
		t.Error("the backup bundle was left behind")
	}
}

func TestWritableDir(t *testing.T) {
	if !writableDir(t.TempDir()) {
		t.Error("a temp dir reported as unwritable")
	}
	if writableDir(filepath.Join(t.TempDir(), "does-not-exist")) {
		t.Error("a missing directory reported as writable")
	}
}
