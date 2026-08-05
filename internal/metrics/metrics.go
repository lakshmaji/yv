// Package metrics records resource usage and command-run history so the
// dashboard can chart them, and answers bounded range queries over that
// history.
//
// Collection is strictly opt-in. While disabled, Observe and RecordRun return
// after a single atomic load and nothing — not even the metrics directory — is
// created on disk.
//
// # Storage
//
// Data is appended to daily JSONL files under the app config dir:
//
//	metrics/samples-2026-08-06.jsonl   one 1-minute aggregate per command
//	metrics/runs-2026-08-06.jsonl      one record per completed run
//
// Append-only daily files are chosen over a single JSON document because the
// write cost stays proportional to new data rather than to the whole corpus,
// pruning is an os.Remove instead of a rewrite, a range query opens only the
// days it needs, and a line truncated by a hard kill costs at most one minute
// instead of corrupting everything.
//
// Samples are aggregated to one-minute buckets in memory and flushed when the
// minute rolls over, which is driven by the monitor's existing 3-second tick —
// there is no second timer.
package metrics

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"yv/internal/models"
)

const (
	dirName    = "metrics"
	sampleKind = "samples"
	runKind    = "runs"
)

// acc accumulates one command's samples within the current minute.
type acc struct {
	meta    models.CmdMeta
	n       int
	rssSum  int64
	rssPeak int64
	cpuSum  float64
	cpuPeak float64
}

// Store owns the metrics directory. It accumulates the current minute in
// memory, appends completed minutes to the day's file, prunes expired days, and
// serves range queries.
type Store struct {
	mu      sync.Mutex
	enabled atomic.Bool

	buckets map[string]*acc // current minute only, keyed by cmdID
	minute  int64           // unix seconds of the minute being accumulated

	day        string
	sampleFile *os.File
	runFile    *os.File

	retentionDays func() int
	lastPruneDay  string
}

// NewStore creates a store that is disabled until SetEnabled is called.
// retentionDays is read on each prune so a settings change takes effect without
// recreating the store.
func NewStore(retentionDays func() int) *Store {
	if retentionDays == nil {
		retentionDays = func() int { return 365 }
	}
	return &Store{
		buckets:       make(map[string]*acc),
		retentionDays: retentionDays,
	}
}

// SetEnabled turns collection on or off. Disabling discards the
// partially-accumulated minute without writing it and closes the day files, so
// once this returns nothing further reaches the disk.
func (s *Store) SetEnabled(on bool) {
	s.enabled.Store(on)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.buckets = make(map[string]*acc)
	s.minute = 0
	if !on {
		s.closeFilesLocked()
	}
}

// Enabled reports whether collection is currently on.
func (s *Store) Enabled() bool { return s.enabled.Load() }

// Observe folds one monitor tick into the current minute.
//
// It is called on every tick even when nothing is running: that empty call is
// what rolls the minute over and flushes the previous minute's tail while the
// app sits idle.
func (s *Store) Observe(now time.Time, stats models.ResourceStats) {
	if !s.enabled.Load() {
		return // the entire cost of the feature when switched off
	}

	minute := now.Unix() - now.Unix()%60

	s.mu.Lock()
	defer s.mu.Unlock()

	// Re-check: SetEnabled(false) may have run while we waited for the lock.
	if !s.enabled.Load() {
		return
	}

	if s.minute != 0 && minute != s.minute {
		s.flushLocked(now)
	}
	s.minute = minute

	s.foldLocked(AppCmdID, models.CmdMeta{Label: "yv"}, stats.AppRSS, stats.AppCPU)
	for _, c := range stats.Commands {
		meta := models.CmdMeta{Label: c.Label, ProjectID: c.ProjectID, Group: c.Group}
		s.foldLocked(c.CmdID, meta, c.RSS, c.CPU)
	}
}

// foldLocked adds one sample to a command's accumulator. Callers must hold s.mu.
func (s *Store) foldLocked(cmdID string, meta models.CmdMeta, rss int64, cpu float64) {
	if cmdID == "" {
		return
	}
	a, ok := s.buckets[cmdID]
	if !ok {
		a = &acc{}
		s.buckets[cmdID] = a
	}
	// The last tick's metadata wins; it does not change within a run, but a
	// later tick may have richer attribution than the first.
	if meta.Label != "" {
		a.meta = meta
	}
	a.n++
	a.rssSum += rss
	a.cpuSum += cpu
	if rss > a.rssPeak {
		a.rssPeak = rss
	}
	if cpu > a.cpuPeak {
		a.cpuPeak = cpu
	}
}

// RecordRun appends one completed run. Unlike samples this is written
// immediately: runs are rare, and losing one to a crash is worse than losing a
// minute of resource samples.
func (s *Store) RecordRun(rec models.RunRecord) {
	if !s.enabled.Load() {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.enabled.Load() {
		return
	}

	f, err := s.fileLocked(runKind, time.Unix(rec.T, 0))
	if err != nil {
		return
	}
	writeLine(f, rec)
}

// Flush writes the currently-accumulated minute. Safe to call when disabled or
// empty.
func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.flushLocked(time.Now())
}

// Close flushes the partial minute and releases the day files. Called on
// shutdown; the partial bucket's low N is what lets the reader weight it
// correctly against full minutes.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	err := s.flushLocked(time.Now())
	s.closeFilesLocked()
	return err
}

// flushLocked writes every accumulated bucket for s.minute and clears the map.
// Callers must hold s.mu.
func (s *Store) flushLocked(now time.Time) error {
	if len(s.buckets) == 0 || s.minute == 0 {
		s.buckets = make(map[string]*acc)
		return nil
	}

	f, err := s.fileLocked(sampleKind, time.Unix(s.minute, 0))
	if err != nil {
		s.buckets = make(map[string]*acc)
		return err
	}

	for cmdID, a := range s.buckets {
		if a.n == 0 {
			continue
		}
		writeLine(f, models.SampleRecord{
			T:       s.minute,
			CmdID:   cmdID,
			Label:   a.meta.Label,
			Project: a.meta.ProjectID,
			Group:   a.meta.Group,
			N:       a.n,
			RSSAvg:  a.rssSum / int64(a.n),
			RSSPeak: a.rssPeak,
			CPUAvg:  a.cpuSum / float64(a.n),
			CPUPeak: a.cpuPeak,
		})
	}

	s.buckets = make(map[string]*acc)
	s.maybePruneLocked(now)
	return nil
}

// fileLocked returns the open append handle for one kind on the given day,
// rolling the day over if needed. Callers must hold s.mu.
func (s *Store) fileLocked(kind string, when time.Time) (*os.File, error) {
	day := when.Format(dayLayout)
	if day != s.day {
		s.closeFilesLocked()
		s.day = day
	}

	existing := s.sampleFile
	if kind == runKind {
		existing = s.runFile
	}
	if existing != nil {
		return existing, nil
	}

	dir, err := Dir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, fmt.Sprintf("%s-%s.jsonl", kind, day))
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	if kind == runKind {
		s.runFile = f
	} else {
		s.sampleFile = f
	}
	return f, nil
}

func (s *Store) closeFilesLocked() {
	if s.sampleFile != nil {
		s.sampleFile.Close()
		s.sampleFile = nil
	}
	if s.runFile != nil {
		s.runFile.Close()
		s.runFile = nil
	}
	s.day = ""
}

func writeLine(f *os.File, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	f.Write(append(raw, '\n'))
}

// maybePruneLocked prunes at most once per day. Callers must hold s.mu.
func (s *Store) maybePruneLocked(now time.Time) {
	day := now.Format(dayLayout)
	if s.lastPruneDay == day {
		return
	}
	s.lastPruneDay = day
	go func() { _ = s.Prune(now) }()
}

// Prune removes day files that fall outside the retention window. Files this
// package did not write are ignored.
//
// Like every read-side path it uses dirIfExists, so pruning never brings the
// metrics directory into existence — with collection off there is nothing to
// prune and nothing should appear on disk.
func (s *Store) Prune(now time.Time) error {
	dir, ok := dirIfExists()
	if !ok {
		return nil
	}
	names, err := listFiles(dir)
	if err != nil {
		return err
	}

	// Never unlink a file we are still appending to.
	s.mu.Lock()
	openDay := s.day
	s.mu.Unlock()

	var firstErr error
	for _, name := range expiredFiles(names, s.retentionDays(), now) {
		if _, day, _ := parseDayFileName(name); day == openDay {
			continue
		}
		if err := os.Remove(filepath.Join(dir, name)); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Clear removes every metrics file and drops in-memory state. The directory is
// left in place and usable.
func (s *Store) Clear() error {
	s.mu.Lock()
	s.buckets = make(map[string]*acc)
	s.minute = 0
	s.closeFilesLocked()
	s.mu.Unlock()

	dir, ok := dirIfExists()
	if !ok {
		return nil
	}
	names, err := listFiles(dir)
	if err != nil {
		return err
	}

	var firstErr error
	for _, name := range names {
		if _, _, ok := parseDayFileName(name); !ok {
			continue
		}
		if err := os.Remove(filepath.Join(dir, name)); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// StorageInfo reports how much disk the metrics store is using, for display in
// the settings screen.
func (s *Store) StorageInfo() models.MetricsStorageInfo {
	info := models.MetricsStorageInfo{Enabled: s.enabled.Load()}

	// dirIfExists, not Dir: merely opening the Settings screen must not create
	// the metrics directory while collection is off.
	dir, ok := dirIfExists()
	if !ok {
		return info
	}
	info.Dir = dir

	entries, err := os.ReadDir(dir)
	if err != nil {
		return info
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		_, day, ok := parseDayFileName(e.Name())
		if !ok {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		info.Files++
		info.Bytes += st.Size()
		if info.OldestDay == "" || day < info.OldestDay {
			info.OldestDay = day
		}
	}
	return info
}

// Dir returns the metrics directory, creating it if needed.
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("UserConfigDir: %w", err)
	}
	dir := filepath.Join(base, "yv", dirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("MkdirAll: %w", err)
	}
	return dir, nil
}

// dirIfExists returns the metrics directory without creating it, so read paths
// never bring the directory into existence while collection is off.
func dirIfExists() (string, bool) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", false
	}
	dir := filepath.Join(base, "yv", dirName)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return "", false
	}
	return dir, true
}

func listFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

// --- read path ---

// Query returns aggregated resource series for a bounded time range. Records
// still buffered in memory for the current minute are folded in, so a live
// dashboard does not show a hole at its right-hand edge.
func (s *Store) Query(req models.MetricsQuery) models.MetricsResult {
	now := time.Now()
	q := normalizeQuery(req, now, s.retentionDays())

	res := models.MetricsResult{
		From:       q.From,
		To:         q.To,
		Resolution: q.Resolution,
		GroupBy:    q.GroupBy,
		Series:     []models.MetricsSeries{},
	}

	records, err := s.readSamples(q.From, q.To)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	records = append(records, s.pendingSamples()...)

	series := Fold(records, q, q.Resolution)
	kept, omitted := TopSeries(series, q.MaxSeries)
	res.Series = kept
	res.SeriesOmitted = omitted
	return res
}

// pendingSamples snapshots the un-flushed current minute as sample records so
// Query can include it.
func (s *Store) pendingSamples() []models.SampleRecord {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.minute == 0 || len(s.buckets) == 0 {
		return nil
	}
	out := make([]models.SampleRecord, 0, len(s.buckets))
	for cmdID, a := range s.buckets {
		if a.n == 0 {
			continue
		}
		out = append(out, models.SampleRecord{
			T:       s.minute,
			CmdID:   cmdID,
			Label:   a.meta.Label,
			Project: a.meta.ProjectID,
			Group:   a.meta.Group,
			N:       a.n,
			RSSAvg:  a.rssSum / int64(a.n),
			RSSPeak: a.rssPeak,
			CPUAvg:  a.cpuSum / float64(a.n),
			CPUPeak: a.cpuPeak,
		})
	}
	return out
}

// UsageFrequency returns how often each command, project, or group was run
// over a bounded time range — the same grouping and range controls as Query,
// but counting invocations rather than resource use.
func (s *Store) UsageFrequency(req models.MetricsQuery) models.FrequencyResult {
	now := time.Now()
	q := normalizeQuery(req, now, s.retentionDays())

	// Runs are sparse compared to samples, so the automatic resolution chosen
	// for resource charts would leave most buckets empty. Step up to something
	// that produces a readable number of columns.
	q.Resolution = frequencyResolution(q.From, q.To)

	res := models.FrequencyResult{
		From:       q.From,
		To:         q.To,
		Resolution: q.Resolution,
		GroupBy:    q.GroupBy,
		Series:     []models.FrequencySeries{},
	}

	records, err := s.readRuns(q.From, q.To)
	if err != nil {
		res.Error = err.Error()
		return res
	}

	series := FoldRunFrequency(records, q, q.Resolution)
	kept, omitted := TopFrequencySeries(series, q.MaxSeries)
	res.Series = kept
	res.SeriesOmitted = omitted
	for _, ser := range kept {
		res.Total += ser.Total
	}
	return res
}

// ActivityHeatmap returns dense per-day run counts for the last `days` days.
func (s *Store) ActivityHeatmap(days int) models.ActivityHeatmap {
	now := time.Now()
	if days <= 0 {
		days = 365
	}
	if retention := s.retentionDays(); retention > 0 && days > retention {
		days = retention
	}

	from := now.AddDate(0, 0, -(days - 1)).Unix()
	records, err := s.readRuns(from, now.Unix()+1)
	if err != nil {
		out := foldRuns(nil, days, now, time.Local)
		out.Error = err.Error()
		return out
	}
	return foldRuns(records, days, now, time.Local)
}

func (s *Store) readSamples(from, to int64) ([]models.SampleRecord, error) {
	var out []models.SampleRecord
	err := s.eachDayFile(sampleKind, from, to, func(line []byte) {
		var rec models.SampleRecord
		if json.Unmarshal(line, &rec) != nil {
			return // a line truncated by a hard kill; skip it
		}
		if rec.T >= from && rec.T < to {
			out = append(out, rec)
		}
	})
	return out, err
}

func (s *Store) readRuns(from, to int64) ([]models.RunRecord, error) {
	var out []models.RunRecord
	err := s.eachDayFile(runKind, from, to, func(line []byte) {
		var rec models.RunRecord
		if json.Unmarshal(line, &rec) != nil {
			return
		}
		if rec.T >= from && rec.T < to {
			out = append(out, rec)
		}
	})
	return out, err
}

// eachDayFile streams every line of the day files a range touches. A missing
// file is not an error — it just means nothing was collected that day.
func (s *Store) eachDayFile(kind string, from, to int64, fn func([]byte)) error {
	dir, ok := dirIfExists()
	if !ok {
		return nil
	}

	for _, day := range dayKeys(from, to, time.Local) {
		path := filepath.Join(dir, fmt.Sprintf("%s-%s.jsonl", kind, day))
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			fn(sc.Bytes())
		}
		f.Close()
	}
	return nil
}
