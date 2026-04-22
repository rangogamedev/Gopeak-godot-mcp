export interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
  launchedAt: number;
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
