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

	// Username is what this device calls itself to nearby peers. Optional: the
	// zero value means the machine's hostname, which is what shipped before this
	// existed, so an older settings file needs no migration.
	//
	// It is not only a label — the name seeds the peer's dinosaur on the
	// Discovery map and the roar it is given, so changing it changes the animal
	// other people see. That is the point: "Rexy.local" says nothing about who
	// is offering you a file.
	Username string `json:"username,omitempty"`

	// SoundMuted silences the dinosaur roars in the Discovery view. Stored
	// inverted — muted rather than enabled — because the zero value has to mean
	// the default, and the default is audible.
	SoundMuted bool `json:"soundMuted"`
	// AudioClips are the user's own sound files, in the order they added them.
	// No audio ships with the app, so an empty list means the roars are silent.
	AudioClips []string `json:"audioClips,omitempty"`

	// WaterStill stops the sea and the rivers moving in the Discovery view.
	// Stored inverted — still rather than animated — for the same reason as
	// SoundMuted: the zero value has to mean the default, and the default is
	// moving water.
	//
	// Deliberately separate from the toolbar's Motion toggle rather than folded
	// into it. Motion is a per-session control over the whole map; this is a
	// persisted preference about the one layer that never stops, and someone who
	// finds the current distracting while reading settlement names has not asked
	// for the dinosaurs to stop breathing.
	WaterStill bool `json:"waterStill,omitempty"`

	// DroneVariant is the airframe the Discovery view sends out, by id. Empty —
	// the zero value, and so the default — means the first of the fleet. An id
	// this build no longer knows falls back the same way, so a renamed variant
	// cannot leave the map without a drone.
	DroneVariant string `json:"droneVariant,omitempty"`
	// DroneFanClip is the user's own clip for the rotor hum, looped while a drone
	// is patrolling. Empty means silent: no audio ships with the app, the same as
	// for the roars.
	DroneFanClip string `json:"droneFanClip,omitempty"`
	// DroneCrashClip is played once when a drone bursts after finding nothing.
	// Separate from the hum because they are different sounds doing different
	// jobs — one is ambient and looped, the other is the end of the sweep.
	DroneCrashClip string `json:"droneCrashClip,omitempty"`
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

// UnreachablePeer is a device mDNS found that we could not connect to.
//
// It carries no name, because the name arrives in the hello — which is exactly
// the exchange that failed. A user recognises a device by its dinosaur, and an
// unreachable peer never gets one, so the ID is all there is to say.
type UnreachablePeer struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// ShareStatus is what discovery can say about itself when nothing appeared.
//
// Seen counts devices mDNS reported; Announced counts the ones we connected to
// and therefore drew. **Seen > Announced is the whole point of this struct**: it
// is the difference between an empty network and a blocked one, and until it
// existed both looked identical from the Discovery view — a silent "no devices
// nearby" that gave a user nothing to act on.
type ShareStatus struct {
	Running     bool              `json:"running"`
	PeerID      string            `json:"peerId"`
	ListenAddrs []string          `json:"listenAddrs"`
	Seen        int               `json:"seen"`
	Announced   int               `json:"announced"`
	Unreachable []UnreachablePeer `json:"unreachable"`
}

// SharePayload is the config one peer sends another.
//
// Files are deliberately not here. They travel on their own protocol, streamed
// to disk, precisely so that a large one is never assembled in memory as
// base64 inside this struct.
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
	// FileNames and TotalBytes describe a "files" offer, so the receiver's prompt
	// can name what it is about to accept rather than showing a count alone.
	FileNames  []string `json:"fileNames,omitempty"`
	TotalBytes int64    `json:"totalBytes,omitempty"`
	// Kind is "" for a real transfer and OfferKindConnect for the connection
	// request that precedes one.
	Kind string `json:"kind,omitempty"`
	// PIN is sent in the clear over an already-encrypted libp2p stream. It is
	// compared against the receiver's stored PIN.
	PIN string `json:"pin,omitempty"`
}

// OfferKindConnect marks a connection request: a header with a PIN and nothing
// else, sent before the sender has chosen anything.
//
// It is the first half of the two-step flow. Asking to connect and asking to
// receive something are genuinely different questions — at connect time there
// is no payload to describe, so a prompt naming one would be describing a
// transfer that does not exist yet. Accepting it grants a conversation; the
// transfer that follows is still asked separately, and is still the gate on
// anything being written.
const OfferKindConnect = "connect"

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

// UpdateStatus is the stage of an update check or install.
//
// One flat set of values rather than a nested state machine: the UI shows one
// screen per value and the transitions are all driven from Go, so anything more
// structured would exist only to be flattened again at the boundary.
type UpdateStatus string

const (
	UpdateIdle        UpdateStatus = "idle"
	UpdateChecking    UpdateStatus = "checking"
	UpdateAvailable   UpdateStatus = "available"
	UpdateDownloading UpdateStatus = "downloading"
	UpdateReady       UpdateStatus = "ready"   // downloaded and verified, waiting on a restart
	UpdateCurrent     UpdateStatus = "current" // nothing newer published
	UpdateManual      UpdateStatus = "manual"  // newer exists, but this install cannot replace itself
	UpdateDev         UpdateStatus = "dev"     // a build with no version, so nothing to compare
	UpdateFailed      UpdateStatus = "failed"
)

// UpdateState is the whole of what the update UI renders, pushed as an
// "update:state" event and returned by the check and download calls.
//
// One struct for every stage rather than a payload per event. The dialog is a
// single component showing one of several screens, so a partial payload would
// mean it holding its own copy of what the last one said — two sources for one
// piece of state, which is how a progress bar ends up outliving the download.
type UpdateState struct {
	Status  UpdateStatus `json:"status"`
	Current string       `json:"current"`
	Version string       `json:"version,omitempty"`
	Notes   string       `json:"notes,omitempty"`

	// Downloaded and Total drive the progress bar. Total is 0 when the release
	// published no size, which the UI shows as indeterminate rather than
	// inventing a percentage.
	Downloaded int64 `json:"downloaded,omitempty"`
	Total      int64 `json:"total,omitempty"`

	// Message is shown verbatim. Every producer of one writes it for the person
	// reading it, so the UI never has to map a code to a sentence.
	Message string `json:"message,omitempty"`

	// CanSelfUpdate is false when this install shape cannot replace itself — a
	// .deb, a tarball, a translocated bundle. The UI then offers the release
	// page instead of a download.
	CanSelfUpdate bool `json:"canSelfUpdate"`
}
