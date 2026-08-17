package config

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// specExample is the complete example in the documentation.
//
// It is read from the docs tree rather than duplicated here on purpose: a
// specification that lies is worse than no specification, and the only way to
// stop one drifting from the parser is to make the parser read it.
const specExample = "../../docs/examples/yv.yaml"

func TestDocumentedExampleParses(t *testing.T) {
	data, err := os.ReadFile(specExample)
	if err != nil {
		t.Fatalf("the documented example is missing: %v", err)
	}

	p, err := unmarshalOneProject(data)
	if err != nil {
		t.Fatalf("the documented example does not parse: %v", err)
	}
	if _, err := validateScanned(&p, "/home/dev/development/checkout-api"); err != nil {
		t.Fatalf("the documented example is rejected by validation: %v", err)
	}

	// Every field the doc claims to support must survive the round trip. A
	// silently ignored key is exactly the failure this guards.
	if p.ID != "checkout-api" {
		t.Errorf("ID: got %q", p.ID)
	}
	if p.Name != "Checkout API" {
		t.Errorf("Name: got %q", p.Name)
	}
	if p.LabelBgColor != "#1f6feb" || p.LabelTxColor != "#ffffff" {
		t.Errorf("label colours: got %q / %q", p.LabelBgColor, p.LabelTxColor)
	}
	if !reflect.DeepEqual(p.Groups, []string{"Docker", "Test"}) {
		t.Errorf("Groups: got %v", p.Groups)
	}
	if p.GroupPaths["Docker"] != "deploy/local" {
		t.Errorf("GroupPaths: got %v", p.GroupPaths)
	}
	if len(p.Commands) != 4 {
		t.Fatalf("got %d commands, want 4", len(p.Commands))
	}
	if len(p.Shortcuts) != 1 || len(p.Shortcuts[0].CommandIDs) != 2 {
		t.Errorf("Shortcuts: got %+v", p.Shortcuts)
	}

	byID := map[string]int{}
	for i, c := range p.Commands {
		byID[c.ID] = i
	}

	logs := p.Commands[byID["checkout-api-logs"]]
	if !logs.Interactive {
		t.Error("interactive: not carried through")
	}

	it := p.Commands[byID["checkout-api-it"]]
	if it.WorkingDir != "/opt/fixtures" {
		t.Errorf("command workingDir: got %q", it.WorkingDir)
	}
	if len(it.PreCommands) != 1 {
		t.Errorf("preCommands: got %v", it.PreCommands)
	}
	if len(it.PostCommands) != 1 || it.PostCommands[0].Timeout != 60 {
		t.Errorf("postCommands: got %+v", it.PostCommands)
	}
}

// The example must also survive being written back out, since that is what
// Export produces and what a user is told they can hand-edit.
func TestDocumentedExampleRoundTrips(t *testing.T) {
	data, err := os.ReadFile(specExample)
	if err != nil {
		t.Fatal(err)
	}
	first, err := unmarshalOneProject(data)
	if err != nil {
		t.Fatal(err)
	}

	out, err := toYAML(first)
	if err != nil {
		t.Fatalf("toYAML: %v", err)
	}
	second, err := unmarshalOneProject(out)
	if err != nil {
		t.Fatalf("re-reading our own export failed: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Errorf("round trip changed the project:\nfirst:  %+v\nsecond: %+v", first, second)
	}
}

// The example is what a user copies into a repo, so it must survive the actual
// scan path — not just the parser in isolation.
func TestDocumentedExampleIsFoundByAScan(t *testing.T) {
	isolateHome(t)
	data, err := os.ReadFile(specExample)
	if err != nil {
		t.Fatal(err)
	}
	root := writeTree(t, map[string]string{"checkout-api/yv.yaml": string(data)})

	s := NewStore()
	res := s.ScanForConfigs(t.Context(), root)
	if len(res.Hits) != 1 {
		t.Fatalf("got %d hits, want 1", len(res.Hits))
	}
	if res.Hits[0].Error != "" {
		t.Fatalf("the documented example was rejected: %s", res.Hits[0].Error)
	}

	if _, err := s.ApplyScanned([]string{res.Hits[0].Path}); err != nil {
		t.Fatalf("ApplyScanned: %v", err)
	}
	got := projectByID(t, s, "checkout-api")
	if len(got.Commands) != 4 {
		t.Errorf("imported %d commands, want 4", len(got.Commands))
	}
	// The example omits a top-level workingDir, which is the documented advice.
	if got.WorkingDir != filepath.Join(root, "checkout-api") {
		t.Errorf("WorkingDir: got %q, want the containing folder", got.WorkingDir)
	}
}

// The example printed in docs/yv-yaml.md must be the same bytes as the example
// the tests above actually parse.
//
// Without this the guard is only half a guard: the file would stay correct
// while the block a reader copies drifts away from it, which is the more likely
// failure of the two — nobody edits an example they cannot see.
func TestDocumentedExampleMatchesTheProseCopy(t *testing.T) {
	fileBody, err := os.ReadFile(specExample)
	if err != nil {
		t.Fatal(err)
	}
	// The file leads with a comment explaining itself; the doc says that in
	// prose instead, so the shared part starts at the first real key.
	idx := bytes.Index(fileBody, []byte("id:"))
	if idx < 0 {
		t.Fatal("the example has no id")
	}
	want := strings.TrimSpace(string(fileBody[idx:]))

	doc, err := os.ReadFile("../../docs/yv-yaml.md")
	if err != nil {
		t.Fatal(err)
	}
	got, ok := fencedBlockAfter(string(doc), "## A complete example")
	if !ok {
		t.Fatal("no yaml block found under '## A complete example'")
	}
	if got != want {
		t.Errorf("the documented example has drifted from docs/examples/yv.yaml.\n\ndoc:\n%s\n\nfile:\n%s", got, want)
	}
}

// fencedBlockAfter returns the first ```yaml block following heading.
func fencedBlockAfter(doc, heading string) (string, bool) {
	i := strings.Index(doc, heading)
	if i < 0 {
		return "", false
	}
	rest := doc[i:]
	start := strings.Index(rest, "```yaml\n")
	if start < 0 {
		return "", false
	}
	rest = rest[start+len("```yaml\n"):]
	end := strings.Index(rest, "```")
	if end < 0 {
		return "", false
	}
	return strings.TrimSpace(rest[:end]), true
}
