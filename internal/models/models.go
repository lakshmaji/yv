package models

type Shortcut struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	CommandIDs []string `json:"commandIds"`
}

type Project struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	WorkingDir   string            `json:"workingDir"`
	Groups       []string          `json:"groups"`
	GroupPaths   map[string]string `json:"groupPaths,omitempty"`
	Commands     []CommandConfig   `json:"commands"`
	Shortcuts    []Shortcut        `json:"shortcuts,omitempty"`
	LabelBgColor string            `json:"labelBgColor,omitempty"`
	LabelTxColor string            `json:"labelTxColor,omitempty"`
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

// ProcessStats is one sampled process. ProjectID/Group carry the attribution
// needed to group metrics by project or group; they are empty for processes
// whose metadata has already been pruned.
type ProcessStats struct {
	CmdID     string  `json:"cmdId"`
	Label     string  `json:"label"`
	ProjectID string  `json:"projectId,omitempty"`
	Group     string  `json:"group,omitempty"`
	RSS       int64   `json:"rss"`
	CPU       float64 `json:"cpu"`
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
	PID       int
	CmdID     string
	Label     string
	ProjectID string
	Group     string
}

// CmdMeta is everything the runner learns about a command at launch time that
// the monitor and the metrics writer need in order to attribute a sample.
// Internal only — never crosses the Wails boundary.
type CmdMeta struct {
	Label     string
	ProjectID string
	Group     string
}

// --- settings ---

// Settings holds global, app-wide preferences (as opposed to per-project
// config). Every field's zero value must mean "use the default" so that a file
// written by an older build needs no migration — see settings.Normalize.
type Settings struct {
	SchemaVersion  int      `json:"schemaVersion"`
	MetricsEnabled bool     `json:"metricsEnabled"`
	RetentionDays  int      `json:"retentionDays"`
	Panels         []string `json:"panels"`

	// SoundMuted silences the dinosaur roars in the Discovery view. Stored
	// inverted — muted rather than enabled — because the zero value has to mean
	// the default, and the default is audible.
	SoundMuted bool `json:"soundMuted"`
	// AudioClips are the user's own sound files, in the order they added them.
	// No audio ships with the app, so an empty list means the roars are silent.
	AudioClips []string `json:"audioClips,omitempty"`

	// DroneVariant is the airframe the Discovery view sends out, by id. Empty —
	// the zero value, and so the default — means the first of the fleet. An id
	// this build no longer knows falls back the same way, so a renamed variant
	// cannot leave the map without a drone.
	DroneVariant string `json:"droneVariant,omitempty"`
	// DroneFanClip is the user's own clip for the rotor hum, looped while a drone
	// is patrolling. Empty means silent: no audio ships with the app, the same as
	// for the roars.
	DroneFanClip string `json:"droneFanClip,omitempty"`

	// SharePIN gates incoming config shares. Empty — the zero value, and so the
	// default — means any nearby peer may ask, which is still safe because the
	// receiver has to accept the transfer explicitly either way. Stored in the
	// clear because it is a convenience lock the user must be able to read back
	// off their own screen to tell a colleague, not a credential.
	SharePIN string `json:"sharePIN,omitempty"`
}

// --- peer sharing ---

// PeerInfo is one nearby yv instance as the frontend sees it.
//
// Name is the peer's hostname and doubles as its identity in the Discovery
// view: randomDino seeds its RNG from the name, so a given device always draws
// the same dinosaur. ID is carried alongside because two laptops can share a
// hostname, and because the name is all a clicked dinosaur knows about itself.
type PeerInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	PINRequired bool   `json:"pinRequired"`
}

// SharePayload is the config one peer sends another.
//
// Environments are deliberately absent. Secrets live in their own file so they
// never travel with exported config, and the same rule holds over the wire —
// do not add them here for convenience.
type SharePayload struct {
	Scope    string    `json:"scope"` // "app" | "project"
	Projects []Project `json:"projects"`
}

// ShareOffer is the header a sender writes before any payload bytes, and what
// the receiver shows the user when asking whether to accept.
type ShareOffer struct {
	TransferID   string `json:"transferId"`
	FromName     string `json:"fromName"`
	Scope        string `json:"scope"`
	ProjectName  string `json:"projectName,omitempty"`
	ProjectCount int    `json:"projectCount"`
	// PIN is sent in the clear over an already-encrypted libp2p stream. It is
	// compared against the receiver's stored PIN.
	PIN string `json:"pin,omitempty"`
}

// --- metrics: on-disk records ---
//
// These use short JSON keys on purpose: one sample record is written per
// running command per minute (~1440/day each), so key length is a material
// fraction of the file size. They are internal to the metrics package and are
// never returned to the frontend.

// SampleRecord is one 1-minute resource aggregate for one command, written as
// a single line of metrics/samples-YYYY-MM-DD.jsonl.
type SampleRecord struct {
	T       int64   `json:"t"` // bucket start, unix seconds, minute-aligned
	CmdID   string  `json:"c"` //
	Label   string  `json:"l,omitempty"`
	Project string  `json:"p,omitempty"`
	Group   string  `json:"g,omitempty"`
	N       int     `json:"n"`  // samples folded in (20 for a full minute at 3s)
	RSSAvg  int64   `json:"ra"` // bytes
	RSSPeak int64   `json:"rp"`
	CPUAvg  float64 `json:"ca"` // percent
	CPUPeak float64 `json:"cp"`
}

// RunRecord is one completed command run, written as a single line of
// metrics/runs-YYYY-MM-DD.jsonl. Stopped runs are tracked separately from
// failures so that stopping a dev server does not read as an error.
type RunRecord struct {
	T        int64  `json:"t"` // start, unix seconds
	DurMS    int64  `json:"d"`
	CmdID    string `json:"c"`
	Label    string `json:"l,omitempty"`
	Project  string `json:"p,omitempty"`
	Group    string `json:"g,omitempty"`
	RunID    string `json:"r,omitempty"`
	ExitCode int    `json:"x"`
	OK       bool   `json:"ok"`
	Stopped  bool   `json:"s,omitempty"`
	Err      string `json:"e,omitempty"`
}

// --- metrics: read API ---

// MetricsQuery is a bounded request for aggregated resource series.
type MetricsQuery struct {
	From       int64    `json:"from"`                 // unix seconds, inclusive
	To         int64    `json:"to"`                   // unix seconds, exclusive
	GroupBy    string   `json:"groupBy"`              // "command" | "project" | "group"
	Resolution int      `json:"resolution,omitempty"` // seconds per bucket; 0 = auto
	MaxPoints  int      `json:"maxPoints,omitempty"`  // default 500, cap 2000
	ProjectID  string   `json:"projectId,omitempty"`
	Group      string   `json:"group,omitempty"`
	CmdIDs     []string `json:"cmdIds,omitempty"`
	MaxSeries  int      `json:"maxSeries,omitempty"` // default 12, ranked by peak RSS
}

type MetricsPoint struct {
	T       int64   `json:"t"`
	N       int     `json:"n"`
	RSSAvg  int64   `json:"rssAvg"`
	RSSPeak int64   `json:"rssPeak"`
	CPUAvg  float64 `json:"cpuAvg"`
	CPUPeak float64 `json:"cpuPeak"`
}

type MetricsSeries struct {
	Key     string         `json:"key"`   // cmdID / projectID / group name
	Label   string         `json:"label"` // human-readable
	Points  []MetricsPoint `json:"points"`
	PeakRSS int64          `json:"peakRss"`
	PeakCPU float64        `json:"peakCpu"`
}

type MetricsResult struct {
	From          int64           `json:"from"`
	To            int64           `json:"to"`
	Resolution    int             `json:"resolution"`
	GroupBy       string          `json:"groupBy"`
	Series        []MetricsSeries `json:"series"`
	SeriesOmitted int             `json:"seriesOmitted"`
	Error         string          `json:"error,omitempty"`
}

// FrequencyPoint is a run count for one time bucket.
type FrequencyPoint struct {
	T     int64 `json:"t"`
	Count int   `json:"count"`
}

// FrequencySeries is how often one command, project, or group was run over time.
type FrequencySeries struct {
	Key    string           `json:"key"`
	Label  string           `json:"label"`
	Points []FrequencyPoint `json:"points"`
	Total  int              `json:"total"`
}

type FrequencyResult struct {
	From          int64             `json:"from"`
	To            int64             `json:"to"`
	Resolution    int               `json:"resolution"`
	GroupBy       string            `json:"groupBy"`
	Series        []FrequencySeries `json:"series"`
	Total         int               `json:"total"`
	SeriesOmitted int               `json:"seriesOmitted"`
	Error         string            `json:"error,omitempty"`
}

// ActivityDay is one cell of the calendar heatmap.
type ActivityDay struct {
	Date    string `json:"date"` // "2026-08-06", local time
	Total   int    `json:"total"`
	Success int    `json:"success"`
	Fail    int    `json:"fail"`
	Stopped int    `json:"stopped"`
	DurMS   int64  `json:"durMs"`
}

// ActivityHeatmap is a dense day range — days with no runs are included with
// zero counts so the frontend can lay out a fixed grid.
type ActivityHeatmap struct {
	From  string        `json:"from"`
	To    string        `json:"to"`
	Days  []ActivityDay `json:"days"`
	Max   int           `json:"max"`
	Total int           `json:"total"`
	Error string        `json:"error,omitempty"`
}

// MetricsStorageInfo reports metrics disk usage for the settings screen.
type MetricsStorageInfo struct {
	Enabled   bool   `json:"enabled"`
	Files     int    `json:"files"`
	Bytes     int64  `json:"bytes"`
	OldestDay string `json:"oldestDay,omitempty"`
	Dir       string `json:"dir"`
}
