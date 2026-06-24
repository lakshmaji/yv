export interface Project {
  id: string;
  name: string;
  workingDir: string;
  groups: string[];
  groupPaths?: Record<string, string>;
  commands: CommandConfig[];
  shortcuts?: Shortcut[];
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
  rss: number;
  cpu: number;
}
