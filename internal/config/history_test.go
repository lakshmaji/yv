package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"yv/internal/models"
)

func TestImportHistoryRoundTrip(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	if got := s.GetImportHistory(10); len(got) != 0 {
		t.Errorf("a fresh install has no history, got %d entries", len(got))
	}

	appendImports([]models.ImportRecord{
		{Source: "file", Path: "/a.yaml", ProjectID: "a", ProjectName: "A", Action: "added", Commands: 3},
		{Source: "scan", Path: "/b.yaml", ProjectID: "b", ProjectName: "B", Action: "replaced", Commands: 7},
	})

	got := s.GetImportHistory(10)
	if len(got) != 2 {
		t.Fatalf("got %d entries, want 2", len(got))
	}
	// Newest first: the second record written must lead.
	if got[0].ProjectID != "b" {
		t.Errorf("order: got %q first, want the newest (%q)", got[0].ProjectID, "b")
	}
	if got[0].Action != "replaced" || got[0].Commands != 7 {
		t.Errorf("fields not preserved: %+v", got[0])
	}
	if got[0].At == "" {
		t.Error("no timestamp recorded")
	}
}

func TestGetImportHistoryLimit(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	var recs []models.ImportRecord
	for i := 0; i < 10; i++ {
		recs = append(recs, models.ImportRecord{ProjectID: string(rune('a' + i)), Action: "added"})
	}
	appendImports(recs)

	tests := []struct {
		name  string
		limit int
		want  int
	}{
		{"under the count", 3, 3},
		{"exactly the count", 10, 10},
		{"over the count", 50, 10},
		{"zero", 0, 0},
		{"negative", -1, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := s.GetImportHistory(tt.limit); len(got) != tt.want {
				t.Errorf("got %d, want %d", len(got), tt.want)
			}
		})
	}

	// The limit takes the newest, not the oldest.
	if got := s.GetImportHistory(1); len(got) == 1 && got[0].ProjectID != "j" {
		t.Errorf("limit kept %q, want the newest entry", got[0].ProjectID)
	}
}

// One bad line must not hide the rest of the log.
func TestGetImportHistorySkipsMalformedLines(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	appendImports([]models.ImportRecord{{ProjectID: "good1", Action: "added"}})

	path, err := historyPath()
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("this is not json\n\n{\"broken\": \n")
	f.Close()

	appendImports([]models.ImportRecord{{ProjectID: "good2", Action: "added"}})

	got := s.GetImportHistory(10)
	if len(got) != 2 {
		t.Fatalf("got %d entries, want the 2 valid ones: %+v", len(got), got)
	}
}

// Every import path must be logged, not just the scan — a log covering one of
// three is worse than none, because it looks complete.
func TestAllImportPathsAreAudited(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	root := writeTree(t, map[string]string{"alpha/yv.yaml": cfg("alpha")})
	if _, err := s.ApplyScanned([]string{filepath.Join(root, "alpha", "yv.yaml")}); err != nil {
		t.Fatal(err)
	}

	if _, err := s.ImportProjectsFromSlice([]models.Project{{ID: "frompeer", Name: "Peer"}}); err != nil {
		t.Fatal(err)
	}

	got := s.GetImportHistory(10)
	if len(got) != 2 {
		t.Fatalf("got %d entries, want 2 (scan + peer)", len(got))
	}

	sources := map[string]string{}
	for _, r := range got {
		sources[r.ProjectID] = r.Source
	}
	if sources["alpha"] != "scan" {
		t.Errorf("scan import logged as %q", sources["alpha"])
	}
	if sources["frompeer"] != "peer" {
		t.Errorf("peer import logged as %q", sources["frompeer"])
	}
}

// The log must never claim an import that did not land.
func TestNothingIsLoggedWhenNothingIsImported(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	root := writeTree(t, map[string]string{"bad/yv.yaml": "name: no id\ncommands: []\n"})
	msg, err := s.ApplyScanned([]string{filepath.Join(root, "bad", "yv.yaml")})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(msg, "failed") {
		t.Errorf("summary: got %q, want it to report the failure", msg)
	}
	if got := s.GetImportHistory(10); len(got) != 0 {
		t.Errorf("logged %d entries for an import that wrote nothing: %+v", len(got), got)
	}
}
