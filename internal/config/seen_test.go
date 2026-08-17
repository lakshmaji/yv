package config

import (
	"context"
	"os"
	"testing"

	"yv/internal/models"
)

func TestUnseenHits(t *testing.T) {
	tests := []struct {
		name string
		seen []models.ScanHit // marked first
		hits []models.ScanHit
		want []string // paths expected to survive
	}{
		{
			name: "nothing marked yet",
			hits: []models.ScanHit{{Path: "/a", Hash: "h1"}, {Path: "/b", Hash: "h2"}},
			want: []string{"/a", "/b"},
		},
		{
			name: "an answered file is silent",
			seen: []models.ScanHit{{Path: "/a", Hash: "h1"}},
			hits: []models.ScanHit{{Path: "/a", Hash: "h1"}, {Path: "/b", Hash: "h2"}},
			want: []string{"/b"},
		},
		{
			name: "an edited file is offered again",
			seen: []models.ScanHit{{Path: "/a", Hash: "h1"}},
			hits: []models.ScanHit{{Path: "/a", Hash: "CHANGED"}},
			want: []string{"/a"},
		},
		{
			name: "a broken file has no hash and keeps being reported",
			seen: []models.ScanHit{{Path: "/a", Hash: "h1"}},
			hits: []models.ScanHit{{Path: "/broken", Error: "cannot parse"}},
			want: []string{"/broken"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isolateHome(t)
			s := NewStore()
			s.MarkSeen(tt.seen)

			got := s.UnseenHits(tt.hits)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d hits, want %d (%v)", len(got), len(tt.want), tt.want)
			}
			for i, w := range tt.want {
				if got[i].Path != w {
					t.Errorf("[%d]: got %q, want %q", i, got[i].Path, w)
				}
			}
		})
	}
}

// Marking is what stops the four-hourly prompt. A file left unticked was still
// answered, so it must fall silent alongside the ones that were imported.
func TestMarkSeenSilencesSkippedFilesToo(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	shown := []models.ScanHit{
		{Path: "/imported", Hash: "h1"},
		{Path: "/skipped", Hash: "h2"},
	}
	s.MarkSeen(shown)

	if got := s.UnseenHits(shown); len(got) != 0 {
		t.Errorf("got %d hits still pending, want 0: %+v", len(got), got)
	}
}

// A missing or corrupt file is not an error worth surfacing: the worst outcome
// is one extra prompt.
func TestSeenSurvivesAGarbageFile(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	path, err := seenPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	hits := []models.ScanHit{{Path: "/a", Hash: "h1"}}
	if got := s.UnseenHits(hits); len(got) != 1 {
		t.Errorf("got %d, want 1 — a corrupt file must mean 'nothing answered yet'", len(got))
	}
	// And it must be repairable by the next write rather than staying broken.
	s.MarkSeen(hits)
	if got := s.UnseenHits(hits); len(got) != 0 {
		t.Error("marking did not take after a corrupt file was replaced")
	}
}

// The realistic sequence: scan, answer, rescan is quiet, edit one, rescan
// offers exactly that one.
func TestScanAnswerRescan(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	root := writeTree(t, map[string]string{
		"alpha/yv.yaml": cfg("alpha"),
		"beta/yv.yaml":  cfg("beta"),
	})

	first := s.ScanForConfigs(context.Background(), root)
	if len(s.UnseenHits(first.Hits)) != 2 {
		t.Fatalf("first scan: want both offered")
	}
	s.MarkSeen(first.Hits)

	second := s.ScanForConfigs(context.Background(), root)
	if got := s.UnseenHits(second.Hits); len(got) != 0 {
		t.Errorf("rescan offered %d files again: %+v", len(got), got)
	}

	// Editing one file makes exactly that one interesting again.
	edited := cfg("alpha") + "  - id: alpha-c2\n    label: Test\n    command: test\n    group: G\n"
	if err := os.WriteFile(root+"/alpha/yv.yaml", []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	third := s.ScanForConfigs(context.Background(), root)
	got := s.UnseenHits(third.Hits)
	if len(got) != 1 {
		t.Fatalf("got %d offered, want 1", len(got))
	}
	if got[0].Project.ID != "alpha" {
		t.Errorf("offered %q, want the edited one", got[0].Project.ID)
	}
}
