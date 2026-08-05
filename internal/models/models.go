package models

type Shortcut struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	CommandIDs []string `json:"commandIds"`
}

type Project struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	WorkingDir string            `json:"workingDir"`
	Groups     []string          `json:"groups"`
	GroupPaths map[string]string `json:"groupPaths,omitempty"`
	Commands   []CommandConfig   `json:"commands"`
	Shortcuts  []Shortcut        `json:"shortcuts,omitempty"`
}

type PostCommand struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"` // seconds; 0 = default (120)
}

type CommandConfig struct {
	ID           string        `json:"id"`
	Label        string        `json:"label"`
	Command      string        `json:"command"`
	Group        string        `json:"group"`
	WorkingDir   string        `json:"workingDir,omitempty"`
	Interactive  bool          `json:"interactive,omitempty"`
	PreCommands  []string      `json:"preCommands,omitempty"`
	PostCommands []PostCommand `json:"postCommands,omitempty"`
}

// EnvVar is a single environment variable belonging to an Environment.
// Secret only affects UI masking — values are stored the same way either way.
type EnvVar struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Secret bool   `json:"secret,omitempty"`
}

// Environment is a named set of variables that can be injected into commands.
// BgColor/TextColor are optional "#rrggbb" overrides used to make the active
// environment visually unmistakable; empty means "use the default theme".
type Environment struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	BgColor   string   `json:"bgColor,omitempty"`
	TextColor string   `json:"textColor,omitempty"`
	Vars      []EnvVar `json:"vars,omitempty"`
}

// ProjectEnvs holds every environment defined for one project plus the ID of
// the one currently applied to command execution ("" means none).
type ProjectEnvs struct {
	Environments []Environment `json:"environments"`
	ActiveID     string        `json:"activeId"`
}

type CommandResult struct {
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

type ProcessStats struct {
	CmdID string  `json:"cmdId"`
	Label string  `json:"label"`
	RSS   int64   `json:"rss"`
	CPU   float64 `json:"cpu"`
}

type ResourceStats struct {
	AppRSS      int64          `json:"appRss"`
	AppCPU      float64        `json:"appCpu"`
	TotalCmdRSS int64          `json:"totalCmdRss"`
	TotalCmdCPU float64        `json:"totalCmdCpu"`
	Commands    []ProcessStats `json:"commands"`
}

// ProcessEntry is a snapshot of a single running process, used by the monitor
// to collect resource stats without holding the runner's locks.
type ProcessEntry struct {
	PID   int
	CmdID string
	Label string
}
