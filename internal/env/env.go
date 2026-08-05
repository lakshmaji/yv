// Package env stores per-project environments (named sets of variables, often
// secrets) and merges the active set into a process environment.
//
// Environments live in their own file — separate from projects.json — so that
// exporting or sharing a project never carries its secrets along. The file is
// written with 0600 permissions.
package env

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"yv/internal/models"
)

// fileName is the environments file inside the app config dir.
const fileName = "environments.json"

// Data maps project ID → that project's environments.
type Data map[string]models.ProjectEnvs

// Store is a file-backed environment store. A mutex serialises read-modify-write
// cycles so concurrent saves from the UI can't lose entries.
type Store struct {
	mu sync.Mutex
}

func NewStore() *Store { return &Store{} }

// Get returns the environments for one project. A missing project yields an
// empty (non-nil-slice) value so the frontend always gets a usable shape.
func (s *Store) Get(projectID string) models.ProjectEnvs {
	s.mu.Lock()
	defer s.mu.Unlock()

	pe := s.load()[projectID]
	if pe.Environments == nil {
		pe.Environments = []models.Environment{}
	}
	pe.ActiveID = resolveActiveID(pe)
	return pe
}

// Save replaces the environments of one project. Invalid variable names are
// rejected up front so a bad key can never reach the shell.
func (s *Store) Save(projectID string, pe models.ProjectEnvs) error {
	if projectID == "" {
		return fmt.Errorf("project id required")
	}
	if err := Validate(pe); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	data := s.load()
	pe.Environments = normalize(pe.Environments)
	pe.ActiveID = resolveActiveID(pe)
	data[projectID] = pe
	return s.write(data)
}

// Delete drops all environments of a project (used when a project is removed).
func (s *Store) Delete(projectID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data := s.load()
	if _, ok := data[projectID]; !ok {
		return nil
	}
	delete(data, projectID)
	return s.write(data)
}

// ActiveVars returns the variables of the project's active environment.
func (s *Store) ActiveVars(projectID string) []models.EnvVar {
	return ActiveVars(s.Get(projectID))
}

// load reads the store from disk. Any failure yields an empty Data — the
// environments file is a cache of user input, never a hard dependency.
// Callers must hold s.mu.
func (s *Store) load() Data {
	path, err := storePath()
	if err != nil {
		return Data{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Data{}
	}
	var data Data
	if err := json.Unmarshal(raw, &data); err != nil || data == nil {
		return Data{}
	}
	return data
}

// write persists the store with owner-only permissions. Callers must hold s.mu.
func (s *Store) write(data Data) error {
	path, err := storePath()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func storePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("UserConfigDir: %w", err)
	}
	appDir := filepath.Join(dir, "yv")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return "", fmt.Errorf("MkdirAll: %w", err)
	}
	return filepath.Join(appDir, fileName), nil
}

// --- pure helpers (unit tested) ---

// ActiveVars returns the variables of pe's active environment, or nil if none
// is active. Variables with an empty key are dropped.
func ActiveVars(pe models.ProjectEnvs) []models.EnvVar {
	id := resolveActiveID(pe)
	if id == "" {
		return nil
	}
	for _, e := range pe.Environments {
		if e.ID != id {
			continue
		}
		vars := make([]models.EnvVar, 0, len(e.Vars))
		for _, v := range e.Vars {
			if strings.TrimSpace(v.Key) != "" {
				vars = append(vars, v)
			}
		}
		return vars
	}
	return nil
}

// Merge applies vars on top of a "KEY=value" environment slice. Existing keys
// are overwritten in place (preserving order); new keys are appended in the
// order given. Later duplicates within vars win.
func Merge(base []string, vars []models.EnvVar) []string {
	out := make([]string, len(base))
	copy(out, base)

	index := make(map[string]int, len(out))
	for i, kv := range out {
		if eq := strings.IndexByte(kv, '='); eq > 0 {
			index[kv[:eq]] = i
		}
	}

	for _, v := range vars {
		key := strings.TrimSpace(v.Key)
		if key == "" {
			continue
		}
		entry := key + "=" + v.Value
		if i, ok := index[key]; ok {
			out[i] = entry
			continue
		}
		index[key] = len(out)
		out = append(out, entry)
	}
	return out
}

// ValidateKey reports whether key is a usable shell variable name:
// non-empty, [A-Za-z_][A-Za-z0-9_]*.
func ValidateKey(key string) error {
	if key == "" {
		return fmt.Errorf("empty variable name")
	}
	for i, r := range key {
		isLetter := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		isDigit := r >= '0' && r <= '9'
		if isLetter || (i > 0 && isDigit) {
			continue
		}
		return fmt.Errorf("invalid variable name %q", key)
	}
	return nil
}

// Validate checks every environment name and variable key in pe.
func Validate(pe models.ProjectEnvs) error {
	for _, e := range pe.Environments {
		if strings.TrimSpace(e.Name) == "" {
			return fmt.Errorf("environment name required")
		}
		for _, v := range e.Vars {
			key := strings.TrimSpace(v.Key)
			if key == "" {
				continue // blank rows are dropped by normalize, not an error
			}
			if err := ValidateKey(key); err != nil {
				return fmt.Errorf("%s: %w", e.Name, err)
			}
		}
	}
	return nil
}

// normalize trims names/keys and drops variable rows with no key.
func normalize(envs []models.Environment) []models.Environment {
	out := make([]models.Environment, 0, len(envs))
	for _, e := range envs {
		e.Name = strings.TrimSpace(e.Name)
		vars := make([]models.EnvVar, 0, len(e.Vars))
		for _, v := range e.Vars {
			v.Key = strings.TrimSpace(v.Key)
			if v.Key == "" {
				continue
			}
			vars = append(vars, v)
		}
		e.Vars = vars
		out = append(out, e)
	}
	return out
}

// resolveActiveID returns ActiveID when it still points at an existing
// environment, otherwise "" (nothing is injected).
func resolveActiveID(pe models.ProjectEnvs) string {
	for _, e := range pe.Environments {
		if e.ID == pe.ActiveID && pe.ActiveID != "" {
			return pe.ActiveID
		}
	}
	return ""
}
