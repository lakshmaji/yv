import type { main } from '../wailsjs/go/models';

interface WailsRuntime {
  EventsOn(event: string, callback: (...args: any[]) => void): () => void;
  EventsEmit(event: string, ...args: any[]): void;
}

interface GoApp {
  LoadProjects(): Promise<main.Project[]>;
  SaveProjects(projects: main.Project[]): Promise<string>;
  ExecuteCommand(cmd: main.CommandConfig, workingDir: string, runID: string): Promise<string>;
  StopCommand(cmdId: string): Promise<string>;
  StopAllCommands(): Promise<void>;
  GetRunningCommands(): Promise<string[]>;
  GetResourceStats(): Promise<main.ResourceStats>;
  CheckPath(path: string): Promise<boolean>;
  PickFolder(): Promise<string>;
  ExportProjects(): Promise<string>;
  ExportProject(id: string, format: string): Promise<string>;
  ImportProjects(): Promise<string>;
  ImportProject(): Promise<string>;
  UpdateProject(id: string, name: string, dir: string): Promise<string>;
  SendInput(cmdId: string, text: string): Promise<string>;
}

export const go: GoApp = (window as any)['go']['main']['App'];
export const runtime: WailsRuntime = (window as any).runtime;
