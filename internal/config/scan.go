package config

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"yv/internal/models"
)

// Bounds on a walk. The root is whatever folder the user picked — nothing stops
// it being their home directory, or a mounted network share — and the scan runs
// unattended on a timer, so none of this can be left open-ended.
const (
	maxScanEntries = 200_000
	maxScanDepth   = 12
	maxScanHits    = 500
	maxYAMLSize    = 1 << 20 // 1 MB. A command list, not a dataset.
	ScanTimeout    = 60 * time.Second
)

// Bounds on one parsed file. Generous enough that a real config never meets
// them, tight enough that a malformed one cannot exhaust memory or produce a
// list nobody can scroll.
const (
	maxCommandsPerProject = 500
	maxGroupsPerProject   = 50
	maxLabelLen           = 200
	maxCommandLen         = 8 << 10
)

// validID is what a project id may contain. The id becomes a map key and part
// of a DOM id, and it is the thing replace-by-id matches on, so it is kept to
// characters that cannot surprise either side.
var validID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// skipDirs are directories never worth descending into: dependency trees and
// build output, which are large, deep, and cannot contain a project's own
// committed config.
var skipDirs = map[string]bool{
	// JS/TS, Go, Rust, Python, Java
	"node_modules": true, "dist": true, "build": true, "out": true,
	"target": true, "vendor": true, "__pycache__": true,
	// Android
	"captures": true,
	// iOS / macOS
	"Pods": true, "Carthage": true, "DerivedData": true,
}

// skipDir reports whether a directory should be pruned from the walk.
//
// The dot-prefix rule is doing most of the work: it covers .git, .gradle, .cxx,
// .build, .next, .venv and every other tool cache without listing them. Xcode
// project and workspace bundles are directories, hence the suffix checks.
func skipDir(name string) bool {
	return skipDirs[name] ||
		strings.HasPrefix(name, ".") ||
		strings.HasSuffix(name, ".xcodeproj") ||
		strings.HasSuffix(name, ".xcworkspace")
}

// isConfigName reports whether a file is a yv config. The match is exact, so
// yv.yaml.bak, yv.yaml.example and my-yv.yaml are all left alone.
func isConfigName(name string) bool {
	return name == ConfigFileName || name == ConfigFileNameAlt
}

// ScanForConfigs walks root for yv.yaml files and reports what it found.
//
// It writes nothing. Every hit is returned for the user to accept or refuse,
// including the ones that failed to parse — a file listed with its error is the
// only way its author learns it is broken.
func (s *Store) ScanForConfigs(ctx context.Context, root string) models.ScanResult {
	started := time.Now()
	res := models.ScanResult{Hits: []models.ScanHit{}}

	root = strings.TrimSpace(root)
	if root == "" {
		res.Truncated = "no folder chosen"
		return res
	}
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		res.Truncated = fmt.Sprintf("cannot read %s", root)
		return res
	}

	// Existing ids decide whether a hit adds a project or replaces one. Read
	// once: re-reading per hit would be 18 loads of the same file.
	existing := map[string]int{}
	for _, p := range loadProjects() {
		existing[p.ID] = len(p.Commands)
	}

	rootDepth := strings.Count(filepath.Clean(root), string(os.PathSeparator))

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		// An unreadable directory is skipped, never fatal: one permission-denied
		// folder must not cost the user every other project on the disk.
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}

		res.Scanned++
		if res.Scanned > maxScanEntries {
			res.Truncated = fmt.Sprintf("stopped after %d folders — choose a narrower folder", maxScanEntries)
			return fs.SkipAll
		}

		if d.IsDir() {
			// The root itself is exempt, so scanning a dot-prefixed folder works.
			if path != root && skipDir(d.Name()) {
				return fs.SkipDir
			}
			if strings.Count(filepath.Clean(path), string(os.PathSeparator))-rootDepth > maxScanDepth {
				return fs.SkipDir
			}
			return nil
		}

		if !isConfigName(d.Name()) {
			return nil
		}
		if len(res.Hits) >= maxScanHits {
			res.Truncated = fmt.Sprintf("stopped at %d config files — choose a narrower folder", maxScanHits)
			return fs.SkipAll
		}

		res.Hits = append(res.Hits, readHit(path, d, existing))
		return nil
	})

	if err != nil && res.Truncated == "" {
		if ctx.Err() != nil {
			res.Truncated = "scan timed out"
		} else {
			res.Truncated = err.Error()
		}
	}

	res.ElapsedMs = time.Since(started).Milliseconds()
	return res
}

// readHit reads and validates one config file. It never returns an error: a
// file that cannot be used becomes a hit carrying the reason, so the dialog can
// show it greyed out rather than leaving a gap the user cannot account for.
func readHit(path string, d fs.DirEntry, existing map[string]int) models.ScanHit {
	hit := models.ScanHit{Path: path, Dir: filepath.Dir(path)}

	// Checked before opening, so an enormous file costs no read.
	if info, err := d.Info(); err == nil && info.Size() > maxYAMLSize {
		hit.Error = fmt.Sprintf("file is %d KB, larger than the %d KB limit", info.Size()/1024, maxYAMLSize/1024)
		return hit
	}

	data, err := os.ReadFile(path)
	if err != nil {
		hit.Error = "cannot read: " + err.Error()
		return hit
	}
	sum := sha256.Sum256(data)
	hit.Hash = hex.EncodeToString(sum[:])

	p, err := unmarshalOneProject(data)
	if err != nil {
		hit.Error = "cannot parse: " + err.Error()
		return hit
	}

	dropped, err := validateScanned(&p, hit.Dir)
	if err != nil {
		hit.Error = err.Error()
		return hit
	}

	hit.Project = p
	hit.Dropped = dropped
	if n, ok := existing[p.ID]; ok {
		hit.Exists = true
		hit.ExistingCommands = n
	}
	return hit
}

// validateScanned checks a parsed config and fills in what it may omit,
// returning the number of unusable commands dropped.
//
// The file arrives by git clone and is written by hand, so it is validated
// rather than trusted. Rejecting beats repairing: a file quietly "fixed" here
// is one whose author never finds out it was wrong.
func validateScanned(p *models.Project, dir string) (int, error) {
	p.ID = strings.TrimSpace(p.ID)
	if p.ID == "" {
		return 0, fmt.Errorf("no id — a config needs a stable id so it can be matched to a project")
	}
	if !validID.MatchString(p.ID) {
		return 0, fmt.Errorf("id %q must be 1-64 characters of letters, digits, dot, dash or underscore", p.ID)
	}

	// The folder is the natural default, so a committed config need not carry
	// the absolute path of whichever machine it was written on.
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		p.Name = filepath.Base(dir)
	}
	if p.WorkingDir = strings.TrimSpace(p.WorkingDir); p.WorkingDir == "" {
		p.WorkingDir = dir
	}

	if len(p.Commands) > maxCommandsPerProject {
		return 0, fmt.Errorf("%d commands, more than the %d allowed", len(p.Commands), maxCommandsPerProject)
	}
	if len(p.Groups) > maxGroupsPerProject {
		return 0, fmt.Errorf("%d groups, more than the %d allowed", len(p.Groups), maxGroupsPerProject)
	}

	kept := make([]models.CommandConfig, 0, len(p.Commands))
	seen := make(map[string]bool, len(p.Commands))
	dropped := 0
	for _, c := range p.Commands {
		c.ID = strings.TrimSpace(c.ID)
		c.Command = strings.TrimSpace(c.Command)
		if c.ID == "" || c.Command == "" {
			dropped++
			continue
		}
		// Run state, terminal output and metrics are all keyed by command id,
		// so two commands sharing one would cross-wire their output.
		if seen[c.ID] {
			return 0, fmt.Errorf("duplicate command id %q", c.ID)
		}
		if len(c.Label) > maxLabelLen {
			return 0, fmt.Errorf("command %q has a label longer than %d characters", c.ID, maxLabelLen)
		}
		if len(c.Command) > maxCommandLen {
			return 0, fmt.Errorf("command %q is longer than %d characters", c.ID, maxCommandLen)
		}
		seen[c.ID] = true
		kept = append(kept, c)
	}
	p.Commands = kept

	if len(p.Commands) == 0 {
		return dropped, fmt.Errorf("no usable commands")
	}
	return dropped, nil
}

// ApplyScanned imports the config files at the given paths, replacing any
// project that already has the same id.
//
// Replace, not merge: the point of committing a yv.yaml is that pulling a
// teammate's change updates your commands, and a merge would keep a command
// they deleted forever.
//
// The files are re-read rather than taking the parsed hits from the caller,
// because the review dialog can sit open for a while and the disk is the truth.
// Deliberately separate from ImportProjectsFromSlice, which skips rather than
// overwrites: that one is also where projects arriving from a peer land, and a
// device on the network must never be able to replace a project.
func (s *Store) ApplyScanned(paths []string) (string, error) {
	if len(paths) == 0 {
		return "Nothing selected", nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	configP, err := configPath()
	if err != nil {
		return "", err
	}

	projects := loadProjects()
	index := make(map[string]int, len(projects))
	for i, p := range projects {
		index[p.ID] = i
	}

	var (
		added, replaced int
		failed          []string
	)

	for _, path := range paths {
		p, err := readProjectFile(path)
		if err != nil {
			failed = append(failed, filepath.Base(filepath.Dir(path))+": "+err.Error())
			continue
		}

		if i, ok := index[p.ID]; ok {
			projects[i] = p
			replaced++
		} else {
			index[p.ID] = len(projects)
			projects = append(projects, p)
			added++
		}
	}

	if added+replaced > 0 {
		if err := writeProjects(configP, projects); err != nil {
			return "", err
		}
	}

	return importSummary(added, replaced, failed), nil
}

// readProjectFile reads and validates one config file from disk.
func readProjectFile(path string) (models.Project, error) {
	info, err := os.Stat(path)
	if err != nil {
		return models.Project{}, err
	}
	if info.Size() > maxYAMLSize {
		return models.Project{}, fmt.Errorf("file is larger than the %d KB limit", maxYAMLSize/1024)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return models.Project{}, err
	}
	p, err := unmarshalOneProject(data)
	if err != nil {
		return models.Project{}, fmt.Errorf("cannot parse: %w", err)
	}
	if _, err := validateScanned(&p, filepath.Dir(path)); err != nil {
		return models.Project{}, err
	}
	return p, nil
}

func importSummary(added, replaced int, failed []string) string {
	var parts []string
	if added > 0 {
		parts = append(parts, fmt.Sprintf("added %d", added))
	}
	if replaced > 0 {
		parts = append(parts, fmt.Sprintf("replaced %d", replaced))
	}
	if len(parts) == 0 {
		parts = append(parts, "imported nothing")
	}
	msg := "Imported: " + strings.Join(parts, ", ")
	if len(failed) > 0 {
		msg += fmt.Sprintf(" — %d failed: %s", len(failed), strings.Join(failed, "; "))
	}
	return msg
}
