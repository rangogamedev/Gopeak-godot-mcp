export interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
  launchedAt: number;
}

import type { ChildProcess } from 'node:child_process';

export interface GodotEditorProcess {
  process: ChildProcess;
  projectPath: string;
  launchedAt: number;
  bridgePort: number;
  runtimePort: number;
  dapRelayPort: number;
}

/**
 * Per-project discovery file (`<project>/.gopeak/bridge.json`) written by the
 * gopeak server so the Godot editor/runtime addons in that project can find
 * THIS session's auto-allocated ports instead of the shared defaults. Read by
 * mcp_client.gd (bridge) and mcp_runtime_autoload.gd (runtime). Per-machine /
 * per-session — must be gitignored.
 */
export interface GopeakDiscoveryFile {
  bridge_host: string;
  bridge_port: number;
  runtime_port: number;
  runtime_bind_host: string;
  dap_relay_port: number;
  pid: number;
  version: string;
  startedAt: string;
}

export interface WSLInteropDetails {
  isWSL: boolean;
  windowsTarget: boolean;
  mode: 'native' | 'wsl_windows' | 'wsl_linux';
}

export interface PreparedGodotCommand {
  command: string;
  args: string[];
  cwd?: string;
  projectPathForDisplay: string;
  targetProjectPath: string;
}

export interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean;
}

export interface OperationParams {
  [key: string]: any;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolGroupDefinition {
  description: string;
  tools: string[];
  keywords: string[];
}
