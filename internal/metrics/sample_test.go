package metrics

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"yv/internal/models"
)

func specForTest(days int, cmds ...SampleCommand) SampleSpec {
	return SampleSpec{Days: days, StepSeconds: 300, Seed: 7, Commands: cmds}
}

func busyCommand() SampleCommand {
	return SampleCommand{
		CmdID: "c1", Label: "Build", ProjectID: "p1", Group: "Android",
		RSSBaseMB: 100, RSSVarMB: 50, CPUBase: 10, CPUVar: 20,
		ActiveFrom: 9, ActiveTo: 11,
		ActiveDayChance: 1, RunsPerActiveDay: 2,
	}
}

func TestNormalizeSpec(t *testing.T) {
	tests := []struct {
		name  string
		in    SampleSpec
		check func(*testing.T, SampleSpec)
	}{
		{
			name: "zero days defaults to 90",
			in:   SampleSpec{},
			check: func(t *testing.T, s SampleSpec) {
				if s.Days != 90 {
					t.Errorf("Days = %d, want 90", s.Days)
				}
			},
		},
		{
			name: "sub-minute step is raised to 5 minutes",
			in:   SampleSpec{StepSeconds: 5},
			check: func(t *testing.T, s SampleSpec) {
				if s.StepSeconds != 300 {
					t.Errorf("StepSeconds = %d, want 300", s.StepSeconds)
				}
			},
		},
		{
			name: "step is snapped to a whole number of minutes",
			in:   SampleSpec{StepSeconds: 130},
			check: func(t *testing.T, s SampleSpec) {
				if s.StepSeconds%60 != 0 {
					t.Errorf("StepSeconds = %d, want a multiple of 60", s.StepSeconds)
				}
			},
		},
		{
			name: "inverted active window falls back to a working day",
			in:   specForTest(1, SampleCommand{ActiveFrom: 20, ActiveTo: 4}),
			check: func(t *testing.T, s SampleSpec) {
				if s.Commands[0].ActiveFrom != 9 || s.Commands[0].ActiveTo != 18 {
					t.Errorf("window = %d..%d, want 9..18", s.Commands[0].ActiveFrom, s.Commands[0].ActiveTo)
				}
			},
		},
		{
			name: "hours are clamped to the day",
			in:   specForTest(1, SampleCommand{ActiveFrom: -3, ActiveTo: 30}),
			check: func(t *testing.T, s SampleSpec) {
				if s.Commands[0].ActiveFrom < 0 || s.Commands[0].ActiveTo > 24 {
					t.Errorf("window = %d..%d, want inside 0..24", s.Commands[0].ActiveFrom, s.Commands[0].ActiveTo)
				}
			},
		},
		{
			name: "zero active chance means every day",
			in:   specForTest(1, SampleCommand{ActiveFrom: 9, ActiveTo: 10}),
			check: func(t *testing.T, s SampleSpec) {
				if s.Commands[0].ActiveDayChance != 1 {
					t.Errorf("ActiveDayChance = %v, want 1", s.Commands[0].ActiveDayChance)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) { tt.check(t, normalizeSpec(tt.in)) })
	}
}

func TestExpandSampleIsDeterministic(t *testing.T) {
	now := time.Date(2026, 8, 6, 23, 0, 0, 0, time.Local)
	spec := specForTest(5, busyCommand())

	a, aRuns, err := ExpandSample(spec, now)
	if err != nil {
		t.Fatalf("ExpandSample: %v", err)
	}
	b, bRuns, err := ExpandSample(spec, now)
	if err != nil {
		t.Fatalf("ExpandSample: %v", err)
	}

	if len(a) != len(b) || len(aRuns) != len(bRuns) {
		t.Fatalf("lengths differ between runs: %d/%d vs %d/%d", len(a), len(aRuns), len(b), len(bRuns))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("record %d differs between runs:\n%+v\n%+v", i, a[i], b[i])
		}
	}
}

func TestExpandSampleShape(t *testing.T) {
	now := time.Date(2026, 8, 6, 23, 0, 0, 0, time.Local)
	samples, runs, err := ExpandSample(specForTest(3, busyCommand()), now)
	if err != nil {
		t.Fatalf("ExpandSample: %v", err)
	}

	// 3 days x 2 active hours x 12 five-minute steps.
	if want := 3 * 2 * 12; len(samples) != want {
		t.Errorf("got %d samples, want %d", len(samples), want)
	}
	if want := 3 * 2; len(runs) != want {
		t.Errorf("got %d runs, want %d", len(runs), want)
	}

	for _, rec := range samples {
		if rec.T%60 != 0 {
			t.Fatalf("sample timestamp %d is not minute-aligned", rec.T)
		}
		if rec.N != 100 {
			t.Fatalf("N = %d, want 100 (300s / 3s)", rec.N)
		}
		if rec.RSSPeak < rec.RSSAvg {
			t.Fatalf("peak %d below average %d", rec.RSSPeak, rec.RSSAvg)
		}
		if rec.CPUPeak < rec.CPUAvg {
			t.Fatalf("cpu peak %v below average %v", rec.CPUPeak, rec.CPUAvg)
		}
		if rec.CmdID != "c1" || rec.Project != "p1" || rec.Group != "Android" {
			t.Fatalf("attribution missing: %+v", rec)
		}
	}
}

func TestExpandSampleNeverGeneratesTheFuture(t *testing.T) {
	// Mid-morning, so the command's active window extends past "now".
	now := time.Date(2026, 8, 6, 10, 0, 0, 0, time.Local)
	samples, runs, err := ExpandSample(specForTest(2, busyCommand()), now)
	if err != nil {
		t.Fatalf("ExpandSample: %v", err)
	}

	for _, rec := range samples {
		if rec.T > now.Unix() {
			t.Fatalf("sample at %v is in the future", time.Unix(rec.T, 0))
		}
	}
	for _, rec := range runs {
		if rec.T > now.Unix() {
			t.Fatalf("run at %v is in the future", time.Unix(rec.T, 0))
		}
	}
}

func TestExpandSampleIdleDaysLeaveGaps(t *testing.T) {
	now := time.Date(2026, 8, 6, 23, 0, 0, 0, time.Local)
	cmd := busyCommand()
	cmd.ActiveDayChance = 0.5

	samples, _, err := ExpandSample(specForTest(40, cmd), now)
	if err != nil {
		t.Fatalf("ExpandSample: %v", err)
	}

	days := make(map[string]bool)
	for _, rec := range samples {
		days[time.Unix(rec.T, 0).Format(dayLayout)] = true
	}
	// A 50% chance over 40 days should skip some days and cover others; the
	// gaps are what make the charts and calendar look real.
	if len(days) == 0 || len(days) == 40 {
		t.Errorf("covered %d of 40 days, expected a partial spread", len(days))
	}
}

func TestExpandSampleRunOutcomes(t *testing.T) {
	now := time.Date(2026, 8, 6, 23, 0, 0, 0, time.Local)
	cmd := busyCommand()
	cmd.RunsPerActiveDay = 20
	cmd.FailRate = 0.3
	cmd.StoppedRate = 0.3

	_, runs, err := ExpandSample(specForTest(20, cmd), now)
	if err != nil {
		t.Fatalf("ExpandSample: %v", err)
	}

	var ok, failed, stopped int
	for _, r := range runs {
		switch {
		case r.Stopped:
			stopped++
		case r.OK:
			ok++
		default:
			failed++
		}
	}
	if ok == 0 || failed == 0 || stopped == 0 {
		t.Errorf("want a mix of outcomes, got ok=%d failed=%d stopped=%d", ok, failed, stopped)
	}
	// A stopped run must never also be marked OK, or the heatmap would
	// double-count it.
	for _, r := range runs {
		if r.Stopped && r.OK {
			t.Fatal("a run is both stopped and OK")
		}
	}
}

func TestExpandSampleRejectsBadSpecs(t *testing.T) {
	now := time.Now()

	t.Run("no commands", func(t *testing.T) {
		if _, _, err := ExpandSample(SampleSpec{Days: 10}, now); err == nil {
			t.Error("expected an error for a spec with no commands")
		}
	})

	t.Run("absurd size is refused before doing work", func(t *testing.T) {
		cmd := busyCommand()
		cmd.ActiveFrom, cmd.ActiveTo = 0, 24
		spec := SampleSpec{Days: 100000, StepSeconds: 60, Commands: []SampleCommand{cmd}}
		if _, _, err := ExpandSample(spec, now); err == nil {
			t.Error("expected an error for an oversized spec")
		}
	})
}

func TestImportSampleRoundTrip(t *testing.T) {
	s := newTestStore(t, 365)

	spec := specForTest(3, busyCommand())
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	nSamples, nRuns, err := s.ImportSample(raw, time.Now())
	if err != nil {
		t.Fatalf("ImportSample: %v", err)
	}
	if nSamples == 0 || nRuns == 0 {
		t.Fatalf("imported %d samples and %d runs, want both non-zero", nSamples, nRuns)
	}

	now := time.Now()
	res := s.Query(models.MetricsQuery{
		From:    now.AddDate(0, 0, -3).Unix(),
		To:      now.Unix(),
		GroupBy: "command",
	})
	if res.Error != "" {
		t.Fatalf("Query: %s", res.Error)
	}
	if len(res.Series) != 1 || res.Series[0].Key != "c1" {
		t.Fatalf("want one series for c1, got %+v", res.Series)
	}
	if len(res.Series[0].Points) == 0 {
		t.Error("series has no points")
	}

	hm := s.ActivityHeatmap(7)
	if hm.Total == 0 {
		t.Error("heatmap has no runs")
	}
}

func TestImportSampleReplacesExistingData(t *testing.T) {
	s := newTestStore(t, 365)

	raw, _ := json.Marshal(specForTest(2, busyCommand()))
	if _, _, err := s.ImportSample(raw, time.Now()); err != nil {
		t.Fatalf("first import: %v", err)
	}
	first := s.StorageInfo().Bytes

	if _, _, err := s.ImportSample(raw, time.Now()); err != nil {
		t.Fatalf("second import: %v", err)
	}
	second := s.StorageInfo().Bytes

	if second != first {
		t.Errorf("re-importing should replace, not append: %d bytes then %d", first, second)
	}
}

func TestImportSampleRejectsInvalidJSON(t *testing.T) {
	s := newTestStore(t, 365)
	if _, _, err := s.ImportSample([]byte("{not json"), time.Now()); err == nil {
		t.Error("expected a parse error")
	}
}

// The checked-in sample file must stay importable — it is the one artefact a
// developer is told to load.
func TestCheckedInSampleSpecIsValid(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/dashboard-sample-3months.json")
	if err != nil {
		t.Skipf("sample file unavailable: %v", err)
	}

	var spec SampleSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatalf("sample file is not valid JSON: %v", err)
	}
	if spec.Days != 90 {
		t.Errorf("Days = %d, want 90 (three months)", spec.Days)
	}
	if len(spec.Commands) < 3 {
		t.Errorf("only %d commands — too few to exercise grouping", len(spec.Commands))
	}

	samples, runs, err := ExpandSample(spec, time.Now())
	if err != nil {
		t.Fatalf("checked-in sample does not expand: %v", err)
	}
	if len(samples) == 0 || len(runs) == 0 {
		t.Fatalf("expanded to %d samples and %d runs", len(samples), len(runs))
	}

	projects, groups := map[string]bool{}, map[string]bool{}
	for _, rec := range samples {
		projects[rec.Project] = true
		groups[rec.Group] = true
	}
	if len(projects) < 2 || len(groups) < 2 {
		t.Errorf("sample covers %d projects and %d groups; grouping needs at least 2 of each",
			len(projects), len(groups))
	}
	t.Logf("checked-in sample expands to %d samples and %d runs", len(samples), len(runs))
}

// Mirrors what the "Load sample data" button does, then inspects what the
// dashboard would receive for each grouping and range.
func TestSeededDashboardShape(t *testing.T) {
	s := newTestStore(t, 365)
	raw, err := os.ReadFile("../../testdata/dashboard-sample-3months.json")
	if err != nil {
		t.Skip(err)
	}
	if _, _, err := s.ImportSample(raw, time.Now()); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	for _, days := range []int{1, 7, 30, 90} {
		for _, by := range []string{"command", "project", "group"} {
			res := s.Query(models.MetricsQuery{
				From: now.AddDate(0, 0, -days).Unix(), To: now.Unix(), GroupBy: by,
			})
			pts := 0
			for _, ser := range res.Series {
				if len(ser.Points) > pts {
					pts = len(ser.Points)
				}
			}
			t.Logf("%3dd by %-8s -> %d series, up to %3d points, %ds buckets",
				days, by, len(res.Series), pts, res.Resolution)
			if len(res.Series) == 0 || pts < 2 {
				t.Errorf("%dd/%s produced a chart with nothing to draw", days, by)
			}
		}
	}

	hm := s.ActivityHeatmap(365)
	active := 0
	for _, d := range hm.Days {
		if d.Total > 0 {
			active++
		}
	}
	t.Logf("heatmap: %d runs over %d active days, busiest day %d", hm.Total, active, hm.Max)
	if active < 30 {
		t.Errorf("only %d active days — calendar would look empty", active)
	}
}

// Companion to TestSeededDashboardShape for the usage-frequency chart.
func TestSeededUsageFrequencyShape(t *testing.T) {
	s := newTestStore(t, 365)
	raw, err := os.ReadFile("../../testdata/dashboard-sample-3months.json")
	if err != nil {
		t.Skip(err)
	}
	if _, _, err := s.ImportSample(raw, time.Now()); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	for _, days := range []int{1, 7, 30, 365} {
		for _, by := range []string{"command", "project", "group"} {
			res := s.UsageFrequency(models.MetricsQuery{
				From: now.AddDate(0, 0, -days).Unix(), To: now.Unix(), GroupBy: by,
			})
			buckets := 0
			if len(res.Series) > 0 {
				buckets = len(res.Series[0].Points)
			}
			t.Logf("%3dd by %-8s -> %d series, %3d buckets, %4d runs (%ds each)",
				days, by, len(res.Series), buckets, res.Total, res.Resolution)
			if days > 1 && (len(res.Series) == 0 || buckets < 2) {
				t.Errorf("%dd/%s has nothing to draw", days, by)
			}
			// Every series must share one axis, or the stacked chart misaligns.
			for _, ser := range res.Series {
				if len(ser.Points) != buckets {
					t.Fatalf("%s has %d buckets, expected %d", ser.Key, len(ser.Points), buckets)
				}
			}
		}
	}
}
