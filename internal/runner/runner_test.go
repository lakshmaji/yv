package runner

import (
	"os/exec"
	"strings"
	"testing"

	"nicosia/internal/models"
)

// injectProcess adds a fake process entry for testing state queries.
func (r *Runner) injectProcess(id string, cmd *exec.Cmd) {
	r.processesMu.Lock()
	r.processes[id] = cmd
	r.processesMu.Unlock()
}

func (r *Runner) injectLabel(id, label string) {
	r.cmdLabelsMu.Lock()
	r.cmdLabels[id] = label
	r.cmdLabelsMu.Unlock()
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

func TestGetProcessSnapshotFiltersPostAndMapsLabels(t *testing.T) {
	r := NewRunner()

	// Start a real background process so cmd.Process != nil.
	realCmd := exec.Command("sleep", "60")
	if err := realCmd.Start(); err != nil {
		t.Skip("cannot start sleep process: " + err.Error())
	}
	defer realCmd.Process.Kill() //nolint:errcheck

	r.injectProcess("cmd-1", realCmd)
	r.injectProcess("cmd-1:post", &exec.Cmd{}) // nil Process, :post suffix
	r.injectLabel("cmd-1", "My Command")

	snapshot := r.GetProcessSnapshot()

	// Only cmd-1 should appear (cmd-1:post filtered out; &exec.Cmd{} has nil Process)
	if len(snapshot) != 1 {
		t.Fatalf("snapshot len = %d, want 1; got %+v", len(snapshot), snapshot)
	}
	if snapshot[0].CmdID != "cmd-1" {
		t.Errorf("CmdID = %q, want %q", snapshot[0].CmdID, "cmd-1")
	}
	if snapshot[0].Label != "My Command" {
		t.Errorf("Label = %q, want %q", snapshot[0].Label, "My Command")
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

func TestStoreCmdLabel(t *testing.T) {
	r := NewRunner()
	r.storeCmdLabel("cmd-1", "Label One")
	r.cmdLabelsMu.RLock()
	got := r.cmdLabels["cmd-1"]
	r.cmdLabelsMu.RUnlock()
	if got != "Label One" {
		t.Errorf("label = %q, want %q", got, "Label One")
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
	code, err := r.runShellCommand("test-cmd", "echo hello", "/tmp", func(line string) {
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
