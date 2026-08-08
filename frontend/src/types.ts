export interface Project {
  id: string;
  name: string;
  workingDir: string;
  groups: string[];
  groupPaths?: Record<string, string>;
  commands: CommandConfig[];
  shortcuts?: Shortcut[];
  labelBgColor?: string;
  labelTxColor?: string;
}

export interface CommandConfig {
  id: string;
  label: string;
  command: string;
  group: string;
  workingDir?: string;
  interactive?: boolean;
  preCommands?: string[];
  postCommands?: PostCommand[];
}

export interface PostCommand {
  command: string;
  timeout?: number;
}

export interface Shortcut {
  id: string;
  name: string;
  commandIds: string[];
}

export interface EnvVar {
  key: string;
  value: string;
  secret?: boolean;
}

export interface Environment {
  id: string;
  name: string;
  bgColor?: string;
  textColor?: string;
  vars?: EnvVar[];
}

export interface ProjectEnvs {
  environments: Environment[];
  activeId: string;
}

export interface CommandResult {
  exitCode: number;
  error?: string;
}

export interface CmdState {
  lines: string[];
  collapsed: boolean;
  exitCode: number | null;
  stopped: boolean;
  running: boolean;
  trimmedCount: number;
}

export interface ShortcutState {
  running: boolean;
  finalState: 'ok' | 'failed' | null;
  steps: Record<number, 'running' | 'ok' | 'failed' | 'skipped'>;
}

export interface ResourceStats {
  appRss: number;
  appCpu: number;
  totalCmdRss: number;
  totalCmdCpu: number;
  commands: ProcessStats[];
}

export interface ProcessStats {
  cmdId: string;
  label: string;
  projectId?: string;
  group?: string;
  rss: number;
  cpu: number;
}

// --- global settings ---

/** Dashboard sections the user can show or hide. */
export type PanelId = 'stats' | 'memory' | 'frequency' | 'activity';

export interface AppSettings {
  schemaVersion: number;
  metricsEnabled: boolean;
  retentionDays: number;
  panels: PanelId[];
  /**
   * What this device calls itself to nearby peers. Optional — empty means the
   * machine's hostname. It seeds the peer's dinosaur and its roar on the other
   * end's Discovery map, so it is an identity rather than a caption.
   */
  username?: string;
  /** Inverted on purpose: the Go zero value must mean the default, and roars are on. */
  soundMuted: boolean;
  /** The user's own sound files. Empty means the dinosaurs are silent. */
  audioClips?: string[];
  /**
   * Stops the sea and the rivers moving. Inverted for the same reason as
   * `soundMuted`, and separate from the toolbar's Motion toggle: that one is a
   * per-session switch over the whole map, this is a persisted preference about
   * the one layer that never stops.
   */
  waterStill?: boolean;
  /**
   * Which airframe the Discovery view sends out, by id. Empty — the default —
   * means the first of the fleet, and so does an id this build doesn't know.
   */
  droneVariant?: string;
  /**
   * The user's own clip for the rotor hum, looped while a drone is patrolling.
   * Empty means silent: no audio ships with the app, as with the roars.
   */
  droneFanClip?: string;
  /** Played once when a drone bursts after an empty sweep. Empty means silent. */
  droneCrashClip?: string;
}

// --- peer sharing ---

/**
 * A nearby yv instance.
 *
 * `name` is the peer's hostname and doubles as its identity on the Discovery
 * map: `randomDino` seeds off the name, so a device always draws the same
 * dinosaur. `id` is carried separately because two laptops can share a hostname
 * and because a clicked dinosaur only knows its own name.
 */
export interface PeerInfo {
  id: string;
  name: string;
  /** Always true — every connection is gated by a code. Kept so an older peer
      that answers false is still read truthfully rather than assumed open. */
  pinRequired: boolean;
}

/**
 * Bytes moved so far on a file transfer, throttled by the sender.
 *
 * `total` is what the offer promised, so a bar can be drawn before the first
 * byte lands. Config transfers do not report progress — they are small enough
 * that a bar would flash and vanish.
 */
export interface ShareProgress {
  transferId: string;
  direction: 'send' | 'receive';
  bytes: number;
  total: number;
}

/** A nearby device asking to connect, awaiting the code it is reading out. */
export interface IncomingConnect {
  requestId: string;
  peerId: string;
  fromName: string;
}

/**
 * What a share carries. 'app' and 'project' are config; 'files' is whatever the
 * user picked off their own disk, and is the only scope that lands outside the
 * app's own storage.
 */
export type ShareScope = 'app' | 'project' | 'files';

/** An inbound offer awaiting the user's accept or decline. */
export interface IncomingShare {
  transferId: string;
  fromName: string;
  scope: ShareScope;
  projectName?: string;
  projectCount: number;
  /** Present on a 'files' offer, so the prompt can name what is being sent. */
  fileNames?: string[];
  totalBytes?: number;
}

// --- metrics ---

export type MetricKind = 'memory' | 'cpu';
export type MetricGroupBy = 'command' | 'project' | 'group';

export interface MetricsQuery {
  from: number; // unix seconds, inclusive
  to: number; // unix seconds, exclusive
  groupBy: MetricGroupBy;
  resolution?: number; // seconds per bucket; omit for auto
  maxPoints?: number;
  projectId?: string;
  group?: string;
  cmdIds?: string[];
  maxSeries?: number;
}

export interface MetricsPoint {
  t: number;
  n: number;
  rssAvg: number;
  rssPeak: number;
  cpuAvg: number;
  cpuPeak: number;
}

export interface MetricsSeries {
  key: string;
  label: string;
  points: MetricsPoint[];
  peakRss: number;
  peakCpu: number;
}

export interface MetricsResult {
  from: number;
  to: number;
  resolution: number;
  groupBy: MetricGroupBy;
  series: MetricsSeries[];
  seriesOmitted: number;
  error?: string;
}

export interface FrequencyPoint {
  t: number;
  count: number;
}

export interface FrequencySeries {
  key: string;
  label: string;
  points: FrequencyPoint[];
  total: number;
}

export interface FrequencyResult {
  from: number;
  to: number;
  resolution: number;
  groupBy: MetricGroupBy;
  series: FrequencySeries[];
  total: number;
  seriesOmitted: number;
  error?: string;
}

export interface ActivityDay {
  date: string; // 'YYYY-MM-DD', local
  total: number;
  success: number;
  fail: number;
  stopped: number;
  durMs: number;
}

export interface ActivityHeatmap {
  from: string;
  to: string;
  days: ActivityDay[];
  max: number;
  total: number;
  error?: string;
}

export interface MetricsStorageInfo {
  enabled: boolean;
  files: number;
  bytes: number;
  oldestDay?: string;
  dir: string;
}

/**
 * Stage of an update check or install. Mirrors models.UpdateStatus in
 * internal/models/models.go, which is the enforcement point — this is only the
 * wire shape.
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'current'
  | 'manual'
  | 'dev'
  | 'failed';

/**
 * The whole of what the update dialog renders.
 *
 * One struct for every stage rather than a payload per event, so the dialog
 * never has to keep its own copy of what the last one said — two sources for
 * one piece of state is how a progress bar ends up outliving its download.
 */
export interface UpdateState {
  status: UpdateStatus;
  /** The running build's version, or "dev". */
  current: string;
  /** The available version, when there is one. */
  version?: string;
  /** Release notes, as written in the changeset that produced them. */
  notes?: string;
  downloaded?: number;
  /** 0 when the release published no size — draw an indeterminate bar. */
  total?: number;
  /** Written for the person reading it; show it verbatim. */
  message?: string;
  /**
   * False when this install shape cannot replace itself — a .deb, a tarball, a
   * translocated bundle. Offer the release page rather than a download.
   */
  canSelfUpdate: boolean;
}
