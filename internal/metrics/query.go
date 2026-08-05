package metrics

import (
	"sort"
	"strings"
	"time"

	"yv/internal/models"
)

// Reserved series keys. Command IDs are UUID-ish, so these cannot collide with
// a real one, but the reader treats them as reserved explicitly rather than by
// luck.
const (
	// AppCmdID is the pseudo-command under which the app's own RSS/CPU is stored.
	AppCmdID = "__app__"
	// unattributedKey groups samples whose project/group metadata was lost.
	unattributedKey   = "__unattributed__"
	unattributedLabel = "Unattributed"
)

// Query defaults and caps. A dashboard request can never ask for more than
// these, so a year-long range still returns a bounded payload.
const (
	defaultMaxPoints = 500
	maxMaxPoints     = 2000
	defaultMaxSeries = 12
	minResolution    = 60 // we have no data finer than one minute
)

// resolutionSteps are the bucket sizes autoResolution may choose, in seconds:
// 1m, 5m, 15m, 1h, 6h, 1d, 1w, 30d.
//
// The week and month steps matter for a low maxPoints: without them a
// year-long range saturates at daily buckets and still returns 365 points,
// which the bubble chart cannot draw legibly.
var resolutionSteps = []int{60, 300, 900, 3600, 21600, 86400, 604800, 2592000}

// --- pure helpers (unit tested) ---

// autoResolution picks the smallest step that keeps the range under maxPoints
// buckets. Ranges too long for the largest step still get the largest step —
// the point cap is then enforced by the caller trimming, not by inventing a
// finer bucket.
func autoResolution(from, to int64, maxPoints int) int {
	if maxPoints <= 0 {
		maxPoints = defaultMaxPoints
	}
	span := to - from
	if span <= 0 {
		return minResolution
	}
	for _, step := range resolutionSteps {
		if span/int64(step) <= int64(maxPoints) {
			return step
		}
	}
	return resolutionSteps[len(resolutionSteps)-1]
}

// groupKey maps one record's attribution to the series it belongs to under
// groupBy. An unrecognised groupBy falls back to per-command, which is the
// finest grouping and therefore never loses information.
//
// Samples and runs share this so the two charts always agree on what a
// "series" is.
func groupKey(cmdID, label, project, group, groupBy string) (key, lbl string) {
	switch groupBy {
	case "project":
		if project == "" {
			return unattributedKey, unattributedLabel
		}
		return project, project
	case "group":
		if group == "" {
			return unattributedKey, unattributedLabel
		}
		return group, group
	default: // "command"
		if label == "" {
			label = cmdID
		}
		return cmdID, label
	}
}

func seriesKey(rec models.SampleRecord, groupBy string) (key, label string) {
	return groupKey(rec.CmdID, rec.Label, rec.Project, rec.Group, groupBy)
}

func runSeriesKey(rec models.RunRecord, groupBy string) (key, label string) {
	return groupKey(rec.CmdID, rec.Label, rec.Project, rec.Group, groupBy)
}

// runMatchesFilter mirrors matchesFilter for run records.
func runMatchesFilter(rec models.RunRecord, req models.MetricsQuery) bool {
	if req.ProjectID != "" && rec.Project != req.ProjectID {
		return false
	}
	if req.Group != "" && rec.Group != req.Group {
		return false
	}
	if len(req.CmdIDs) > 0 && !containsString(req.CmdIDs, rec.CmdID) {
		return false
	}
	return true
}

// FoldRunFrequency counts runs per series per time bucket.
//
// Unlike the resource fold, absent buckets are filled with an explicit zero:
// "this command was not run in that window" is real information, and a gap
// would misread as missing data on a stacked chart.
func FoldRunFrequency(records []models.RunRecord, req models.MetricsQuery, resolution int) []models.FrequencySeries {
	if resolution < minResolution {
		resolution = minResolution
	}

	type seriesData struct {
		label   string
		buckets map[int64]int
		total   int
	}
	byKey := make(map[string]*seriesData)
	slotSeen := make(map[int64]bool)

	for _, rec := range records {
		if rec.T < req.From || rec.T >= req.To {
			continue
		}
		if !runMatchesFilter(rec, req) {
			continue
		}

		key, label := runSeriesKey(rec, req.GroupBy)
		sd, ok := byKey[key]
		if !ok {
			sd = &seriesData{label: label, buckets: make(map[int64]int)}
			byKey[key] = sd
		}

		slot := rec.T - rec.T%int64(resolution)
		sd.buckets[slot]++
		sd.total++
		slotSeen[slot] = true
	}

	slots := make([]int64, 0, len(slotSeen))
	for slot := range slotSeen {
		slots = append(slots, slot)
	}
	sort.Slice(slots, func(i, j int) bool { return slots[i] < slots[j] })

	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make([]models.FrequencySeries, 0, len(keys))
	for _, key := range keys {
		sd := byKey[key]
		points := make([]models.FrequencyPoint, 0, len(slots))
		for _, slot := range slots {
			points = append(points, models.FrequencyPoint{T: slot, Count: sd.buckets[slot]})
		}
		out = append(out, models.FrequencySeries{
			Key: key, Label: sd.label, Points: points, Total: sd.total,
		})
	}
	return out
}

// TopFrequencySeries keeps the max most-run series, ranked by total.
func TopFrequencySeries(series []models.FrequencySeries, max int) ([]models.FrequencySeries, int) {
	if max <= 0 || len(series) <= max {
		return series, 0
	}
	ranked := make([]models.FrequencySeries, len(series))
	copy(ranked, series)
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].Total != ranked[j].Total {
			return ranked[i].Total > ranked[j].Total
		}
		return ranked[i].Key < ranked[j].Key
	})
	kept := ranked[:max]
	sort.Slice(kept, func(i, j int) bool { return kept[i].Key < kept[j].Key })
	return kept, len(series) - max
}

// matchesFilter reports whether a sample passes the query's filters. The app's
// own pseudo-command is excluded unless explicitly requested by ID.
func matchesFilter(rec models.SampleRecord, req models.MetricsQuery) bool {
	if rec.CmdID == AppCmdID && !containsString(req.CmdIDs, AppCmdID) {
		return false
	}
	if req.ProjectID != "" && rec.Project != req.ProjectID {
		return false
	}
	if req.Group != "" && rec.Group != req.Group {
		return false
	}
	if len(req.CmdIDs) > 0 && !containsString(req.CmdIDs, rec.CmdID) {
		return false
	}
	return true
}

func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

// minuteAgg is one series' totals for one minute: the sum across every command
// that rolls up into that series at that instant.
type minuteAgg struct {
	n       int
	rssSum  int64
	rssPeak int64
	cpuSum  float64
	cpuPeak float64
}

// Fold turns raw per-command minute records into per-series points at the
// requested resolution.
//
// It runs in two stages, and the distinction matters:
//
//  1. Across commands within one minute, values are SUMMED — a project's memory
//     is the total of its concurrently running commands, not their average.
//  2. Across minutes within one output bucket, values are AVERAGED, weighted by
//     each minute's sample count N, so a partial minute (say 4 samples at
//     shutdown) does not count the same as a full 20-sample one. Peaks are
//     maxed at both stages.
//
// Minutes with no data produce no point, so a chart shows a gap rather than a
// misleading zero.
func Fold(records []models.SampleRecord, req models.MetricsQuery, resolution int) []models.MetricsSeries {
	if resolution < minResolution {
		resolution = minResolution
	}

	// Stage 1: (series, minute) → summed values.
	type seriesData struct {
		label   string
		minutes map[int64]*minuteAgg
	}
	byKey := make(map[string]*seriesData)
	order := make([]string, 0)

	for _, rec := range records {
		if rec.T < req.From || rec.T >= req.To {
			continue
		}
		if !matchesFilter(rec, req) {
			continue
		}

		key, label := seriesKey(rec, req.GroupBy)
		sd, ok := byKey[key]
		if !ok {
			sd = &seriesData{label: label, minutes: make(map[int64]*minuteAgg)}
			byKey[key] = sd
			order = append(order, key)
		}
		if sd.label == "" {
			sd.label = label
		}

		minute := rec.T - rec.T%minResolution
		agg, ok := sd.minutes[minute]
		if !ok {
			agg = &minuteAgg{}
			sd.minutes[minute] = agg
		}
		agg.rssSum += rec.RSSAvg
		agg.cpuSum += rec.CPUAvg
		if rec.RSSPeak > agg.rssPeak {
			agg.rssPeak = rec.RSSPeak
		}
		if rec.CPUPeak > agg.cpuPeak {
			agg.cpuPeak = rec.CPUPeak
		}
		if rec.N > agg.n {
			agg.n = rec.N
		}
	}

	// Stage 2: minutes → output buckets, N-weighted.
	sort.Strings(order)
	out := make([]models.MetricsSeries, 0, len(order))

	for _, key := range order {
		sd := byKey[key]

		type bucketAgg struct {
			weight  int
			rssWSum float64
			cpuWSum float64
			rssPeak int64
			cpuPeak float64
		}
		buckets := make(map[int64]*bucketAgg, len(sd.minutes))
		for minute, agg := range sd.minutes {
			slot := minute - minute%int64(resolution)
			b, ok := buckets[slot]
			if !ok {
				b = &bucketAgg{}
				buckets[slot] = b
			}
			w := agg.n
			if w <= 0 {
				w = 1
			}
			b.weight += w
			b.rssWSum += float64(agg.rssSum) * float64(w)
			b.cpuWSum += agg.cpuSum * float64(w)
			if agg.rssPeak > b.rssPeak {
				b.rssPeak = agg.rssPeak
			}
			if agg.cpuPeak > b.cpuPeak {
				b.cpuPeak = agg.cpuPeak
			}
		}

		slots := make([]int64, 0, len(buckets))
		for slot := range buckets {
			slots = append(slots, slot)
		}
		sort.Slice(slots, func(i, j int) bool { return slots[i] < slots[j] })

		series := models.MetricsSeries{
			Key:    key,
			Label:  sd.label,
			Points: make([]models.MetricsPoint, 0, len(slots)),
		}
		for _, slot := range slots {
			b := buckets[slot]
			pt := models.MetricsPoint{
				T:       slot,
				N:       b.weight,
				RSSAvg:  int64(b.rssWSum/float64(b.weight) + 0.5),
				RSSPeak: b.rssPeak,
				CPUAvg:  b.cpuWSum / float64(b.weight),
				CPUPeak: b.cpuPeak,
			}
			series.Points = append(series.Points, pt)
			if pt.RSSPeak > series.PeakRSS {
				series.PeakRSS = pt.RSSPeak
			}
			if pt.CPUPeak > series.PeakCPU {
				series.PeakCPU = pt.CPUPeak
			}
		}
		out = append(out, series)
	}

	return out
}

// TopSeries keeps the max heaviest series by peak RSS and reports how many were
// dropped. Ties break on Key so repeated polls return a stable order rather
// than a chart whose colours shuffle.
func TopSeries(series []models.MetricsSeries, max int) ([]models.MetricsSeries, int) {
	if max <= 0 || len(series) <= max {
		return series, 0
	}

	ranked := make([]models.MetricsSeries, len(series))
	copy(ranked, series)
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].PeakRSS != ranked[j].PeakRSS {
			return ranked[i].PeakRSS > ranked[j].PeakRSS
		}
		if ranked[i].PeakCPU != ranked[j].PeakCPU {
			return ranked[i].PeakCPU > ranked[j].PeakCPU
		}
		return ranked[i].Key < ranked[j].Key
	})

	kept := ranked[:max]
	// Restore the caller's (key-sorted) order so colour assignment is stable.
	sort.Slice(kept, func(i, j int) bool { return kept[i].Key < kept[j].Key })
	return kept, len(series) - max
}

// frequencyResolution picks a bucket for the usage-frequency chart. Runs are
// far sparser than resource samples, so the resource resolution would leave
// most columns at zero; these steps aim for roughly 12-40 populated buckets.
func frequencyResolution(from, to int64) int {
	const hour, day = 3600, 86400
	switch span := to - from; {
	case span <= 2*day:
		return hour
	case span <= 10*day:
		return 6 * hour
	case span <= 100*day:
		return day
	default:
		return 7 * day
	}
}

// normalizeQuery applies defaults and clamps a request into the supported
// range: reversed ranges are swapped, To is capped at now, From is floored at
// the retention window, and the point/series caps are enforced.
func normalizeQuery(req models.MetricsQuery, now time.Time, retentionDays int) models.MetricsQuery {
	out := req

	if out.From > out.To {
		out.From, out.To = out.To, out.From
	}
	nowUnix := now.Unix()
	if out.To <= 0 || out.To > nowUnix {
		out.To = nowUnix
	}
	if retentionDays <= 0 {
		retentionDays = 1
	}
	floor := now.AddDate(0, 0, -retentionDays).Unix()
	if out.From < floor {
		out.From = floor
	}
	if out.From >= out.To {
		out.From = out.To - int64(minResolution)
	}

	switch out.GroupBy {
	case "command", "project", "group":
	default:
		out.GroupBy = "command"
	}

	if out.MaxPoints <= 0 {
		out.MaxPoints = defaultMaxPoints
	}
	if out.MaxPoints > maxMaxPoints {
		out.MaxPoints = maxMaxPoints
	}
	if out.MaxSeries <= 0 {
		out.MaxSeries = defaultMaxSeries
	}
	if out.Resolution < minResolution {
		out.Resolution = autoResolution(out.From, out.To, out.MaxPoints)
	}

	return out
}

// --- day files ---

const dayLayout = "2006-01-02"

// dayKeys lists the day-file dates a [from, to) range touches, in ascending
// order. Day boundaries are local because the files are named in local time.
func dayKeys(from, to int64, loc *time.Location) []string {
	if loc == nil {
		loc = time.Local
	}
	if to < from {
		from, to = to, from
	}

	start := time.Unix(from, 0).In(loc)
	end := time.Unix(to, 0).In(loc)

	cur := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, loc)
	last := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, loc)

	out := make([]string, 0, 8)
	for !cur.After(last) {
		out = append(out, cur.Format(dayLayout))
		cur = cur.AddDate(0, 0, 1)
	}
	return out
}

// parseDayFileName recognises the files this package writes and nothing else,
// so pruning can never delete something another tool put in the directory.
func parseDayFileName(name string) (kind, day string, ok bool) {
	if !strings.HasSuffix(name, ".jsonl") {
		return "", "", false
	}
	stem := strings.TrimSuffix(name, ".jsonl")

	for _, k := range []string{sampleKind, runKind} {
		prefix := k + "-"
		if !strings.HasPrefix(stem, prefix) {
			continue
		}
		d := strings.TrimPrefix(stem, prefix)
		if _, err := time.Parse(dayLayout, d); err != nil {
			return "", "", false
		}
		return k, d, true
	}
	return "", "", false
}

// expiredFiles selects the day files that fall outside the retention window.
// Today's file is never expired, even at a retention of one day, and names this
// package does not recognise are left alone.
func expiredFiles(names []string, retentionDays int, now time.Time) []string {
	if retentionDays <= 0 {
		retentionDays = 1
	}
	cutoff := now.AddDate(0, 0, -(retentionDays - 1)).Format(dayLayout)

	out := make([]string, 0)
	for _, name := range names {
		_, day, ok := parseDayFileName(name)
		if !ok {
			continue
		}
		if day < cutoff {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// --- activity heatmap ---

// foldRuns buckets run records into a dense day range ending today. Days with
// no runs are present with zero counts so the frontend can lay out a fixed
// calendar grid without filling gaps itself.
func foldRuns(records []models.RunRecord, days int, now time.Time, loc *time.Location) models.ActivityHeatmap {
	if loc == nil {
		loc = time.Local
	}
	if days <= 0 {
		days = 1
	}

	today := time.Date(now.In(loc).Year(), now.In(loc).Month(), now.In(loc).Day(), 0, 0, 0, 0, loc)
	start := today.AddDate(0, 0, -(days - 1))

	index := make(map[string]int, days)
	out := models.ActivityHeatmap{
		From: start.Format(dayLayout),
		To:   today.Format(dayLayout),
		Days: make([]models.ActivityDay, 0, days),
	}
	for i := 0; i < days; i++ {
		d := start.AddDate(0, 0, i).Format(dayLayout)
		index[d] = i
		out.Days = append(out.Days, models.ActivityDay{Date: d})
	}

	for _, rec := range records {
		key := time.Unix(rec.T, 0).In(loc).Format(dayLayout)
		i, ok := index[key]
		if !ok {
			continue // outside the requested window
		}
		day := &out.Days[i]
		day.Total++
		day.DurMS += rec.DurMS
		switch {
		case rec.Stopped:
			day.Stopped++
		case rec.OK:
			day.Success++
		default:
			day.Fail++
		}
	}

	for _, d := range out.Days {
		out.Total += d.Total
		if d.Total > out.Max {
			out.Max = d.Total
		}
	}
	return out
}
