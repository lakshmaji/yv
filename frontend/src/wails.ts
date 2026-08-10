// Bound Go methods are typed against the interfaces in types.ts, which mirror the
// JSON wire format. The generated wailsjs classes are deliberately not used here:
// they carry a convertValues() member that plain object literals can never satisfy.
import type {
  Project,
  CommandConfig,
  ResourceStats,
  ProjectEnvs,
  AppSettings,
  MetricsQuery,
  MetricsResult,
  FrequencyResult,
  ActivityHeatmap,
  MetricsStorageInfo,
  PeerInfo,
  ShareScope,
  ShareStatus,
  UpdateState,
} from './types';

interface WailsRuntime {
  EventsOn(event: string, callback: (...args: any[]) => void): () => void;
  EventsEmit(event: string, ...args: any[]): void;
  // Opens a URL in the system browser. Wails injects this; only the type was
  // missing. It accepts http(s) only — a file:// path is refused, which is why
  // openfolder_*.go shells out to the platform opener instead.
  BrowserOpenURL(url: string): void;
}

interface GoApp {
  /**
   * The version this binary was linked with. "dev" for any build that skipped
   * the Makefile, which is a value the About dialog shows verbatim rather than
   * hiding — knowing you are on a dev build is the point.
   */
  GetAppVersion(): Promise<string>;

  // ── Updates ───────────────────────────────────────────────────────────
  //
  // Check and Download return "ok" or "error: …" immediately and do their work
  // in the background; the answer that matters arrives as an "update:state"
  // event. That listener lives in App.tsx rather than in the dialog, so the
  // startup check is not lost when the dialog is shut.

  /** The last published state, for a dialog that has just opened. */
  GetUpdateState(): Promise<UpdateState>;
  CheckForUpdates(): Promise<string>;
  DownloadUpdate(): Promise<string>;
  /**
   * Installs the pending download and restarts. Only returns on failure, or
   * "cancelled" if the user backed out of stopping their running commands.
   */
  RestartToUpdate(): Promise<string>;
  /** Opens the releases page — the answer for an install that cannot update itself. */
  OpenReleasePage(): Promise<string>;

  LoadProjects(): Promise<Project[]>;
  SaveProjects(projects: Project[]): Promise<string>;
  ExecuteCommand(cmd: CommandConfig, workingDir: string, runID: string, projectID: string): Promise<string>;
  StopCommand(cmdId: string): Promise<string>;
  StopAllCommands(): Promise<void>;
  GetRunningCommands(): Promise<string[]>;
  GetResourceStats(): Promise<ResourceStats>;
  CheckPath(path: string): Promise<boolean>;
  PickFolder(): Promise<string>;
  ExportProjects(): Promise<string>;
  ExportProject(id: string, format: string): Promise<string>;
  ImportProjects(): Promise<string>;
  ImportProject(): Promise<string>;
  UpdateProject(id: string, name: string, dir: string, labelBgColor: string, labelTxColor: string): Promise<string>;
  SendInput(cmdId: string, text: string): Promise<string>;
  GetEnvironments(projectId: string): Promise<ProjectEnvs>;
  SaveEnvironments(projectId: string, envs: ProjectEnvs): Promise<string>;
  DeleteEnvironments(projectId: string): Promise<string>;

  GetSettings(): Promise<AppSettings>;
  SaveSettings(settings: AppSettings): Promise<string>;
  /** Native multi-select picker for sound files. Empty when cancelled. */
  PickAudioClips(): Promise<string[]>;
  /** A clip as a data URL the webview can play, or an "error: …" string. */
  GetAudioClip(path: string): Promise<string>;
  GetMetrics(req: MetricsQuery): Promise<MetricsResult>;
  GetUsageFrequency(req: MetricsQuery): Promise<FrequencyResult>;
  GetActivityHeatmap(days: number): Promise<ActivityHeatmap>;
  ClearMetrics(): Promise<string>;
  GetMetricsStorageInfo(): Promise<MetricsStorageInfo>;
  /** Starts mDNS discovery. Idempotent — safe to call on every view mount. */
  StartDiscovery(): Promise<string>;
  /** Takes this instance off the network. */
  StopDiscovery(): Promise<string>;
  /** Peers already known, for a view that mounts after discovery started. */
  GetPeers(): Promise<PeerInfo[]>;
  /**
   * What discovery can say about itself. Read by the empty-sweep dialog so it can
   * tell "nobody is there" apart from "somebody is there and refusing us".
   */
  GetShareStatus(): Promise<ShareStatus>;
  /** The hostname peers see when no username is set — the field's placeholder. */
  GetDefaultDeviceName(): Promise<string>;
  /** A fresh connection code to read out. Generated locally, no network. */
  NewConnectionCode(): Promise<string>;
  /**
   * Asks a peer to connect, blocking until their user types the code. Only the
   * code's hash crosses the wire. "ok" or "error: …".
   */
  ConnectToPeer(peerID: string, code: string): Promise<string>;
  /** Submits a typed code. "ok", "expired", or "wrong: <attempts left>". */
  AnswerConnectRequest(requestID: string, code: string): Promise<string>;
  /** Refuses a pending connection request. */
  DeclineConnectRequest(requestID: string): Promise<string>;
  /** Closes a connection accepted earlier, so that device must ask again. */
  DisconnectPeer(peerID: string): Promise<string>;
  /** Offers config to a peer and streams it on acceptance. "ok" or "error: …". */
  InitiateShare(peerID: string, scope: ShareScope, projectID: string): Promise<string>;
  /** Native multi-select picker for files to send. Empty when cancelled. */
  PickFilesToShare(): Promise<string[]>;
  /** Opens the folder received files land in, creating it if needed. */
  ShowReceivedFiles(): Promise<string>;
  /** Sends files off this machine's disk to a peer. "ok" or "error: …". */
  InitiateFileShare(peerID: string, paths: string[]): Promise<string>;
  /** Delivers the user's decision to a waiting inbound transfer. */
  RespondToShare(transferID: string, accept: boolean): Promise<string>;
}

export type { GoApp };

export const go: GoApp = (window as any)['go']['main']['App'];
export const runtime: WailsRuntime = (window as any).runtime;
