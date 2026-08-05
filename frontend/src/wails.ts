// Bound Go methods are typed against the interfaces in types.ts, which mirror the
// JSON wire format. The generated wailsjs classes are deliberately not used here:
// they carry a convertValues() member that plain object literals can never satisfy.
import type { Project, CommandConfig, ResourceStats, ProjectEnvs } from './types';

interface WailsRuntime {
  EventsOn(event: string, callback: (...args: any[]) => void): () => void;
  EventsEmit(event: string, ...args: any[]): void;
}

interface GoApp {
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
}

export const go: GoApp = (window as any)['go']['main']['App'];
export const runtime: WailsRuntime = (window as any).runtime;
