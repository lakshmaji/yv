package monitor

import (
	"testing"
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
