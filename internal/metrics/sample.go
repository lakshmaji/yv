package metrics

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"yv/internal/models"
)

// Sample data generation for development.
//
// A spec file describes a handful of commands and their rough behaviour;
// ExpandSample turns that into the minute-bucketed sample records and run
// records the dashboard reads. Storing a spec rather than the expanded records
// keeps the checked-in file a few kilobytes instead of tens of megabytes.
//
// Expansion is deterministic: the spec carries a seed and the generator uses
// its own LCG, so the same spec always produces the same charts.

// maxSampleRecords bounds a spec so a typo in `days` cannot try to write
// millions of lines.
const maxSampleRecords = 400_000

// SampleCommand describes one synthetic command's resource profile.
type SampleCommand struct {
	CmdID     string `json:"cmdId"`
	Label     string `json:"label"`
	ProjectID string `json:"projectId"`
	Group     string `json:"group"`

	// Resource envelope. Each sample lands in [base, base+var).
	RSSBaseMB int     `json:"rssBaseMb"`
	RSSVarMB  int     `json:"rssVarMb"`
	CPUBase   float64 `json:"cpuBase"`
	CPUVar    float64 `json:"cpuVar"`

	// Hours of the local day this command is typically busy, [from, to).
	ActiveFrom int `json:"activeFrom"`
	ActiveTo   int `json:"activeTo"`

	// Chance in [0,1] that the command runs at all on a given day.
	ActiveDayChance float64 `json:"activeDayChance"`

	// Run records generated per active day, and the share of those that fail
	// or are stopped by the user.
	RunsPerActiveDay int     `json:"runsPerActiveDay"`
	FailRate         float64 `json:"failRate"`
	StoppedRate      float64 `json:"stoppedRate"`
}

// SampleSpec is the root of a sample data file.
type SampleSpec struct {
	Days        int             `json:"days"`
	StepSeconds int             `json:"stepSeconds"`
	Seed        int64           `json:"seed"`
	Commands    []SampleCommand `json:"commands"`
}

// --- pure helpers (unit tested) ---

// rng is a small deterministic linear congruential generator. math/rand would
// work too, but an explicit one keeps generated data stable across Go releases.
type rng struct{ state uint64 }

func newRNG(seed int64) *rng {
	s := uint64(seed)
	if s == 0 {
		s = 1
	}
	return &rng{state: s}
}

// next returns a float in [0, 1).
func (r *rng) next() float64 {
	r.state = r.state*6364136223846793005 + 1442695040888963407
	return float64(r.state>>11) / float64(1<<53)
}

// between returns a float in [lo, hi).
func (r *rng) between(lo, hi float64) float64 {
	if hi <= lo {
		return lo
	}
	return lo + r.next()*(hi-lo)
}

// normalizeSpec applies defaults and clamps a spec into a usable range.
func normalizeSpec(spec SampleSpec) SampleSpec {
	out := spec
	if out.Days <= 0 {
		out.Days = 90
	}
	if out.StepSeconds < minResolution {
		// One point per 5 minutes matches the finest bucket the dashboard
		// actually renders (a 24h range resolves to 300s), so a finer step
		// would multiply the file size for no visible gain.
		out.StepSeconds = 300
	}
	out.StepSeconds -= out.StepSeconds % minResolution

	for i := range out.Commands {
		c := &out.Commands[i]
		if c.ActiveTo <= c.ActiveFrom {
			c.ActiveFrom, c.ActiveTo = 9, 18
		}
		if c.ActiveFrom < 0 {
			c.ActiveFrom = 0
		}
		if c.ActiveTo > 24 {
			c.ActiveTo = 24
		}
		if c.ActiveDayChance <= 0 {
			c.ActiveDayChance = 1
		}
		if c.RSSBaseMB <= 0 {
			c.RSSBaseMB = 128
		}
	}
	return out
}

// ExpandSample turns a spec into the records that back the dashboard, covering
// the `days` days ending on the local day of `now`.
//
// Records are generated only inside each command's active hours and only on
// days it "ran", which is what produces gaps in the charts and a realistically
// patchy activity calendar rather than a solid block.
func ExpandSample(spec SampleSpec, now time.Time) ([]models.SampleRecord, []models.RunRecord, error) {
	s := normalizeSpec(spec)
	if len(s.Commands) == 0 {
		return nil, nil, fmt.Errorf("sample spec has no commands")
	}

	// Reject a spec that would write an unreasonable number of lines before
	// doing any work.
	var estimate int
	for _, c := range s.Commands {
		hours := c.ActiveTo - c.ActiveFrom
		estimate += s.Days * hours * 3600 / s.StepSeconds
	}
	if estimate > maxSampleRecords {
		return nil, nil, fmt.Errorf("sample spec would generate ~%d records, over the %d limit", estimate, maxSampleRecords)
	}

	r := newRNG(s.Seed)
	loc := now.Location()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	start := today.AddDate(0, 0, -(s.Days - 1))

	samples := make([]models.SampleRecord, 0, estimate)
	runs := make([]models.RunRecord, 0, s.Days*len(s.Commands))

	// N per record: how many 3-second ticks a real run would have folded in.
	perRecord := s.StepSeconds / 3
	if perRecord < 1 {
		perRecord = 1
	}

	for d := 0; d < s.Days; d++ {
		day := start.AddDate(0, 0, d)

		for _, c := range s.Commands {
			if r.next() > c.ActiveDayChance {
				continue // idle day
			}

			dayStart := time.Date(day.Year(), day.Month(), day.Day(), c.ActiveFrom, 0, 0, 0, loc)
			dayEnd := time.Date(day.Year(), day.Month(), day.Day(), c.ActiveTo, 0, 0, 0, loc)

			// A drifting baseline gives each day its own shape instead of a
			// flat band of noise.
			drift := r.between(0.75, 1.25)

			for t := dayStart; t.Before(dayEnd); t = t.Add(time.Duration(s.StepSeconds) * time.Second) {
				if t.After(now) {
					break
				}
				rssMB := (float64(c.RSSBaseMB) + r.next()*float64(c.RSSVarMB)) * drift
				cpu := (c.CPUBase + r.next()*c.CPUVar) * drift

				rss := int64(rssMB * 1024 * 1024)
				samples = append(samples, models.SampleRecord{
					T:       t.Unix() - t.Unix()%minResolution,
					CmdID:   c.CmdID,
					Label:   c.Label,
					Project: c.ProjectID,
					Group:   c.Group,
					N:       perRecord,
					RSSAvg:  rss,
					RSSPeak: int64(float64(rss) * r.between(1.02, 1.3)),
					CPUAvg:  cpu,
					CPUPeak: cpu * r.between(1.05, 1.6),
				})
			}

			for i := 0; i < c.RunsPerActiveDay; i++ {
				at := dayStart.Add(time.Duration(r.next() * float64(dayEnd.Sub(dayStart))))
				if at.After(now) {
					continue
				}
				roll := r.next()
				rec := models.RunRecord{
					T:     at.Unix(),
					DurMS: int64(r.between(800, 240_000)),
					CmdID: c.CmdID,
					Label: c.Label, Project: c.ProjectID, Group: c.Group,
					RunID: fmt.Sprintf("sample-%d-%d", d, i),
				}
				switch {
				case roll < c.FailRate:
					rec.ExitCode = 1
					rec.Err = "sample failure"
				case roll < c.FailRate+c.StoppedRate:
					rec.ExitCode = 143
					rec.Stopped = true
				default:
					rec.OK = true
				}
				runs = append(runs, rec)
			}
		}
	}

	return samples, runs, nil
}

// ImportSample expands a spec and writes it into the day files, replacing any
// data already there. It ignores the enabled flag: seeding is an explicit
// developer action, not background collection.
func (s *Store) ImportSample(raw []byte, now time.Time) (int, int, error) {
	var spec SampleSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return 0, 0, fmt.Errorf("parse sample: %w", err)
	}

	samples, runs, err := ExpandSample(spec, now)
	if err != nil {
		return 0, 0, err
	}

	if err := s.Clear(); err != nil {
		return 0, 0, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Group by day so each file is opened once rather than per record.
	byDaySamples := make(map[string][]models.SampleRecord)
	for _, rec := range samples {
		day := time.Unix(rec.T, 0).Format(dayLayout)
		byDaySamples[day] = append(byDaySamples[day], rec)
	}
	byDayRuns := make(map[string][]models.RunRecord)
	for _, rec := range runs {
		day := time.Unix(rec.T, 0).Format(dayLayout)
		byDayRuns[day] = append(byDayRuns[day], rec)
	}

	dir, err := Dir()
	if err != nil {
		return 0, 0, err
	}

	for day, recs := range byDaySamples {
		if err := appendRecords(dir, sampleKind, day, recs); err != nil {
			return 0, 0, err
		}
	}
	for day, recs := range byDayRuns {
		if err := appendRecords(dir, runKind, day, recs); err != nil {
			return 0, 0, err
		}
	}

	// The open handles now point at files Clear removed; drop them so the next
	// real flush reopens against what we just wrote.
	s.closeFilesLocked()

	return len(samples), len(runs), nil
}

// appendRecords writes one day's records to its file in a single open.
func appendRecords[T any](dir, kind, day string, recs []T) error {
	path := filepath.Join(dir, fmt.Sprintf("%s-%s.jsonl", kind, day))
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	for _, rec := range recs {
		raw, err := json.Marshal(rec)
		if err != nil {
			continue
		}
		w.Write(raw)
		w.WriteByte('\n')
	}
	return w.Flush()
}
