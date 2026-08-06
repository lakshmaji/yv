package runner

import (
	"os/exec"
	"strings"
	"sync"
	"testing"

	"os"
	"path/filepath"
	"yv/internal/models"
)

// injectProcess adds a fake process entry for testing state queries.
func (r *Runner) injectProcess(id string, cmd *exec.Cmd) {
	r.processesMu.Lock()
	r.processes[id] = cmd
	r.processesMu.Unlock()
}

func (r *Runner) injectMeta(id string, meta models.CmdMeta) {
	r.cmdMetaMu.Lock()
	r.cmdMeta[id] = meta
	r.cmdMetaMu.Unlock()
}

func (r *Runner) metaLen() int {
	r.cmdMetaMu.RLock()
	defer r.cmdMetaMu.RUnlock()
	return len(r.cmdMeta)
}

func TestGetRunningCommandsExcludesPost(t *testing.T) {
	cases := []struct {
		name    string
		inject  []string
		wantIDs []string
	}{
		{
			name:    "no processes",
			inject:  nil,
			wantIDs: []string{},
		},
		{
			name:    "regular only",
			inject:  []string{"cmd-1", "cmd-2"},
			wantIDs: []string{"cmd-1", "cmd-2"},
		},
		{
			name:    "post suffix excluded",
			inject:  []string{"cmd-1", "cmd-1:post"},
			wantIDs: []string{"cmd-1"},
		},
		{
			name:    "all post excluded",
			inject:  []string{"cmd-1:post", "cmd-2:post"},
			wantIDs: []string{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRunner()
			// inject fake exec.Cmd stubs (Process nil is fine — we only check map keys)
			for _, id := range tc.inject {
				r.injectProcess(id, &exec.Cmd{})
			}
			got := r.GetRunningCommands()
			if len(got) != len(tc.wantIDs) {
				t.Fatalf("got %v, want %v", got, tc.wantIDs)
			}
			gotSet := make(map[string]bool, len(got))
			for _, id := range got {
				gotSet[id] = true
			}
			for _, id := range tc.wantIDs {
				if !gotSet[id] {
					t.Errorf("missing expected id %q in result %v", id, got)
				}
			}
		})
	}
}

func TestStopCommandNotRunning(t *testing.T) {
	cases := []struct {
		name  string
		cmdID string
		want  string
	}{
		{"unknown id", "does-not-exist", "not running"},
		{"empty id", "", "not running"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRunner()
			if got := r.StopCommand(tc.cmdID); got != tc.want {
				t.Errorf("StopCommand(%q) = %q, want %q", tc.cmdID, got, tc.want)
			}
		})
	}
}

func TestSendInputNotRunning(t *testing.T) {
	cases := []struct {
		name  string
		cmdID string
		text  string
		want  string
	}{
		{"unknown id", "does-not-exist", "hello", "not running"},
		{"empty id", "", "data", "not running"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRunner()
			if got := r.SendInput(tc.cmdID, tc.text); got != tc.want {
				t.Errorf("SendInput(%q, %q) = %q, want %q", tc.cmdID, tc.text, got, tc.want)
			}
		})
	}
}

func TestGetProcessSnapshotFiltersPostAndMapsMeta(t *testing.T) {
	r := NewRunner()

	// Start a real background process so cmd.Process != nil.
	realCmd := exec.Command("sleep", "60")
	if err := realCmd.Start(); err != nil {
		t.Skip("cannot start sleep process: " + err.Error())
	}
	defer realCmd.Process.Kill() //nolint:errcheck

	r.injectProcess("cmd-1", realCmd)
	r.injectProcess("cmd-1:post", &exec.Cmd{}) // nil Process, :post suffix
	r.injectMeta("cmd-1", models.CmdMeta{Label: "My Command", ProjectID: "proj-1", Group: "Android"})

	snapshot := r.GetProcessSnapshot()

	// Only cmd-1 should appear (cmd-1:post filtered out; &exec.Cmd{} has nil Process)
	if len(snapshot) != 1 {
		t.Fatalf("snapshot len = %d, want 1; got %+v", len(snapshot), snapshot)
	}
	got := snapshot[0]
	if got.CmdID != "cmd-1" {
		t.Errorf("CmdID = %q, want %q", got.CmdID, "cmd-1")
	}
	if got.Label != "My Command" {
		t.Errorf("Label = %q, want %q", got.Label, "My Command")
	}
	if got.ProjectID != "proj-1" {
		t.Errorf("ProjectID = %q, want %q — metrics group by this", got.ProjectID, "proj-1")
	}
	if got.Group != "Android" {
		t.Errorf("Group = %q, want %q", got.Group, "Android")
	}
}

func TestGetProcessSnapshotPrunesDeadMeta(t *testing.T) {
	r := NewRunner()

	realCmd := exec.Command("sleep", "60")
	if err := realCmd.Start(); err != nil {
		t.Skip("cannot start sleep process: " + err.Error())
	}
	defer realCmd.Process.Kill() //nolint:errcheck

	r.injectProcess("live", realCmd)
	r.injectMeta("live", models.CmdMeta{Label: "Live"})
	r.injectMeta("dead", models.CmdMeta{Label: "Dead"})
	r.injectMeta("dead:post", models.CmdMeta{Label: "Dead post-hook"})

	r.GetProcessSnapshot()

	if n := r.metaLen(); n != 1 {
		t.Errorf("cmdMeta len = %d, want 1 — entries for exited commands must be pruned", n)
	}

	// The live command's metadata must survive, or its samples lose attribution.
	snapshot := r.GetProcessSnapshot()
	if len(snapshot) != 1 || snapshot[0].Label != "Live" {
		t.Errorf("live metadata was pruned: %+v", snapshot)
	}
}

// fakeSink captures run records for assertion.
type fakeSink struct {
	mu      sync.Mutex
	records []models.RunRecord
}

func (f *fakeSink) RecordRun(rec models.RunRecord) {
	f.mu.Lock()
	f.records = append(f.records, rec)
	f.mu.Unlock()
}

func (f *fakeSink) all() []models.RunRecord {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]models.RunRecord, len(f.records))
	copy(out, f.records)
	return out
}

func TestRecordRunSink(t *testing.T) {
	cases := []struct {
		name     string
		command  string
		wantOK   bool
		wantCode int
	}{
		{"successful command", "exit 0", true, 0},
		{"failing command", "exit 3", false, 3},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRunner()
			sink := &fakeSink{}
			r.SetRunSink(sink)

			cmd := models.CommandConfig{
				ID:      "cmd-1",
				Label:   "Test Command",
				Command: tc.command,
				Group:   "Android",
			}
			// A nil ctx keeps the runner headless — no Wails events are emitted.
			r.ExecuteCommand(nil, cmd, t.TempDir(), "run-1", nil, "proj-1")
			r.wg.Wait()

			records := sink.all()
			if len(records) != 1 {
				t.Fatalf("got %d records, want 1: %+v", len(records), records)
			}
			rec := records[0]
			if rec.CmdID != "cmd-1" || rec.Label != "Test Command" {
				t.Errorf("identity = %q/%q, want cmd-1/Test Command", rec.CmdID, rec.Label)
			}
			if rec.Project != "proj-1" || rec.Group != "Android" {
				t.Errorf("attribution = %q/%q, want proj-1/Android", rec.Project, rec.Group)
			}
			if rec.RunID != "run-1" {
				t.Errorf("RunID = %q, want run-1", rec.RunID)
			}
			if rec.ExitCode != tc.wantCode || rec.OK != tc.wantOK {
				t.Errorf("exit = %d/ok=%v, want %d/%v", rec.ExitCode, rec.OK, tc.wantCode, tc.wantOK)
			}
			if rec.Stopped {
				t.Error("a command that exited on its own must not be marked stopped")
			}
			if rec.T == 0 {
				t.Error("start time not recorded")
			}
		})
	}
}

func TestNilRunSinkIsSafe(t *testing.T) {
	r := NewRunner()
	// No sink installed — the default state, and what happens with metrics off.
	cmd := models.CommandConfig{ID: "cmd-1", Label: "Test", Command: "exit 0"}
	r.ExecuteCommand(nil, cmd, t.TempDir(), "run-1", nil, "proj-1")
	r.wg.Wait()
}

func TestStoppedFlagRoundTrip(t *testing.T) {
	r := NewRunner()

	if r.takeStopped("cmd-1") {
		t.Error("a command nobody stopped should not be flagged")
	}

	r.markStopped("cmd-1")
	if !r.takeStopped("cmd-1") {
		t.Error("markStopped was not observed")
	}
	if r.takeStopped("cmd-1") {
		t.Error("the flag must be cleared once taken, so the next run is not mislabelled")
	}
}

func TestGetProcessSnapshotWithoutProcess(t *testing.T) {
	// Entries whose cmd.Process == nil should be excluded from the snapshot.
	r := NewRunner()
	r.injectProcess("cmd-nil", &exec.Cmd{}) // Process field is nil on zero-value exec.Cmd

	snapshot := r.GetProcessSnapshot()
	for _, e := range snapshot {
		if e.CmdID == "cmd-nil" {
			t.Error("nil-process entry should not appear in snapshot")
		}
	}
}

func TestStoreCmdMeta(t *testing.T) {
	r := NewRunner()
	want := models.CmdMeta{Label: "Label One", ProjectID: "proj-1", Group: "Android"}
	r.storeCmdMeta("cmd-1", want)

	r.cmdMetaMu.RLock()
	got := r.cmdMeta["cmd-1"]
	r.cmdMetaMu.RUnlock()

	if got != want {
		t.Errorf("meta = %+v, want %+v", got, want)
	}
}

// Ensure ansiRe strips common ANSI sequences.
func TestAnsiRe(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"\x1b[32mhello\x1b[0m", "hello"},
		{"\x1b[1;31merror\x1b[0m", "error"},
		{"plain text", "plain text"},
		{"\x1b[?25l\x1b[?25h", ""},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			got := ansiRe.ReplaceAllString(tc.input, "")
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// Ensure models import is used (compile check via ProcessEntry).
var _ models.ProcessEntry = models.ProcessEntry{}

// Ensure ptmxBufPool returns a 32KB slice.
func TestPtmxBufPool(t *testing.T) {
	buf := ptmxBufPool.Get().([]byte)
	defer ptmxBufPool.Put(buf)
	if len(buf) != 32*1024 {
		t.Errorf("buf len = %d, want %d", len(buf), 32*1024)
	}
}

// Ensure runShellCommand builds correct shell invocations — smoke test via a no-op command.
func TestRunShellCommandSimple(t *testing.T) {
	r := NewRunner()
	var lines []string
	code, err := r.runShellCommand("test-cmd", "echo hello", "/tmp", nil, func(line string) {
		lines = append(lines, line)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "hello") {
		t.Errorf("output %q does not contain 'hello'", joined)
	}
}

// buildEnv must layer environment variables over the process environment while
// keeping the resolved login PATH available to commands.
func TestBuildEnv(t *testing.T) {
	cases := []struct {
		name     string
		vars     []models.EnvVar
		wantKV   map[string]string
		wantPath string // "login" = login PATH, otherwise the exact expected value
	}{
		{
			name:     "no vars keeps login path",
			vars:     nil,
			wantPath: "login",
		},
		{
			name:     "adds variable",
			vars:     []models.EnvVar{{Key: "YV_TEST_TOKEN", Value: "abc"}},
			wantKV:   map[string]string{"YV_TEST_TOKEN": "abc"},
			wantPath: "login",
		},
		{
			name:     "explicit PATH overrides login path",
			vars:     []models.EnvVar{{Key: "PATH", Value: "/only/here"}},
			wantPath: "/only/here",
		},
		{
			name: "multiple variables",
			vars: []models.EnvVar{
				{Key: "A", Value: "1"},
				{Key: "B", Value: ""},
			},
			wantKV:   map[string]string{"A": "1", "B": ""},
			wantPath: "login",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := map[string]string{}
			for _, kv := range buildEnv(tc.vars) {
				if eq := strings.IndexByte(kv, '='); eq > 0 {
					got[kv[:eq]] = kv[eq+1:]
				}
			}
			for k, want := range tc.wantKV {
				if got[k] != want {
					t.Errorf("%s: got %q, want %q", k, got[k], want)
				}
			}
			wantPath := tc.wantPath
			if wantPath == "login" {
				wantPath = resolveLoginPath()
			}
			if got["PATH"] != wantPath {
				t.Errorf("PATH: got %q, want %q", got["PATH"], wantPath)
			}
			// PATH must appear exactly once, or the shell may pick the wrong one.
			count := 0
			for _, kv := range buildEnv(tc.vars) {
				if strings.HasPrefix(kv, "PATH=") {
					count++
				}
			}
			if count != 1 {
				t.Errorf("PATH appears %d times, want 1", count)
			}
		})
	}
}

// Variables passed to a command must actually reach the child shell.
func TestRunShellCommandUsesEnv(t *testing.T) {
	cases := []struct {
		name    string
		vars    []models.EnvVar
		script  string
		wantOut string
	}{
		{
			name:    "variable is visible",
			vars:    []models.EnvVar{{Key: "YV_ENV_TEST", Value: "injected"}},
			script:  "echo $YV_ENV_TEST",
			wantOut: "injected",
		},
		{
			name:    "unset variable is empty",
			vars:    nil,
			script:  "echo \"[$YV_ENV_TEST]\"",
			wantOut: "[]",
		},
		{
			name:    "value with spaces survives",
			vars:    []models.EnvVar{{Key: "YV_ENV_TEST", Value: "a b c"}},
			script:  "echo \"$YV_ENV_TEST\"",
			wantOut: "a b c",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRunner()
			var lines []string
			code, err := r.runShellCommand("env-test", tc.script, "/tmp", buildEnv(tc.vars), func(line string) {
				lines = append(lines, line)
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if code != 0 {
				t.Errorf("exit code = %d, want 0", code)
			}
			if joined := strings.Join(lines, "\n"); !strings.Contains(joined, tc.wantOut) {
				t.Errorf("output %q does not contain %q", joined, tc.wantOut)
			}
		})
	}
}

func TestDefaultShellPrefersEnv(t *testing.T) {
	t.Setenv("SHELL", "/opt/custom/fish")
	if got := defaultShell(); got != "/opt/custom/fish" {
		t.Errorf("defaultShell() = %q, want the value of $SHELL", got)
	}
}

// The fallback matters for a GUI launch: a desktop entry does not necessarily
// export SHELL, and the old hardcoded "zsh" does not exist on a stock Ubuntu.
func TestDefaultShellFallsBackToSomethingReal(t *testing.T) {
	t.Setenv("SHELL", "")

	got := defaultShell()
	if got == "" {
		t.Fatal("defaultShell() returned empty")
	}
	if !filepath.IsAbs(got) {
		t.Errorf("defaultShell() = %q, want an absolute path so exec cannot miss it", got)
	}
	if _, err := os.Stat(got); err != nil {
		t.Errorf("defaultShell() = %q, which does not exist: %v", got, err)
	}
}

// The resolved shell has to actually be able to run a command, on whatever
// platform the test is running on.
func TestDefaultShellCanRunACommand(t *testing.T) {
	t.Setenv("SHELL", "")

	out, err := exec.Command(defaultShell(), "-c", "echo ok").Output()
	if err != nil {
		t.Fatalf("running through %q: %v", defaultShell(), err)
	}
	if strings.TrimSpace(string(out)) != "ok" {
		t.Errorf("got %q, want %q", strings.TrimSpace(string(out)), "ok")
	}
}
