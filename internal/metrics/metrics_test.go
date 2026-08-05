package metrics

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"yv/internal/models"
)

func newTestStore(t *testing.T, retentionDays int) *Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	return NewStore(func() int { return retentionDays })
}

// metricsDir returns the metrics dir path without creating it, so a test can
// assert it does not exist.
func metricsDir(t *testing.T) string {
	t.Helper()
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatalf("UserConfigDir: %v", err)
	}
	return filepath.Join(base, "yv", dirName)
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "\n")
}

// recentMinute returns a minute-aligned instant `agoMinutes` in the past.
// Tests must not seed data in the future: Query caps its range at now, so a
// hardcoded wall-clock time would silently fall outside it.
func recentMinute(agoMinutes int) time.Time {
	return time.Now().Truncate(time.Minute).Add(-time.Duration(agoMinutes) * time.Minute)
}

func sampleStats(cmdID, label, project, group string, rss int64, cpu float64) models.ResourceStats {
	return models.ResourceStats{
		AppRSS: 1000,
		AppCPU: 0.5,
		Commands: []models.ProcessStats{
			{CmdID: cmdID, Label: label, ProjectID: project, Group: group, RSS: rss, CPU: cpu},
		},
	}
}

// The headline guarantee: with collection off, the feature touches nothing.
func TestDisabledWritesNothing(t *testing.T) {
	s := newTestStore(t, 365)

	base := time.Now()
	for i := 0; i < 100; i++ {
		s.Observe(base.Add(time.Duration(i)*3*time.Second), sampleStats("c1", "Build", "p1", "g", 100, 1))
	}
	s.RecordRun(models.RunRecord{T: base.Unix(), CmdID: "c1", OK: true})
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := os.Stat(metricsDir(t)); !os.IsNotExist(err) {
		t.Errorf("metrics directory must not exist while collection is disabled (err=%v)", err)
	}
}

// Read-side calls happen on startup (Prune) and whenever the Settings screen
// opens (StorageInfo). None of them may create the metrics directory, or the
// opt-in guarantee leaks a directory for users who never turned metrics on.
func TestReadPathsDoNotCreateTheDirectory(t *testing.T) {
	s := newTestStore(t, 365)
	dir := metricsDir(t)

	calls := []struct {
		name string
		fn   func()
	}{
		{"Prune", func() { _ = s.Prune(time.Now()) }},
		{"StorageInfo", func() { s.StorageInfo() }},
		{"Clear", func() { _ = s.Clear() }},
		{"Query", func() {
			now := time.Now()
			s.Query(models.MetricsQuery{From: now.Add(-time.Hour).Unix(), To: now.Unix()})
		}},
		{"ActivityHeatmap", func() { s.ActivityHeatmap(30) }},
	}

	for _, c := range calls {
		t.Run(c.name, func(t *testing.T) {
			c.fn()
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Errorf("%s created the metrics directory (err=%v)", c.name, err)
			}
		})
	}
}

func TestStoreRoundTrip(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)

	// Two full minutes of 3-second ticks.
	start := recentMinute(10)
	for i := 0; i < 40; i++ {
		s.Observe(start.Add(time.Duration(i)*3*time.Second), sampleStats("c1", "Build", "p1", "Android", 100, 2))
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	path := filepath.Join(metricsDir(t), fmt.Sprintf("samples-%s.jsonl", start.Format(dayLayout)))
	lines := readLines(t, path)
	// Two minutes x (one command + the app pseudo-command).
	if len(lines) != 4 {
		t.Fatalf("wrote %d lines, want 4:\n%s", len(lines), strings.Join(lines, "\n"))
	}

	res := s.Query(models.MetricsQuery{
		From:    start.Unix(),
		To:      start.Add(3 * time.Minute).Unix(),
		GroupBy: "command",
	})
	if res.Error != "" {
		t.Fatalf("Query error: %s", res.Error)
	}
	if len(res.Series) != 1 {
		t.Fatalf("want 1 series (the app is hidden), got %d", len(res.Series))
	}
	if got := len(res.Series[0].Points); got != 2 {
		t.Errorf("want 2 minute points, got %d", got)
	}
	if res.Series[0].Points[0].N != 20 {
		t.Errorf("N = %d, want 20 samples in a full minute", res.Series[0].Points[0].N)
	}
	if res.Series[0].Points[0].RSSAvg != 100 {
		t.Errorf("RSSAvg = %d, want 100", res.Series[0].Points[0].RSSAvg)
	}
}

func TestFilePermissions(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)
	s.Observe(time.Now(), sampleStats("c1", "Build", "p1", "g", 100, 1))
	s.Close()

	dir := metricsDir(t)
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("Stat dir: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Errorf("metrics dir mode = %o, want 700", perm)
	}

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		st, _ := e.Info()
		if perm := st.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s mode = %o, want 600", e.Name(), perm)
		}
	}
}

func TestDisableDropsPartialBucket(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)

	start := recentMinute(10)
	for i := 0; i < 5; i++ {
		s.Observe(start.Add(time.Duration(i)*3*time.Second), sampleStats("c1", "Build", "p1", "g", 100, 1))
	}
	s.SetEnabled(false)
	s.Close()

	path := filepath.Join(metricsDir(t), fmt.Sprintf("samples-%s.jsonl", start.Format(dayLayout)))
	if lines := readLines(t, path); len(lines) != 0 {
		t.Errorf("disabling must discard the partial minute, got %d lines", len(lines))
	}
}

func TestPartialBucketFlushedOnClose(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)

	start := recentMinute(10)
	for i := 0; i < 4; i++ {
		s.Observe(start.Add(time.Duration(i)*3*time.Second), sampleStats("c1", "Build", "p1", "g", 100, 1))
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	res := s.Query(models.MetricsQuery{From: start.Unix(), To: start.Add(time.Minute).Unix(), GroupBy: "command"})
	if len(res.Series) != 1 || len(res.Series[0].Points) != 1 {
		t.Fatalf("want the partial minute flushed, got %+v", res.Series)
	}
	if n := res.Series[0].Points[0].N; n != 4 {
		t.Errorf("N = %d, want 4 — the low count is what lets the reader weight it", n)
	}
}

func TestQueryIncludesUnflushedMinute(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)

	now := time.Now()
	for i := 0; i < 3; i++ {
		s.Observe(now, sampleStats("c1", "Build", "p1", "g", 500, 1))
	}

	// Nothing has been flushed yet; the live dashboard must still see it.
	res := s.Query(models.MetricsQuery{From: now.Add(-time.Hour).Unix(), To: now.Unix() + 1, GroupBy: "command"})
	if len(res.Series) != 1 {
		t.Fatalf("want the in-memory minute folded in, got %d series", len(res.Series))
	}
	if res.Series[0].Points[0].RSSAvg != 500 {
		t.Errorf("RSSAvg = %d, want 500", res.Series[0].Points[0].RSSAvg)
	}
}

func TestRecordRunAndHeatmap(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)

	now := time.Now()
	s.RecordRun(models.RunRecord{T: now.Unix(), CmdID: "c1", DurMS: 500, ExitCode: 0, OK: true})
	s.RecordRun(models.RunRecord{T: now.Unix(), CmdID: "c1", DurMS: 700, ExitCode: 1})
	s.RecordRun(models.RunRecord{T: now.Unix(), CmdID: "c2", DurMS: 900, ExitCode: 143, Stopped: true})
	s.Close()

	hm := s.ActivityHeatmap(7)
	if len(hm.Days) != 7 {
		t.Fatalf("len(Days) = %d, want 7", len(hm.Days))
	}
	today := hm.Days[6]
	if today.Total != 3 || today.Success != 1 || today.Fail != 1 || today.Stopped != 1 {
		t.Errorf("today = %+v, want total 3 / ok 1 / fail 1 / stopped 1", today)
	}
	if hm.Max != 3 {
		t.Errorf("Max = %d, want 3", hm.Max)
	}
}

func TestSkipsCorruptLines(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)

	start := time.Now().Truncate(time.Minute)
	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir: %v", err)
	}
	path := filepath.Join(dir, fmt.Sprintf("samples-%s.jsonl", start.Format(dayLayout)))

	good := fmt.Sprintf(`{"t":%d,"c":"c1","l":"Build","n":20,"ra":100,"rp":200}`, start.Unix())
	content := good + "\n" + `{"t":123,"c":"c2","n":2` // truncated by a hard kill
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res := s.Query(models.MetricsQuery{
		From:    start.Add(-time.Minute).Unix(),
		To:      start.Add(time.Minute).Unix(),
		GroupBy: "command",
	})
	if res.Error != "" {
		t.Fatalf("a truncated line must not fail the query: %s", res.Error)
	}
	if len(res.Series) != 1 || res.Series[0].Key != "c1" {
		t.Errorf("want the intact record returned, got %+v", res.Series)
	}
}

func TestClear(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)
	s.Observe(time.Now(), sampleStats("c1", "Build", "p1", "g", 100, 1))
	s.Flush()

	dir, _ := Dir()
	// A file this package did not write must survive Clear.
	foreign := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(foreign, []byte("keep me"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := s.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if _, _, ok := parseDayFileName(e.Name()); ok {
			t.Errorf("%s survived Clear", e.Name())
		}
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Error("Clear deleted a file this package did not write")
	}

	// The store stays usable afterwards.
	s.Observe(time.Now(), sampleStats("c1", "Build", "p1", "g", 100, 1))
	if err := s.Close(); err != nil {
		t.Errorf("store unusable after Clear: %v", err)
	}
}

func TestPrune(t *testing.T) {
	s := newTestStore(t, 7)

	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir: %v", err)
	}
	now := time.Now()
	seed := []string{
		fmt.Sprintf("samples-%s.jsonl", now.Format(dayLayout)),
		fmt.Sprintf("samples-%s.jsonl", now.AddDate(0, 0, -2).Format(dayLayout)),
		"samples-2020-01-01.jsonl",
		"runs-2020-01-01.jsonl",
		"README.md",
	}
	for _, name := range seed {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}\n"), 0o600); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
	}

	if err := s.Prune(now); err != nil {
		t.Fatalf("Prune: %v", err)
	}

	mustExist := seed[:2]
	mustExist = append(mustExist, "README.md")
	for _, name := range mustExist {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s should have survived pruning", name)
		}
	}
	for _, name := range []string{"samples-2020-01-01.jsonl", "runs-2020-01-01.jsonl"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s should have been pruned", name)
		}
	}
}

func TestStorageInfo(t *testing.T) {
	s := newTestStore(t, 365)

	t.Run("reports nothing before any collection", func(t *testing.T) {
		info := s.StorageInfo()
		if info.Enabled || info.Files != 0 || info.Bytes != 0 {
			t.Errorf("info = %+v, want empty and disabled", info)
		}
	})

	s.SetEnabled(true)
	s.Observe(time.Now(), sampleStats("c1", "Build", "p1", "g", 100, 1))
	s.Flush()

	info := s.StorageInfo()
	if !info.Enabled {
		t.Error("Enabled should be true")
	}
	if info.Files != 1 {
		t.Errorf("Files = %d, want 1", info.Files)
	}
	if info.Bytes == 0 {
		t.Error("Bytes should be non-zero")
	}
	if info.OldestDay != time.Now().Format(dayLayout) {
		t.Errorf("OldestDay = %q, want today", info.OldestDay)
	}
}

func TestQueryGroupByProject(t *testing.T) {
	s := newTestStore(t, 365)
	s.SetEnabled(true)

	start := recentMinute(10)
	for i := 0; i < 20; i++ {
		at := start.Add(time.Duration(i) * 3 * time.Second)
		s.Observe(at, models.ResourceStats{
			Commands: []models.ProcessStats{
				{CmdID: "c1", Label: "Build", ProjectID: "p1", Group: "Android", RSS: 100, CPU: 1},
				{CmdID: "c2", Label: "Test", ProjectID: "p1", Group: "Android", RSS: 300, CPU: 2},
				{CmdID: "c3", Label: "Serve", ProjectID: "p2", Group: "Web", RSS: 50, CPU: 3},
			},
		})
	}
	s.Close()

	q := models.MetricsQuery{From: start.Unix(), To: start.Add(2 * time.Minute).Unix()}

	byProject := s.Query(withGroupBy(q, "project"))
	if len(byProject.Series) != 2 {
		t.Fatalf("want 2 project series, got %d", len(byProject.Series))
	}
	for _, ser := range byProject.Series {
		want := int64(400) // p1 = c1 + c2
		if ser.Key == "p2" {
			want = 50
		}
		if ser.Points[0].RSSAvg != want {
			t.Errorf("%s RSSAvg = %d, want %d", ser.Key, ser.Points[0].RSSAvg, want)
		}
	}

	byGroup := s.Query(withGroupBy(q, "group"))
	if len(byGroup.Series) != 2 {
		t.Errorf("want 2 group series, got %d", len(byGroup.Series))
	}

	byCommand := s.Query(withGroupBy(q, "command"))
	if len(byCommand.Series) != 3 {
		t.Errorf("want 3 command series, got %d", len(byCommand.Series))
	}
}

func withGroupBy(q models.MetricsQuery, groupBy string) models.MetricsQuery {
	q.GroupBy = groupBy
	return q
}

func TestQueryOnEmptyStore(t *testing.T) {
	s := newTestStore(t, 365)

	now := time.Now()
	res := s.Query(models.MetricsQuery{From: now.Add(-time.Hour).Unix(), To: now.Unix(), GroupBy: "command"})
	if res.Error != "" {
		t.Errorf("querying an empty store should not error, got %q", res.Error)
	}
	if len(res.Series) != 0 {
		t.Errorf("want no series, got %d", len(res.Series))
	}

	// Reading must not bring the directory into existence.
	if _, err := os.Stat(metricsDir(t)); !os.IsNotExist(err) {
		t.Error("a read must not create the metrics directory")
	}

	hm := s.ActivityHeatmap(30)
	if len(hm.Days) != 30 {
		t.Errorf("len(Days) = %d, want 30", len(hm.Days))
	}
}

func TestHeatmapClampedToRetention(t *testing.T) {
	s := newTestStore(t, 10)
	if got := len(s.ActivityHeatmap(365).Days); got != 10 {
		t.Errorf("len(Days) = %d, want 10 (clamped to the retention window)", got)
	}
}

func TestEnableAfterDisableResumes(t *testing.T) {
	s := newTestStore(t, 365)

	s.SetEnabled(true)
	s.Observe(time.Now(), sampleStats("c1", "Build", "p1", "g", 100, 1))
	s.SetEnabled(false)

	// Existing data survives a disable.
	s.SetEnabled(true)
	s.Observe(time.Now(), sampleStats("c1", "Build", "p1", "g", 200, 1))
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	now := time.Now()
	res := s.Query(models.MetricsQuery{From: now.Add(-time.Hour).Unix(), To: now.Unix() + 60, GroupBy: "command"})
	if len(res.Series) != 1 {
		t.Fatalf("want data after re-enabling, got %d series", len(res.Series))
	}
}
