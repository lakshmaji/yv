package monitor

import (
	"sync"
	"testing"
	"time"

	"yv/internal/models"
	"yv/internal/runner"
)

func TestParsePsOutput(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantLen int
		checks  []struct {
			pid      int
			rssBytes int64
			cpu      float64
		}
	}{
		{
			name:    "single process",
			input:   "  1234  4096  0.5",
			wantLen: 1,
			checks: []struct {
				pid      int
				rssBytes int64
				cpu      float64
			}{
				{pid: 1234, rssBytes: 4096 * 1024, cpu: 0.5},
			},
		},
		{
			name:    "multiple processes",
			input:   "  1  2048  1.0\n  2  8192  2.5\n  3  512   0.0",
			wantLen: 3,
			checks: []struct {
				pid      int
				rssBytes int64
				cpu      float64
			}{
				{pid: 1, rssBytes: 2048 * 1024, cpu: 1.0},
				{pid: 2, rssBytes: 8192 * 1024, cpu: 2.5},
				{pid: 3, rssBytes: 512 * 1024, cpu: 0.0},
			},
		},
		{
			name:    "empty output",
			input:   "",
			wantLen: 0,
		},
		{
			name:    "header-only line skipped",
			input:   "  PID   RSS  %CPU\n  99  1024  0.1",
			wantLen: 1, // PID line fails Atoi, only pid 99 parsed
		},
		{
			name:    "short line skipped",
			input:   "  1234  4096\n  5678  1024  0.3",
			wantLen: 1, // first line has only 2 fields
			checks: []struct {
				pid      int
				rssBytes int64
				cpu      float64
			}{
				{pid: 5678, rssBytes: 1024 * 1024, cpu: 0.3},
			},
		},
		{
			name:    "whitespace-only output",
			input:   "   \n   ",
			wantLen: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := parsePsOutput(tc.input)
			if len(result) != tc.wantLen {
				t.Fatalf("len = %d, want %d; result = %v", len(result), tc.wantLen, result)
			}
			for _, c := range tc.checks {
				row, ok := result[c.pid]
				if !ok {
					t.Errorf("pid %d not found in result", c.pid)
					continue
				}
				if row.rss != c.rssBytes {
					t.Errorf("pid %d rss = %d, want %d", c.pid, row.rss, c.rssBytes)
				}
				if row.cpu != c.cpu {
					t.Errorf("pid %d cpu = %v, want %v", c.pid, row.cpu, c.cpu)
				}
			}
		})
	}
}

// countingSink records how many times Observe was called.
type countingSink struct {
	mu sync.Mutex
	n  int
}

func (c *countingSink) Observe(_ time.Time, _ models.ResourceStats) {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
}

func (c *countingSink) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// GetResourceStats is called from the UI on demand. Feeding the sink from there
// would inject extra samples into the current minute and skew the N-weighted
// averages the dashboard computes, so it must stay read-only.
func TestGetResourceStatsDoesNotFeedSink(t *testing.T) {
	sink := &countingSink{}
	m := NewMonitor(runner.NewRunner(), sink)

	for i := 0; i < 3; i++ {
		m.GetResourceStats()
	}

	if got := sink.count(); got != 0 {
		t.Errorf("sink observed %d samples from GetResourceStats, want 0", got)
	}
}

func TestNilSinkIsSafe(t *testing.T) {
	m := NewMonitor(runner.NewRunner(), nil)
	if stats := m.GetResourceStats(); stats.AppRSS == 0 {
		t.Log("app RSS unavailable in this environment; the point is that it did not panic")
	}
}
