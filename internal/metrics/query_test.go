package metrics

import (
	"reflect"
	"testing"
	"time"

	"yv/internal/models"
)

func TestAutoResolution(t *testing.T) {
	const hour, day = int64(3600), int64(86400)

	tests := []struct {
		name      string
		span      int64
		maxPoints int
		want      int
	}{
		{"one hour at 500 points fits in 1m buckets", hour, 500, 60},
		{"six hours needs 1m still (360 points)", 6 * hour, 500, 60},
		{"one day needs 5m buckets", day, 500, 300},
		{"seven days needs 30m -> snaps to 1h", 7 * day, 500, 3600},
		{"thirty days at 1h would be 720 points, so it snaps to 6h", 30 * day, 500, 21600},
		{"one year needs 1d at 500 points", 365 * day, 500, 86400},
		// 52 weekly buckets still exceeds 45, so a year steps on to monthly.
		{"a low point cap pushes a year to monthly", 365 * day, 45, 2592000},
		{"a low point cap pushes 90d to weekly", 90 * day, 45, 604800},
		{"30d at a low cap stays daily", 30 * day, 45, 86400},
		{"24h at a low cap is hourly", day, 45, 3600},
		{"zero span floors at 1m", 0, 500, 60},
		{"negative span floors at 1m", -100, 500, 60},
		{"zero maxPoints uses the default", day, 0, 300},
		{"tiny maxPoints escalates the step", hour, 2, 3600},
		{"absurd range saturates at the largest step", 100 * 365 * day, 10, 2592000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := autoResolution(0, tt.span, tt.maxPoints); got != tt.want {
				t.Errorf("autoResolution(span=%d, max=%d) = %d, want %d", tt.span, tt.maxPoints, got, tt.want)
			}
		})
	}
}

func TestSeriesKey(t *testing.T) {
	rec := models.SampleRecord{CmdID: "c1", Label: "Build", Project: "p1", Group: "Android"}

	tests := []struct {
		name      string
		rec       models.SampleRecord
		groupBy   string
		wantKey   string
		wantLabel string
	}{
		{"by command", rec, "command", "c1", "Build"},
		{"by project", rec, "project", "p1", "p1"},
		{"by group", rec, "group", "Android", "Android"},
		{"unknown groupBy falls back to command", rec, "bogus", "c1", "Build"},
		{"empty groupBy falls back to command", rec, "", "c1", "Build"},
		{
			name:      "command with no label uses the id",
			rec:       models.SampleRecord{CmdID: "c2"},
			groupBy:   "command",
			wantKey:   "c2",
			wantLabel: "c2",
		},
		{
			name:      "missing project is unattributed",
			rec:       models.SampleRecord{CmdID: "c3", Group: "iOS"},
			groupBy:   "project",
			wantKey:   unattributedKey,
			wantLabel: unattributedLabel,
		},
		{
			name:      "missing group is unattributed",
			rec:       models.SampleRecord{CmdID: "c3", Project: "p1"},
			groupBy:   "group",
			wantKey:   unattributedKey,
			wantLabel: unattributedLabel,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			key, label := seriesKey(tt.rec, tt.groupBy)
			if key != tt.wantKey || label != tt.wantLabel {
				t.Errorf("seriesKey() = (%q, %q), want (%q, %q)", key, label, tt.wantKey, tt.wantLabel)
			}
		})
	}
}

func TestMatchesFilter(t *testing.T) {
	rec := models.SampleRecord{CmdID: "c1", Project: "p1", Group: "Android"}

	tests := []struct {
		name string
		rec  models.SampleRecord
		req  models.MetricsQuery
		want bool
	}{
		{"no filters", rec, models.MetricsQuery{}, true},
		{"matching project", rec, models.MetricsQuery{ProjectID: "p1"}, true},
		{"other project", rec, models.MetricsQuery{ProjectID: "p2"}, false},
		{"matching group", rec, models.MetricsQuery{Group: "Android"}, true},
		{"other group", rec, models.MetricsQuery{Group: "iOS"}, false},
		{"cmd id in list", rec, models.MetricsQuery{CmdIDs: []string{"c1", "c9"}}, true},
		{"cmd id not in list", rec, models.MetricsQuery{CmdIDs: []string{"c9"}}, false},
		{
			name: "app pseudo-command is hidden by default",
			rec:  models.SampleRecord{CmdID: AppCmdID},
			req:  models.MetricsQuery{},
			want: false,
		},
		{
			name: "app pseudo-command is shown when asked for",
			rec:  models.SampleRecord{CmdID: AppCmdID},
			req:  models.MetricsQuery{CmdIDs: []string{AppCmdID}},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := matchesFilter(tt.rec, tt.req); got != tt.want {
				t.Errorf("matchesFilter() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestFold(t *testing.T) {
	// An hour-aligned base, so it is also aligned to the 60s and 300s buckets
	// used below and the maths reads cleanly. Buckets are absolute-aligned, not
	// relative to the query start.
	const t0 = int64(1_699_999_200)

	full := func(t int64, cmd, proj string, rss int64, cpu float64) models.SampleRecord {
		return models.SampleRecord{
			T: t, CmdID: cmd, Label: cmd, Project: proj, Group: "g",
			N: 20, RSSAvg: rss, RSSPeak: rss * 2, CPUAvg: cpu, CPUPeak: cpu * 2,
		}
	}

	t.Run("single command single minute", func(t *testing.T) {
		got := Fold(
			[]models.SampleRecord{full(t0, "c1", "p1", 100, 5)},
			models.MetricsQuery{From: t0, To: t0 + 60, GroupBy: "command"},
			60,
		)
		if len(got) != 1 || len(got[0].Points) != 1 {
			t.Fatalf("want 1 series with 1 point, got %+v", got)
		}
		pt := got[0].Points[0]
		if pt.RSSAvg != 100 || pt.RSSPeak != 200 || pt.CPUAvg != 5 {
			t.Errorf("point = %+v", pt)
		}
		if got[0].PeakRSS != 200 {
			t.Errorf("PeakRSS = %d, want 200", got[0].PeakRSS)
		}
	})

	t.Run("two commands in one project SUM, they do not average", func(t *testing.T) {
		got := Fold(
			[]models.SampleRecord{
				full(t0, "c1", "p1", 100, 5),
				full(t0, "c2", "p1", 300, 7),
			},
			models.MetricsQuery{From: t0, To: t0 + 60, GroupBy: "project"},
			60,
		)
		if len(got) != 1 {
			t.Fatalf("want 1 project series, got %d", len(got))
		}
		if got[0].Points[0].RSSAvg != 400 {
			t.Errorf("project RSS = %d, want 400 (the sum, not the mean)", got[0].Points[0].RSSAvg)
		}
		if got[0].Points[0].CPUAvg != 12 {
			t.Errorf("project CPU = %v, want 12", got[0].Points[0].CPUAvg)
		}
		if got[0].Points[0].RSSPeak != 600 {
			t.Errorf("project peak = %d, want 600 (the max of the two)", got[0].Points[0].RSSPeak)
		}
	})

	t.Run("minutes within a bucket AVERAGE", func(t *testing.T) {
		recs := []models.SampleRecord{
			full(t0, "c1", "p1", 100, 1),
			full(t0+60, "c1", "p1", 200, 3),
			full(t0+120, "c1", "p1", 300, 5),
			full(t0+180, "c1", "p1", 400, 7),
			full(t0+240, "c1", "p1", 500, 9),
		}
		got := Fold(recs, models.MetricsQuery{From: t0, To: t0 + 300, GroupBy: "command"}, 300)
		if len(got) != 1 || len(got[0].Points) != 1 {
			t.Fatalf("want 1 point at 5m resolution, got %+v", got)
		}
		if got[0].Points[0].RSSAvg != 300 {
			t.Errorf("RSSAvg = %d, want 300", got[0].Points[0].RSSAvg)
		}
		if got[0].Points[0].RSSPeak != 1000 {
			t.Errorf("RSSPeak = %d, want 1000 (max across minutes)", got[0].Points[0].RSSPeak)
		}
		if got[0].Points[0].N != 100 {
			t.Errorf("N = %d, want 100 (5 minutes x 20 samples)", got[0].Points[0].N)
		}
	})

	t.Run("partial buckets are weighted by N", func(t *testing.T) {
		recs := []models.SampleRecord{
			{T: t0, CmdID: "c1", N: 20, RSSAvg: 100},
			{T: t0 + 60, CmdID: "c1", N: 4, RSSAvg: 200}, // a shutdown tail
		}
		got := Fold(recs, models.MetricsQuery{From: t0, To: t0 + 300, GroupBy: "command"}, 300)
		// (20*100 + 4*200) / 24 = 2800/24 = 116.67 -> 117
		if want := int64(117); got[0].Points[0].RSSAvg != want {
			t.Errorf("weighted avg = %d, want %d (an unweighted mean would be 150)", got[0].Points[0].RSSAvg, want)
		}
	})

	t.Run("gaps produce no point, not a zero", func(t *testing.T) {
		recs := []models.SampleRecord{
			full(t0, "c1", "p1", 100, 1),
			full(t0+600, "c1", "p1", 100, 1), // 10 minutes later
		}
		got := Fold(recs, models.MetricsQuery{From: t0, To: t0 + 900, GroupBy: "command"}, 60)
		if len(got[0].Points) != 2 {
			t.Errorf("want exactly 2 points with a gap between them, got %d", len(got[0].Points))
		}
	})

	t.Run("records outside the range are dropped", func(t *testing.T) {
		recs := []models.SampleRecord{
			full(t0-60, "c1", "p1", 100, 1),
			full(t0, "c1", "p1", 100, 1),
			full(t0+120, "c1", "p1", 100, 1),
		}
		got := Fold(recs, models.MetricsQuery{From: t0, To: t0 + 60, GroupBy: "command"}, 60)
		if len(got[0].Points) != 1 {
			t.Errorf("want 1 in-range point, got %d", len(got[0].Points))
		}
	})

	t.Run("cmdIds filter applies", func(t *testing.T) {
		recs := []models.SampleRecord{
			full(t0, "c1", "p1", 100, 1),
			full(t0, "c2", "p1", 100, 1),
		}
		req := models.MetricsQuery{From: t0, To: t0 + 60, GroupBy: "command", CmdIDs: []string{"c2"}}
		got := Fold(recs, req, 60)
		if len(got) != 1 || got[0].Key != "c2" {
			t.Errorf("want only c2, got %+v", got)
		}
	})

	t.Run("empty input yields no series", func(t *testing.T) {
		if got := Fold(nil, models.MetricsQuery{From: t0, To: t0 + 60}, 60); len(got) != 0 {
			t.Errorf("want no series, got %+v", got)
		}
	})

	t.Run("sub-minute resolution is floored to one minute", func(t *testing.T) {
		got := Fold(
			[]models.SampleRecord{full(t0, "c1", "p1", 100, 1)},
			models.MetricsQuery{From: t0, To: t0 + 60, GroupBy: "command"},
			1,
		)
		if got[0].Points[0].T != t0 {
			t.Errorf("bucket start = %d, want %d", got[0].Points[0].T, t0)
		}
	})

	t.Run("unattributed samples group together", func(t *testing.T) {
		recs := []models.SampleRecord{
			{T: t0, CmdID: "c1", N: 20, RSSAvg: 100},
			{T: t0, CmdID: "c2", N: 20, RSSAvg: 50},
		}
		got := Fold(recs, models.MetricsQuery{From: t0, To: t0 + 60, GroupBy: "project"}, 60)
		if len(got) != 1 || got[0].Key != unattributedKey {
			t.Fatalf("want one unattributed series, got %+v", got)
		}
		if got[0].Points[0].RSSAvg != 150 {
			t.Errorf("RSSAvg = %d, want 150", got[0].Points[0].RSSAvg)
		}
	})
}

func TestTopSeries(t *testing.T) {
	mk := func(key string, peak int64) models.MetricsSeries {
		return models.MetricsSeries{Key: key, PeakRSS: peak}
	}

	t.Run("under the cap passes through", func(t *testing.T) {
		in := []models.MetricsSeries{mk("a", 1), mk("b", 2)}
		got, omitted := TopSeries(in, 5)
		if omitted != 0 || len(got) != 2 {
			t.Errorf("got %d series, %d omitted", len(got), omitted)
		}
	})

	t.Run("keeps the heaviest and reports the rest", func(t *testing.T) {
		in := []models.MetricsSeries{mk("a", 10), mk("b", 50), mk("c", 30), mk("d", 5)}
		got, omitted := TopSeries(in, 2)
		if omitted != 2 {
			t.Errorf("omitted = %d, want 2", omitted)
		}
		keys := []string{got[0].Key, got[1].Key}
		if !reflect.DeepEqual(keys, []string{"b", "c"}) {
			t.Errorf("kept %v, want [b c] (sorted by key after ranking)", keys)
		}
	})

	t.Run("ties break on key so order is stable", func(t *testing.T) {
		in := []models.MetricsSeries{mk("z", 10), mk("a", 10), mk("m", 10)}
		first, _ := TopSeries(in, 2)
		second, _ := TopSeries(in, 2)
		if !reflect.DeepEqual(first, second) {
			t.Error("repeated calls returned different orders")
		}
		if first[0].Key != "a" {
			t.Errorf("tie-break kept %q first, want \"a\"", first[0].Key)
		}
	})

	t.Run("zero max is treated as no cap", func(t *testing.T) {
		in := []models.MetricsSeries{mk("a", 1), mk("b", 2)}
		if got, omitted := TopSeries(in, 0); len(got) != 2 || omitted != 0 {
			t.Errorf("got %d series, %d omitted", len(got), omitted)
		}
	})
}

func TestNormalizeQuery(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	nowUnix := now.Unix()

	t.Run("defaults are applied", func(t *testing.T) {
		got := normalizeQuery(models.MetricsQuery{From: nowUnix - 3600, To: nowUnix}, now, 365)
		if got.GroupBy != "command" {
			t.Errorf("GroupBy = %q, want command", got.GroupBy)
		}
		if got.MaxPoints != defaultMaxPoints {
			t.Errorf("MaxPoints = %d, want %d", got.MaxPoints, defaultMaxPoints)
		}
		if got.MaxSeries != defaultMaxSeries {
			t.Errorf("MaxSeries = %d, want %d", got.MaxSeries, defaultMaxSeries)
		}
		if got.Resolution != 60 {
			t.Errorf("Resolution = %d, want 60", got.Resolution)
		}
	})

	t.Run("reversed range is swapped", func(t *testing.T) {
		got := normalizeQuery(models.MetricsQuery{From: nowUnix, To: nowUnix - 3600}, now, 365)
		if got.From >= got.To {
			t.Errorf("range not swapped: %d..%d", got.From, got.To)
		}
	})

	t.Run("To is capped at now", func(t *testing.T) {
		got := normalizeQuery(models.MetricsQuery{From: nowUnix - 60, To: nowUnix + 999999}, now, 365)
		if got.To != nowUnix {
			t.Errorf("To = %d, want %d", got.To, nowUnix)
		}
	})

	t.Run("From is floored at the retention window", func(t *testing.T) {
		got := normalizeQuery(models.MetricsQuery{From: 0, To: nowUnix}, now, 7)
		floor := now.AddDate(0, 0, -7).Unix()
		if got.From != floor {
			t.Errorf("From = %d, want the 7-day floor %d", got.From, floor)
		}
	})

	t.Run("maxPoints is capped", func(t *testing.T) {
		got := normalizeQuery(models.MetricsQuery{From: nowUnix - 60, To: nowUnix, MaxPoints: 99999}, now, 365)
		if got.MaxPoints != maxMaxPoints {
			t.Errorf("MaxPoints = %d, want %d", got.MaxPoints, maxMaxPoints)
		}
	})

	t.Run("explicit resolution is respected", func(t *testing.T) {
		got := normalizeQuery(models.MetricsQuery{From: nowUnix - 86400, To: nowUnix, Resolution: 3600}, now, 365)
		if got.Resolution != 3600 {
			t.Errorf("Resolution = %d, want 3600", got.Resolution)
		}
	})

	t.Run("unknown groupBy falls back to command", func(t *testing.T) {
		got := normalizeQuery(models.MetricsQuery{From: nowUnix - 60, To: nowUnix, GroupBy: "hostname"}, now, 365)
		if got.GroupBy != "command" {
			t.Errorf("GroupBy = %q, want command", got.GroupBy)
		}
	})
}

func TestDayKeys(t *testing.T) {
	utc := time.UTC

	tests := []struct {
		name string
		from time.Time
		to   time.Time
		want []string
	}{
		{
			name: "same day",
			from: time.Date(2026, 8, 6, 1, 0, 0, 0, utc),
			to:   time.Date(2026, 8, 6, 23, 0, 0, 0, utc),
			want: []string{"2026-08-06"},
		},
		{
			name: "spanning midnight",
			from: time.Date(2026, 8, 6, 23, 30, 0, 0, utc),
			to:   time.Date(2026, 8, 7, 0, 30, 0, 0, utc),
			want: []string{"2026-08-06", "2026-08-07"},
		},
		{
			name: "three days",
			from: time.Date(2026, 8, 6, 0, 0, 0, 0, utc),
			to:   time.Date(2026, 8, 8, 0, 0, 0, 0, utc),
			want: []string{"2026-08-06", "2026-08-07", "2026-08-08"},
		},
		{
			name: "identical timestamps yield one day",
			from: time.Date(2026, 8, 6, 5, 0, 0, 0, utc),
			to:   time.Date(2026, 8, 6, 5, 0, 0, 0, utc),
			want: []string{"2026-08-06"},
		},
		{
			name: "crossing a month boundary",
			from: time.Date(2026, 8, 31, 12, 0, 0, 0, utc),
			to:   time.Date(2026, 9, 1, 12, 0, 0, 0, utc),
			want: []string{"2026-08-31", "2026-09-01"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := dayKeys(tt.from.Unix(), tt.to.Unix(), utc)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("dayKeys() = %v, want %v", got, tt.want)
			}
		})
	}

	t.Run("reversed range still works", func(t *testing.T) {
		a := time.Date(2026, 8, 8, 0, 0, 0, 0, utc).Unix()
		b := time.Date(2026, 8, 6, 0, 0, 0, 0, utc).Unix()
		if got := dayKeys(a, b, utc); len(got) != 3 {
			t.Errorf("dayKeys() = %v, want 3 days", got)
		}
	})

	t.Run("spanning a DST transition in a real zone", func(t *testing.T) {
		ny, err := time.LoadLocation("America/New_York")
		if err != nil {
			t.Skip("tzdata unavailable")
		}
		// US DST began 2026-03-08.
		from := time.Date(2026, 3, 7, 12, 0, 0, 0, ny)
		to := time.Date(2026, 3, 9, 12, 0, 0, 0, ny)
		want := []string{"2026-03-07", "2026-03-08", "2026-03-09"}
		if got := dayKeys(from.Unix(), to.Unix(), ny); !reflect.DeepEqual(got, want) {
			t.Errorf("dayKeys() across DST = %v, want %v", got, want)
		}
	})
}

func TestParseDayFileName(t *testing.T) {
	tests := []struct {
		name     string
		in       string
		wantKind string
		wantDay  string
		wantOK   bool
	}{
		{"samples file", "samples-2026-08-06.jsonl", "samples", "2026-08-06", true},
		{"runs file", "runs-2026-08-06.jsonl", "runs", "2026-08-06", true},
		{"wrong extension", "samples-2026-08-06.json", "", "", false},
		{"unknown kind", "traces-2026-08-06.jsonl", "", "", false},
		{"unparseable date", "samples-notadate.jsonl", "", "", false},
		{"impossible date", "samples-2026-13-45.jsonl", "", "", false},
		{"no date", "samples.jsonl", "", "", false},
		{"unrelated file", "README.md", "", "", false},
		{"empty", "", "", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kind, day, ok := parseDayFileName(tt.in)
			if kind != tt.wantKind || day != tt.wantDay || ok != tt.wantOK {
				t.Errorf("parseDayFileName(%q) = (%q, %q, %v), want (%q, %q, %v)",
					tt.in, kind, day, ok, tt.wantKind, tt.wantDay, tt.wantOK)
			}
		})
	}
}

func TestExpiredFiles(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)

	names := []string{
		"samples-2026-08-10.jsonl", // today
		"samples-2026-08-09.jsonl",
		"samples-2026-08-05.jsonl",
		"samples-2026-07-01.jsonl",
		"runs-2026-07-01.jsonl",
		"README.md",
		"samples-garbage.jsonl",
		"notes.txt",
	}

	t.Run("retention 7 keeps the last week", func(t *testing.T) {
		got := expiredFiles(names, 7, now)
		want := []string{"runs-2026-07-01.jsonl", "samples-2026-07-01.jsonl"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("expiredFiles() = %v, want %v", got, want)
		}
	})

	t.Run("retention 1 keeps only today", func(t *testing.T) {
		got := expiredFiles(names, 1, now)
		for _, name := range got {
			if name == "samples-2026-08-10.jsonl" {
				t.Error("today's file must never expire")
			}
		}
		if len(got) != 4 {
			t.Errorf("expiredFiles() = %v, want 4 entries", got)
		}
	})

	t.Run("unrecognised names are never selected", func(t *testing.T) {
		for _, name := range expiredFiles(names, 1, now) {
			switch name {
			case "README.md", "notes.txt", "samples-garbage.jsonl":
				t.Errorf("would have deleted %q, which this package did not write", name)
			}
		}
	})

	t.Run("zero retention is treated as one day", func(t *testing.T) {
		got := expiredFiles(names, 0, now)
		for _, name := range got {
			if name == "samples-2026-08-10.jsonl" {
				t.Error("today's file must never expire")
			}
		}
	})

	t.Run("long retention expires nothing", func(t *testing.T) {
		if got := expiredFiles(names, 3650, now); len(got) != 0 {
			t.Errorf("expiredFiles() = %v, want none", got)
		}
	})
}

func TestFoldRuns(t *testing.T) {
	utc := time.UTC
	now := time.Date(2026, 8, 10, 15, 0, 0, 0, utc)

	at := func(day int, ok, stopped bool) models.RunRecord {
		return models.RunRecord{
			T:       time.Date(2026, 8, day, 10, 0, 0, 0, utc).Unix(),
			DurMS:   1000,
			OK:      ok,
			Stopped: stopped,
		}
	}

	t.Run("dense zero-filled range", func(t *testing.T) {
		got := foldRuns(nil, 7, now, utc)
		if len(got.Days) != 7 {
			t.Fatalf("len(Days) = %d, want 7", len(got.Days))
		}
		if got.From != "2026-08-04" || got.To != "2026-08-10" {
			t.Errorf("range = %s..%s, want 2026-08-04..2026-08-10", got.From, got.To)
		}
		if got.Max != 0 || got.Total != 0 {
			t.Errorf("empty input should give Max/Total 0, got %d/%d", got.Max, got.Total)
		}
	})

	t.Run("success, failure and stopped are counted separately", func(t *testing.T) {
		recs := []models.RunRecord{
			at(10, true, false),
			at(10, true, false),
			at(10, false, false),
			at(10, false, true), // stopped: non-zero exit, but not a failure
		}
		got := foldRuns(recs, 7, now, utc)
		today := got.Days[6]
		if today.Total != 4 || today.Success != 2 || today.Fail != 1 || today.Stopped != 1 {
			t.Errorf("today = %+v, want total 4 / ok 2 / fail 1 / stopped 1", today)
		}
		if today.DurMS != 4000 {
			t.Errorf("DurMS = %d, want 4000", today.DurMS)
		}
	})

	t.Run("runs outside the window are ignored", func(t *testing.T) {
		recs := []models.RunRecord{
			at(1, true, false), // 9 days before the 7-day window starts
			at(10, true, false),
		}
		got := foldRuns(recs, 7, now, utc)
		if got.Total != 1 {
			t.Errorf("Total = %d, want 1", got.Total)
		}
	})

	t.Run("Max is the busiest day", func(t *testing.T) {
		recs := []models.RunRecord{
			at(8, true, false),
			at(10, true, false), at(10, true, false), at(10, true, false),
		}
		got := foldRuns(recs, 7, now, utc)
		if got.Max != 3 || got.Total != 4 {
			t.Errorf("Max/Total = %d/%d, want 3/4", got.Max, got.Total)
		}
	})

	t.Run("zero days is treated as one", func(t *testing.T) {
		if got := foldRuns(nil, 0, now, utc); len(got.Days) != 1 {
			t.Errorf("len(Days) = %d, want 1", len(got.Days))
		}
	})

	t.Run("a full year is dense", func(t *testing.T) {
		got := foldRuns(nil, 365, now, utc)
		if len(got.Days) != 365 {
			t.Errorf("len(Days) = %d, want 365", len(got.Days))
		}
		if got.Days[364].Date != "2026-08-10" {
			t.Errorf("last day = %s, want today", got.Days[364].Date)
		}
	})
}

func TestFrequencyResolution(t *testing.T) {
	const hour, day = int64(3600), int64(86400)

	tests := []struct {
		name string
		span int64
		want int
	}{
		{"24h gets hourly columns", day, 3600},
		{"two days still hourly", 2 * day, 3600},
		{"a week gets six-hour columns", 7 * day, 6 * 3600},
		{"a month gets daily columns", 30 * day, 86400},
		{"three months daily", 90 * day, 86400},
		{"a year gets weekly columns", 365 * day, 7 * 86400},
		{"one hour still hourly", hour, 3600},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := frequencyResolution(0, tt.span); got != tt.want {
				t.Errorf("frequencyResolution(span=%d) = %d, want %d", tt.span, got, tt.want)
			}
		})
	}
}

func TestFoldRunFrequency(t *testing.T) {
	const t0 = int64(1_699_999_200) // hour-aligned

	run := func(t int64, cmd, label, proj, grp string) models.RunRecord {
		return models.RunRecord{T: t, CmdID: cmd, Label: label, Project: proj, Group: grp, OK: true}
	}

	t.Run("counts runs per bucket", func(t *testing.T) {
		recs := []models.RunRecord{
			run(t0, "c1", "Build", "p1", "Android"),
			run(t0+10, "c1", "Build", "p1", "Android"),
			run(t0+3600, "c1", "Build", "p1", "Android"),
		}
		got := FoldRunFrequency(recs, models.MetricsQuery{From: t0, To: t0 + 7200, GroupBy: "command"}, 3600)
		if len(got) != 1 {
			t.Fatalf("want 1 series, got %d", len(got))
		}
		if got[0].Total != 3 {
			t.Errorf("Total = %d, want 3", got[0].Total)
		}
		counts := []int{got[0].Points[0].Count, got[0].Points[1].Count}
		if counts[0] != 2 || counts[1] != 1 {
			t.Errorf("counts = %v, want [2 1]", counts)
		}
	})

	t.Run("empty buckets are explicit zeros, not gaps", func(t *testing.T) {
		// A stacked frequency chart must show "not run" as zero; a gap would
		// read as missing data.
		recs := []models.RunRecord{
			run(t0, "c1", "Build", "p1", "g"),
			run(t0, "c2", "Test", "p1", "g"),
			run(t0+3600, "c1", "Build", "p1", "g"),
		}
		got := FoldRunFrequency(recs, models.MetricsQuery{From: t0, To: t0 + 7200, GroupBy: "command"}, 3600)
		if len(got) != 2 {
			t.Fatalf("want 2 series, got %d", len(got))
		}
		for _, ser := range got {
			if len(ser.Points) != 2 {
				t.Fatalf("%s has %d points, want 2 aligned buckets", ser.Key, len(ser.Points))
			}
		}
		// c2 ran only in the first bucket.
		for _, ser := range got {
			if ser.Key == "c2" && ser.Points[1].Count != 0 {
				t.Errorf("c2 second bucket = %d, want an explicit 0", ser.Points[1].Count)
			}
		}
	})

	t.Run("every series shares the same bucket axis", func(t *testing.T) {
		recs := []models.RunRecord{
			run(t0, "c1", "Build", "p1", "g"),
			run(t0+7200, "c2", "Test", "p1", "g"),
		}
		got := FoldRunFrequency(recs, models.MetricsQuery{From: t0, To: t0 + 10800, GroupBy: "command"}, 3600)
		axis := make([]int64, 0)
		for _, p := range got[0].Points {
			axis = append(axis, p.T)
		}
		for _, ser := range got[1:] {
			for i, p := range ser.Points {
				if p.T != axis[i] {
					t.Fatalf("series %s bucket %d = %d, want %d", ser.Key, i, p.T, axis[i])
				}
			}
		}
	})

	t.Run("groups by project", func(t *testing.T) {
		recs := []models.RunRecord{
			run(t0, "c1", "Build", "p1", "Android"),
			run(t0, "c2", "Test", "p1", "Android"),
			run(t0, "c3", "Serve", "p2", "Web"),
		}
		got := FoldRunFrequency(recs, models.MetricsQuery{From: t0, To: t0 + 3600, GroupBy: "project"}, 3600)
		if len(got) != 2 {
			t.Fatalf("want 2 project series, got %d", len(got))
		}
		for _, ser := range got {
			want := 2
			if ser.Key == "p2" {
				want = 1
			}
			if ser.Total != want {
				t.Errorf("%s total = %d, want %d", ser.Key, ser.Total, want)
			}
		}
	})

	t.Run("out-of-range runs are dropped", func(t *testing.T) {
		recs := []models.RunRecord{
			run(t0-3600, "c1", "Build", "p1", "g"),
			run(t0, "c1", "Build", "p1", "g"),
		}
		got := FoldRunFrequency(recs, models.MetricsQuery{From: t0, To: t0 + 3600, GroupBy: "command"}, 3600)
		if got[0].Total != 1 {
			t.Errorf("Total = %d, want 1", got[0].Total)
		}
	})

	t.Run("filters apply", func(t *testing.T) {
		recs := []models.RunRecord{
			run(t0, "c1", "Build", "p1", "g"),
			run(t0, "c2", "Test", "p2", "g"),
		}
		req := models.MetricsQuery{From: t0, To: t0 + 3600, GroupBy: "command", ProjectID: "p2"}
		got := FoldRunFrequency(recs, req, 3600)
		if len(got) != 1 || got[0].Key != "c2" {
			t.Errorf("want only c2, got %+v", got)
		}
	})

	t.Run("no runs yields no series", func(t *testing.T) {
		if got := FoldRunFrequency(nil, models.MetricsQuery{From: t0, To: t0 + 3600}, 3600); len(got) != 0 {
			t.Errorf("want no series, got %+v", got)
		}
	})
}

func TestTopFrequencySeries(t *testing.T) {
	mk := func(key string, total int) models.FrequencySeries {
		return models.FrequencySeries{Key: key, Total: total}
	}

	t.Run("under the cap passes through", func(t *testing.T) {
		got, omitted := TopFrequencySeries([]models.FrequencySeries{mk("a", 1)}, 5)
		if len(got) != 1 || omitted != 0 {
			t.Errorf("got %d series, %d omitted", len(got), omitted)
		}
	})

	t.Run("keeps the most-run and reports the rest", func(t *testing.T) {
		in := []models.FrequencySeries{mk("a", 1), mk("b", 90), mk("c", 40), mk("d", 2)}
		got, omitted := TopFrequencySeries(in, 2)
		if omitted != 2 {
			t.Errorf("omitted = %d, want 2", omitted)
		}
		if got[0].Key != "b" || got[1].Key != "c" {
			t.Errorf("kept %s and %s, want b and c", got[0].Key, got[1].Key)
		}
	})

	t.Run("ties are stable across calls", func(t *testing.T) {
		in := []models.FrequencySeries{mk("z", 5), mk("a", 5), mk("m", 5)}
		first, _ := TopFrequencySeries(in, 2)
		second, _ := TopFrequencySeries(in, 2)
		if first[0].Key != second[0].Key || first[1].Key != second[1].Key {
			t.Error("ordering changed between identical calls")
		}
	})
}
