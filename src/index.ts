#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, writeSync, mkdtempSync, rmSync, unlinkSync } from 'fs';
import { tmpdir, release } from 'os';
import { spawn, exec, execFile } from 'child_process';
import { createConnection as createTcpConnection } from 'node:net';
import { promisify } from 'util';


import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { setupResourceHandlers } from './resources.js';
import { GodotLSPClient, handleLSPTool } from './lsp_client.js';
import { GodotDAPClient, handleDAPTool } from './dap_client.js';
import {
  getWSLInteropDetails as wslGetInteropDetails,
  convertMountedPathToWindows as wslConvertMountedPathToWindows,
  ensureWSLWindowsProjectPath as wslEnsureWindowsProjectPath,
  translatePathForGodot as wslTranslatePathForGodot,
  resolveWSLWindowsTempDir,
  resolveWindowsHostIp,
  resolveDefaultRuntimeHost,
  resolveDefaultRuntimePort,
  resolveDefaultRuntimeBindHost,
  normalizePathForCrossPlatformComparison,
} from './wsl_interop.js';
import { mapProject } from './gdscript_parser.js';
import { serveVisualization, setProjectPath, stopVisualizationServer } from './visualizer-server.js';
import { GodotBridge, getDefaultBridge, createBridge, findFreePortFrom, BridgeStartupError } from './godot-bridge.js';
import type { BridgeStartupErrorInfo } from './godot-bridge.js';
import { getPrompt, listPrompts } from './prompts.js';
import { buildToolDefinitions as buildToolDefinitionsForServer } from './tool-definitions.js';
import { CORE_TOOL_GROUPS, TOOL_GROUPS } from './tool-groups.js';
import { parseStartupActiveGroups } from './startup-active-groups.js';
import { DEBUG_MODE, GODOT_DEBUG_MODE_DEFAULT, SERVER_VERSION } from './server-version.js';
import type {
  GodotProcess,
  GodotEditorProcess,
  GodotServerConfig,
  GopeakDiscoveryFile,
  MCPToolDefinition,
  OperationParams,
  PreparedGodotCommand,
  WSLInteropDetails,
} from './server-types.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Default DAP relay port (per-project ProjectSetting `mcp/editor/dap_relay_port`).
// Derived per-session by the same offset as the bridge port so concurrent
// editors get distinct relay ports. Engine DAP (6006) and LSP (6005) remain
// global editor settings and cannot be isolated per instance — see README.
const DEFAULT_DAP_RELAY_PORT = 6016;

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  private editorProcess: GodotEditorProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;
  private godotDebugMode: boolean = GODOT_DEBUG_MODE_DEFAULT;
  private lspClient: GodotLSPClient | null = null;
  private dapClient: GodotDAPClient | null = null;
  private bridgeStartupError: string | null = null;
  private bridgeStartupErrorInfo: BridgeStartupErrorInfo | null = null;
  private godotReadyPromise: Promise<void> | null = null;
  private lastProjectPath: string | null = null;
  private recordingMode: 'lite' | 'full' = (process.env.LOG_MODE === 'full' ? 'full' : 'lite');
  private logQueue: Array<{ filePath: string; payload: Record<string, unknown> }> = [];
  private logFlushTimer: NodeJS.Timeout | null = null;
  private readonly logFlushIntervalMs: number = 1500;
  private godotBridge: GodotBridge;
  // Per-session ports auto-allocated in run(). Runtime + DAP-relay derive from
  // the bridge-port offset so concurrent worktrees stay unique without a
  // (WSL-ineffective) Windows-side probe. 0 until run() resolves.
  private allocatedBridgePort = 0;
  private allocatedRuntimePort = 0;
  private allocatedDapRelayPort = 0;
  // The Godot project this session is bound to (path-gating + discovery file).
  private primaryProjectPath: string | null = null;
  private discoveryFileProject: string | null = null;
  // Single-flight guard for opt-in auto-launch (GOPEAK_AUTO_LAUNCH_EDITOR): a
  // concurrent burst of bridge tool calls shares one editor spawn instead of
  // racing to start several editors for the same project.
  private editorLaunchInFlight: Promise<{ connected: boolean; errorPayload?: Record<string, unknown> }> | null = null;
  // Last observed editor Play-button state, refreshed via the bridge on
  // get_editor_status so the agent is aware of a debug game it didn't spawn.
  private lastKnownPlayState: { is_playing: boolean; played_scene: string; fetchedAt: number } | null = null;
  private shutdownInitiated = false;
  private cachedToolDefinitions: MCPToolDefinition[] = [];
  private toolDefinitionFactory: (() => MCPToolDefinition[]) | null = null;
  private readonly toolExposureProfile: 'compact' | 'full' | 'legacy';
  private toolsListPageSize: number;
  private toolsListPageSizeExplicit: boolean = false;
  private activeGroups: Set<string> = new Set();
  private readonly compactAliasToLegacy: Record<string, string> = {
    'tool.catalog': 'tool_catalog',
    'project.list': 'list_projects',
    'project.info': 'get_project_info',
    'project.search': 'search_project',
    'project.setting.get': 'get_project_setting',
    'project.setting.set': 'set_project_setting',
    'editor.launch': 'launch_editor',
    'editor.run': 'run_project',
    'editor.run-headless': 'run_project_headless',
    'editor.stop': 'stop_project',
    'editor.close': 'close_editor',
    'editor.restart': 'restart_editor',
    'editor.fs_scanning': 'get_fs_scanning_status',
    'editor.debug_output': 'get_debug_output',
    'editor.status': 'get_editor_status',
    'editor.version': 'get_godot_version',
    'editor.play': 'play_scene',
    'editor.stop_play': 'stop_playing_scene',
    'editor.play_state': 'get_play_state',
    'scene.create': 'create_scene',
    'scene.save': 'save_scene',
    'scene.nodes': 'list_scene_nodes',
    'scene.node.add': 'add_node',
    'scene.node.properties': 'get_node_properties',
    'scene.node.set': 'set_node_properties',
    'scene.node.delete': 'delete_node',
    'script.create': 'create_script',
    'script.modify': 'modify_script',
    'script.info': 'get_script_info',
    'class.query': 'query_classes',
    'class.info': 'query_class_info',
    'signal.connect': 'connect_signal',
    'resource.dependencies': 'get_dependencies',
    'export.presets': 'list_export_presets',
    'export.run': 'export_project',
    'runtime.status': 'get_runtime_status',
    'visualizer.map': 'map_project',
    'lsp.diagnostics': 'lsp_get_diagnostics',
    'dap.output': 'dap_get_output',
    'tool.groups': 'manage_tool_groups',
  };

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    'project_path': 'projectPath',
    'scene_path': 'scenePath',
    'root_node_type': 'rootNodeType',
    'root_type': 'rootNodeType',
    'parent_node_path': 'parentNodePath',
    'node_type': 'nodeType',
    'node_name': 'nodeName',
    'texture_path': 'texturePath',
    'node_path': 'nodePath',
    'output_path': 'outputPath',
    'mesh_item_names': 'meshItemNames',
    'new_path': 'newPath',
    'file_path': 'filePath',
    'directory': 'directory',
    'recursive': 'recursive',
    'scene': 'scene',
    'source_node_path': 'sourceNodePath',
    'signal_name': 'signalName',
    'target_node_path': 'targetNodePath',
    'method_name': 'methodName',
    'player_node_path': 'playerNodePath',
    'animation_name': 'animationName',
    'loop_mode': 'loopMode',
    'plugin_name': 'pluginName',
    'action_name': 'actionName',
    'file_types': 'fileTypes',
    'case_sensitive': 'caseSensitive',
    'max_results': 'maxResults',
    'axis_value': 'axisValue',
    // 2D Tile tools
    'tileset_path': 'tilesetPath',
    'tile_size': 'tileSize',
    'tilemap_node_path': 'tilemapNodePath',
    'source_id': 'sourceId',
    'atlas_coords': 'atlasCoords',
    'alternative_tile': 'alternativeTile',
  };

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    const rawProfile = (process.env.GOPEAK_TOOL_PROFILE || process.env.MCP_TOOL_PROFILE || 'compact').toLowerCase();
    if (rawProfile === 'full' || rawProfile === 'legacy' || rawProfile === 'compact') {
      this.toolExposureProfile = rawProfile;
    } else {
      this.toolExposureProfile = 'compact';
    }

    const explicitToolsPageSize = process.env.GOPEAK_TOOLS_PAGE_SIZE;
    const rawToolsPageSize = parseInt(explicitToolsPageSize || '33', 10);
    this.toolsListPageSize = Number.isFinite(rawToolsPageSize) && rawToolsPageSize > 0
      ? rawToolsPageSize
      : 33;
    this.toolsListPageSizeExplicit = explicitToolsPageSize !== undefined && explicitToolsPageSize !== '';

    // Pre-activate dynamic tool groups listed in GOPEAK_STARTUP_ACTIVE_GROUPS
    // (or MCP_STARTUP_ACTIVE_GROUPS). Comma-separated group names matched
    // case-insensitively against Object.keys(TOOL_GROUPS). Lets clients whose
    // tool cache does not refresh on notifications/tools/list_changed (e.g.
    // Claude Code) still see commonly-needed dynamic tools in the initial
    // tools/list response without switching off the compact profile.
    // No-op unless profile=compact.
    this.applyStartupActiveGroups();

    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE_DEFAULT;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    this.godotDebugMode = godotDebugMode;

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');

    // Initialize the Godot Editor Bridge (WebSocket server for editor plugin)
    this.godotBridge = getDefaultBridge();
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'gopeak',
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: { listChanged: true },
          prompts: {},
          resources: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Set up resource handlers for godot:// URIs
    setupResourceHandlers(this.server, () => this.lastProjectPath);

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    this.setupShutdownHandlers();
  }

  // ============================================
  // Multi-session port isolation + project discovery
  // ============================================

  /**
   * Best-effort detection of the Godot project this session should serve, so a
   * discovery file can be written (and the bridge gated) before any tool call —
   * which matters when the user opens the editor manually instead of via
   * launch_editor. Resolution order: GOPEAK_PROJECT_PATH env → cwd if it holds
   * a project.godot → first one-level subdirectory that holds one. Returns null
   * when nothing is found (deferred until a project-scoped tool supplies one).
   */
  private detectPrimaryProjectPath(): string | null {
    const envPath = process.env.GOPEAK_PROJECT_PATH;
    if (envPath && envPath.trim().length > 0) {
      return normalize(envPath.trim());
    }
    const cwd = process.cwd();
    if (existsSync(join(cwd, 'project.godot'))) {
      return cwd;
    }
    try {
      for (const entry of readdirSync(cwd, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(cwd, entry.name, 'project.godot'))) {
          return join(cwd, entry.name);
        }
      }
    } catch {
      // cwd unreadable — ignore
    }
    return null;
  }

  /**
   * Bind this session to a Godot project: gate the bridge on it (so a stray
   * editor can't hijack the connection) and (re)write the per-project discovery
   * file. The most recent launch/run target wins, so an explicit tool call
   * overrides the startup cwd guess.
   */
  private ensureSessionProject(projectPath: string): void {
    const norm = normalize(projectPath);
    if (this.discoveryFileProject && this.discoveryFileProject !== norm) {
      this.removeDiscoveryFile(this.discoveryFileProject);
    }
    this.primaryProjectPath = norm;
    this.godotBridge.setExpectedProjectPath(norm);
    this.writeDiscoveryFile(norm);
  }

  /**
   * Write `<project>/.gopeak/bridge.json` so the editor/runtime addons in that
   * project connect to THIS session's auto-allocated ports. Best-effort: a
   * write failure (read-only project, permissions) is logged and ignored — the
   * server still works via env/ProjectSetting/default fallbacks.
   */
  private writeDiscoveryFile(projectPath: string): void {
    try {
      const dir = join(projectPath, '.gopeak');
      mkdirSync(dir, { recursive: true });
      const interop = wslGetInteropDetails(process.env.GODOT_PATH ?? this.godotPath ?? null);
      const status = this.godotBridge.getStatus();
      const data: GopeakDiscoveryFile = {
        bridge_host: status.host,
        bridge_port: status.port,
        runtime_port: this.allocatedRuntimePort || resolveDefaultRuntimePort(),
        runtime_bind_host: resolveDefaultRuntimeBindHost(interop),
        dap_relay_port: this.allocatedDapRelayPort || DEFAULT_DAP_RELAY_PORT,
        pid: process.pid,
        version: SERVER_VERSION,
        startedAt: new Date().toISOString(),
      };
      writeFileSync(join(dir, 'bridge.json'), JSON.stringify(data, null, 2));
      this.discoveryFileProject = projectPath;
      this.maybeHintGitignore(projectPath);
    } catch (err) {
      console.error(`[SERVER] Discovery file write skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private removeDiscoveryFile(projectPath: string | null): void {
    if (!projectPath) {
      return;
    }
    try {
      unlinkSync(join(projectPath, '.gopeak', 'bridge.json'));
    } catch {
      // already gone / never written — ignore
    }
    if (this.discoveryFileProject === projectPath) {
      this.discoveryFileProject = null;
    }
  }

  /** One-time stderr nudge to gitignore the per-session discovery file. */
  private maybeHintGitignore(projectPath: string): void {
    try {
      const gitignore = join(projectPath, '.gitignore');
      if (!existsSync(gitignore)) {
        return;
      }
      const content = readFileSync(gitignore, 'utf8');
      if (!/^\.gopeak\/?\s*$/m.test(content)) {
        console.error(`[SERVER] Hint: add '.gopeak/' to ${gitignore} (per-session discovery file; do not commit).`);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Environment for spawned Godot editor/game processes. Carries this session's
   * ports so the runtime autoload binds the right one and the editor's
   * Play-button child game (which inherits the editor env) is reachable from
   * WSL. The discovery file is the primary channel; these are belt-and-braces
   * for the gopeak-launched path.
   */
  private buildGodotSpawnEnv(): NodeJS.ProcessEnv {
    const interop = wslGetInteropDetails(process.env.GODOT_PATH ?? this.godotPath ?? null);
    return {
      ...process.env,
      GOPEAK_BRIDGE_PORT: String(this.allocatedBridgePort || this.godotBridge.getStatus().port),
      GOPEAK_RUNTIME_PORT: String(this.allocatedRuntimePort || resolveDefaultRuntimePort()),
      GOPEAK_RUNTIME_BIND_HOST: resolveDefaultRuntimeBindHost(interop),
    };
  }

  /**
   * Start the bridge, reallocating to a higher port if the chosen one turns out
   * to be taken between the free-port probe and the bind (EADDRINUSE) or held by
   * a healthy peer's lockfile (OTHER) — the multi-session race. Re-applies the
   * project gate after each reconstruction.
   */
  private async startBridgeWithRetry(host: string, maxRetries = 4): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await this.godotBridge.start();
        return;
      } catch (err) {
        const portClash = err instanceof BridgeStartupError
          && (err.info.code === 'EADDRINUSE' || err.info.code === 'OTHER');
        if (!portClash || attempt >= maxRetries) {
          throw err;
        }
        attempt += 1;
        const busyPort = this.godotBridge.getStatus().port;
        const freePort = await findFreePortFrom(busyPort + 1, host);
        console.error(`[SERVER] Bridge port ${busyPort} unavailable (${err.info.code}); retrying on ${freePort}.`);
        this.godotBridge = createBridge(freePort, undefined, host);
        if (this.primaryProjectPath) {
          this.godotBridge.setExpectedProjectPath(this.primaryProjectPath);
        }
      }
    }
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      await execFileAsync(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Glob Windows-side Program Files for Godot installs, usable from WSL.
   * Returns candidates newest-version-first (best-effort semver sort on
   * the enclosing directory name).
   */
  private findWSLWindowsGodotCandidates(): string[] {
    const programRoots = [
      '/mnt/c/Program Files',
      '/mnt/c/Program Files (x86)',
    ];
    const candidates: Array<{ path: string; version: number[] }> = [];

    for (const root of programRoots) {
      if (!existsSync(root)) continue;
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!/^Godot(_v|_)/i.test(entry)) continue;
        const dirPath = join(root, entry);
        let files: string[];
        try {
          files = readdirSync(dirPath);
        } catch {
          continue;
        }
        const godotExe = files.find((f) => /^Godot.*\.exe$/i.test(f));
        if (!godotExe) continue;

        const versionMatch = entry.match(/_v?(\d+)\.(\d+)(?:\.(\d+))?/);
        const version = versionMatch
          ? [versionMatch[1], versionMatch[2], versionMatch[3] ?? '0'].map((n) => parseInt(n, 10))
          : [0, 0, 0];

        candidates.push({ path: join(dirPath, godotExe), version });
      }
    }

    candidates.sort((a, b) => {
      for (let i = 0; i < 3; i += 1) {
        const diff = (b.version[i] ?? 0) - (a.version[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

    return candidates.map((c) => c.path);
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );

      // WSL — also probe Windows-side Program Files for Godot installs
      // so first-run UX on WSL doesn't require manual GODOT_PATH.
      if (release().toLowerCase().includes('microsoft')) {
        for (const wslCandidate of this.findWSLWindowsGodotCandidates()) {
          possiblePaths.push(wslCandidate);
        }
      }
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Run Godot-path detection + validation off the startup critical path.
   * Called after the stdio transport is attached so MCP handshake does
   * not block on the slow Windows-exe `--version` spawn from WSL.
   * Tool handlers either await `this.godotReadyPromise` explicitly or
   * fall through to the lazy-detect guards already in `executeOperation`
   * / `getGodotVersionText`.
   */
  private async detectAndValidateGodotPath(): Promise<void> {
    await this.detectGodotPath();

    if (!this.godotPath) {
      console.error('[SERVER] Failed to find a valid Godot executable path');
      console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
      if (this.strictPathValidation) {
        process.exit(1);
      }
      return;
    }

    const isValid = await this.isValidGodotPath(this.godotPath);

    if (!isValid) {
      if (this.strictPathValidation) {
        console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
        console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }
      console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
      console.error('[SERVER] This may cause issues when executing Godot commands');
      console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
      return;
    }

    console.error(`[SERVER] Using Godot at: ${this.godotPath}`);
  }

  private getWSLInteropDetails(godotPath: string | null = this.godotPath): WSLInteropDetails {
    return wslGetInteropDetails(godotPath);
  }

  private convertMountedPathToWindows(path: string): string | null {
    return wslConvertMountedPathToWindows(path);
  }

  private ensureWSLWindowsProjectPath(projectPath: string): void {
    wslEnsureWindowsProjectPath(projectPath);
  }

  private translatePathForGodot(path: string, details: WSLInteropDetails, label: string): string {
    return wslTranslatePathForGodot(path, details, label);
  }

  private prepareProjectScopedCommand(
    projectPath: string,
    prefixArgs: string[] = [],
    suffixArgs: string[] = []
  ): PreparedGodotCommand {
    if (!this.godotPath) {
      throw new Error('Could not find a valid Godot executable path');
    }

    const interop = this.getWSLInteropDetails(this.godotPath);
    if (interop.mode === 'wsl_windows') {
      this.ensureWSLWindowsProjectPath(projectPath);
      return {
        command: this.godotPath,
        args: [...prefixArgs, '--path', '.', ...suffixArgs],
        cwd: projectPath,
        projectPathForDisplay: projectPath,
        targetProjectPath: '.',
      };
    }

    return {
      command: this.godotPath,
      args: [...prefixArgs, '--path', projectPath, ...suffixArgs],
      projectPathForDisplay: projectPath,
      targetProjectPath: projectPath,
    };
  }

  private async getGodotVersionText(timeout?: number): Promise<string> {
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const execOptions = timeout ? { timeout } : undefined;
    const { stdout } = await execFileAsync(this.godotPath, ['--version'], execOptions);
    return String(stdout).trim();
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    this.flushLogQueue();

    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
    if (this.lspClient) {
      try { await this.lspClient.disconnect(); } catch {}
      this.lspClient = null;
    }
    if (this.dapClient) {
      try { await this.dapClient.disconnect(); } catch {}
      this.dapClient = null;
    }
    stopVisualizationServer();
    this.removeDiscoveryFile(this.discoveryFileProject);
    if (this.godotBridge) {
      try { await this.godotBridge.stop(); } catch {}
    }
    await this.server.close();
  }

  private setupShutdownHandlers(): void {
    const requestShutdown = (source: string, exitCode?: number): void => {
      void this.handleShutdown(source, exitCode);
    };

    process.once('SIGINT', () => requestShutdown('SIGINT', 0));
    process.once('SIGTERM', () => requestShutdown('SIGTERM', 0));
    process.once('SIGHUP', () => requestShutdown('SIGHUP', 0));
    process.once('beforeExit', (code: number) => requestShutdown(`beforeExit:${code}`));
    process.once('exit', () => this.forceCleanupOnExit());

    // Standard MCP-stdio shutdown: the parent (Claude Code, MCP Inspector,
    // etc.) signals teardown by closing stdin. Without this handler, gopeak
    // would survive its parent and orphan onto PID 1 — the root cause of the
    // bridge-reliability incidents documented in wiki/topics/mcp_fork_notes.md
    // and feedback memory feedback_mcp_bridge_reliability. Three independent
    // mechanisms cover the failure mode because each can be inhibited by
    // specific SDK/transport behaviors:
    //   (1) `process.stdin.on('end'|'close')` — fires when the parent closes
    //       its writable side of the pipe. Most reliable when the SDK
    //       transport keeps stdin in flowing mode.
    //   (2) `transport.onclose` — wired in run() once the transport exists.
    //       Fires only when transport.close() is called explicitly by the
    //       SDK; not a substitute for (1) but useful when present.
    //   (3) Parent-process watchdog — polls `process.ppid` every 2s. When
    //       PPid flips to 1 (orphaned to init), the parent is gone; exit.
    //       This is the belt-and-suspenders safety net.
    const onStdinClose = (source: string) => {
      if (!this.shutdownInitiated) {
        console.error(`[SERVER] Parent stdio closed (${source}) — shutting down gracefully`);
      }
      requestShutdown(source, 0);
    };
    process.stdin.on('end', () => onStdinClose('stdin:end'));
    process.stdin.on('close', () => onStdinClose('stdin:close'));

    // Mechanism (3): parent-watchdog. If PPid changes to 1, the parent
    // died and the process was reparented to init — exit. Only orphan-to-init
    // is checked; a generic ppid change (e.g. systemd user-session restart,
    // tmux re-attach) would spuriously shut down a healthy gopeak.
    // Negligible cost: one syscall every 2 seconds.
    const initialPpid = typeof process.ppid === 'number' ? process.ppid : -1;
    if (initialPpid > 1) {
      const watchdog = setInterval(() => {
        const ppidNow = typeof process.ppid === 'number' ? process.ppid : -1;
        if (ppidNow === 1) {
          if (!this.shutdownInitiated) {
            console.error(`[SERVER] Parent process died (ppid ${initialPpid} → 1, orphaned to init) — shutting down gracefully`);
          }
          clearInterval(watchdog);
          requestShutdown('parent-watchdog', 0);
        }
      }, 2000);
      // Don't keep the event loop alive solely for this poll.
      watchdog.unref?.();
    }
  }

  private async handleShutdown(source: string, exitCode?: number): Promise<void> {
    if (this.shutdownInitiated) {
      return;
    }

    this.shutdownInitiated = true;
    this.logDebug(`Shutting down server via ${source}`);

    try {
      await this.cleanup();
    } catch (error) {
      console.error(`[SERVER] Shutdown cleanup failed (${source}):`, error);
    } finally {
      if (typeof exitCode === 'number') {
        process.exit(exitCode);
      }
    }
  }

  private forceCleanupOnExit(): void {
    if (this.shutdownInitiated) {
      return;
    }
    this.shutdownInitiated = true;

    if (this.activeProcess) {
      try {
        this.activeProcess.process.kill();
      } catch {}
      this.activeProcess = null;
    }

    this.removeDiscoveryFile(this.discoveryFileProject);

    if (this.godotBridge) {
      void this.godotBridge.stop().catch(() => {});
    }
  }

  private async handleRuntimeCommand(
    command: string,
    args: unknown,
  ): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
    const params = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
    // Target THIS session's allocated runtime port (falls back to the env/default
    // before run() finishes wiring it), not the shared default — otherwise two
    // sessions would both probe 7777 and only one game would be reachable.
    const RUNTIME_PORT = this.allocatedRuntimePort || resolveDefaultRuntimePort();
    const RUNTIME_HOST = resolveDefaultRuntimeHost();
    const timeoutOverride = Number.parseInt(process.env.GOPEAK_RUNTIME_TIMEOUT_MS || '', 10);
    const TIMEOUT_MS = Number.isInteger(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : 10000;
    const expectsScreenshot = command === 'capture_screenshot' || command === 'capture_viewport';
    // Under WSL→Windows Godot, the runtime addon writes the PNG from the WINDOWS Godot process, which
    // cannot write a Linux /tmp path (FileAccess fails: "Failed to save screenshot as PNG: 7"). Put the
    // temp file under a Windows-visible dir (e.g. /mnt/c/.../Temp) and hand Godot the Windows-form path
    // as output_path; the server reads it back via the Linux-form path (same physical file). Mirrors the
    // editor capture_editor_viewport path. Non-WSL: both forms are identical, so this is a no-op there.
    const screenshotInterop = this.getWSLInteropDetails(this.godotPath);
    const screenshotTempRoot = resolveWSLWindowsTempDir(screenshotInterop) ?? tmpdir();
    const screenshotDir = expectsScreenshot ? mkdtempSync(join(screenshotTempRoot, 'gopeak-runtime-screenshot-')) : null;
    const screenshotPath = screenshotDir ? join(screenshotDir, 'capture.png') : null;
    const screenshotPathForGodot = screenshotPath
      ? wslTranslatePathForGodot(screenshotPath, screenshotInterop, 'Runtime screenshot file')
      : null;
    const runtimeParams = screenshotPathForGodot ? { ...params, output_path: screenshotPathForGodot } : params;
    const cleanupScreenshotDir = () => {
      if (screenshotDir) {
        rmSync(screenshotDir, { recursive: true, force: true });
      }
    };

    return new Promise((resolve) => {
      const socket = createTcpConnection({ port: RUNTIME_PORT, host: RUNTIME_HOST }, () => {
        const payload = JSON.stringify({ command, params: runtimeParams, id: Date.now() });
        socket.write(payload + '\n');
      });

      let responseBuffer = Buffer.alloc(0);
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        socket.destroy();
        cleanupScreenshotDir();
        resolve({
          content: [{ type: 'text', text: `Runtime command '${command}' timed out after ${TIMEOUT_MS}ms. Ensure the Godot game is running with the MCP runtime addon enabled.` }],
        });
      }, TIMEOUT_MS);

      const resolveRuntimePayload = (parsed: any) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timer);
        socket.destroy();

        if (parsed.type === 'screenshot_file' && parsed.path) {
          const returnedPath = String(parsed.path);
          if (!screenshotPath || !screenshotPathForGodot || normalize(returnedPath) !== normalize(screenshotPathForGodot)) {
            cleanupScreenshotDir();
            resolve({
              content: [{ type: 'text', text: `Rejected screenshot file path outside the GoPeak-managed capture path: '${returnedPath}'` }],
            });
            return;
          }
          try {
            const imageData = readFileSync(screenshotPath).toString('base64');
            cleanupScreenshotDir();
            resolve({
              content: [
                { type: 'text', text: `Screenshot captured: ${parsed.width}x${parsed.height} ${parsed.format}` },
                { type: 'image', data: imageData, mimeType: 'image/png' },
              ],
            });
          } catch (error) {
            cleanupScreenshotDir();
            const message = error instanceof Error ? error.message : String(error);
            resolve({
              content: [{ type: 'text', text: `Failed to read screenshot file '${screenshotPath}': ${message}` }],
            });
          }
          return;
        }

        if (parsed.type === 'screenshot' && parsed.data) {
          cleanupScreenshotDir();
          resolve({
            content: [
              { type: 'text', text: `Screenshot captured: ${parsed.width}x${parsed.height} ${parsed.format}` },
              { type: 'image', data: parsed.data, mimeType: 'image/png' },
            ],
          });
          return;
        }

        cleanupScreenshotDir();
        resolve({
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        });
      };

      socket.on('data', (chunk: Buffer) => {
        responseBuffer = Buffer.concat([responseBuffer, Buffer.from(chunk)]);
        const parsedMessages: any[] = [];

        const parseCandidate = (candidate: string) => {
          const trimmed = candidate.trim();
          if (!trimmed) {
            return;
          }
          try {
            parsedMessages.push(JSON.parse(trimmed));
          } catch {
            // Ignore malformed frame/line and keep scanning.
          }
        };

        // First, parse the framed payload format emitted by Godot's StreamPeerTCP.put_utf8_string().
        let offset = 0;
        while (offset + 4 <= responseBuffer.length) {
          const frameLength = responseBuffer.readUInt32LE(offset);
          if (frameLength <= 0 || offset + 4 + frameLength > responseBuffer.length) {
            break;
          }

          const frame = responseBuffer.subarray(offset + 4, offset + 4 + frameLength).toString('utf8');
          parseCandidate(frame);
          offset += 4 + frameLength;
        }
        if (offset > 0) {
          responseBuffer = responseBuffer.subarray(offset);
        }

        // Fallback for plain newline-delimited JSON payloads.
        let newlineIndex = responseBuffer.indexOf(0x0a);
        while (newlineIndex !== -1) {
          const line = responseBuffer.subarray(0, newlineIndex).toString('utf8');
          responseBuffer = responseBuffer.subarray(newlineIndex + 1);
          parseCandidate(line);
          newlineIndex = responseBuffer.indexOf(0x0a);
        }

        if (parsedMessages.length > 0) {
          const candidate = parsedMessages.find((message) => message?.type === 'screenshot_file' && message?.path)
            ?? parsedMessages.find((message) => message?.type === 'screenshot' && message?.data)
            ?? parsedMessages.find((message) => message?.type === 'pong')
            ?? parsedMessages.find((message) => message?.type && message.type !== 'welcome')
            ?? null;

          if (candidate) {
            resolveRuntimePayload(candidate);
          }
        }
      });

      socket.on('end', () => {
        if (resolved) {
          return;
        }

        clearTimeout(timer);
        const responseData = responseBuffer.toString('utf8').trim();
        resolved = true;
        cleanupScreenshotDir();
        try {
          const parsed = JSON.parse(responseData);
          resolve({
            content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
          });
        } catch {
          resolve({
            content: [{ type: 'text', text: responseData || 'Command sent successfully (no structured response).' }],
          });
        }
      });

      socket.on('error', (error: Error) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timer);
        cleanupScreenshotDir();
        resolve({
          content: [{ type: 'text', text: `Failed to connect to Godot runtime addon at ${RUNTIME_HOST}:${RUNTIME_PORT}: ${error.message}. Ensure the game is running with the MCP runtime autoload enabled.` }],
        });
      });
    });
  }

  private async handleLSP(toolName: string, args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!this.lspClient) {
      this.lspClient = new GodotLSPClient();
    }
    return handleLSPTool(this.lspClient, toolName, args);
  }

  private async handleDAP(toolName: string, args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!this.dapClient) {
      this.dapClient = new GodotDAPClient();
    }
    return handleDAPTool(this.dapClient, toolName, args);
  }

  private sanitizeExportedToolName(toolName: string): string {
    const sanitized = toolName
      .normalize('NFKD')
      .replace(/[^\x00-\x7F]/g, '')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 128);

    return sanitized.length > 0 ? sanitized : 'tool';
  }

  private buildToolNameResolutionMap(allTools: MCPToolDefinition[]): Map<string, string> {
    const resolutionMap = new Map<string, string>();

    const register = (candidateName: string, resolvedName: string) => {
      const existing = resolutionMap.get(candidateName);
      if (existing && existing !== resolvedName) {
        throw new Error(`Sanitized tool name collision: "${candidateName}" maps to both "${existing}" and "${resolvedName}"`);
      }
      resolutionMap.set(candidateName, resolvedName);
    };

    for (const tool of allTools) {
      register(tool.name, tool.name);
      register(this.sanitizeExportedToolName(tool.name), tool.name);
    }

    for (const [compactName, legacyName] of Object.entries(this.compactAliasToLegacy)) {
      register(compactName, legacyName);
      register(this.sanitizeExportedToolName(compactName), legacyName);
    }

    return resolutionMap;
  }

  private resolveToolAlias(requestedToolName: string): string {
    const allTools = this.getAllToolDefinitions();
    const resolutionMap = this.buildToolNameResolutionMap(allTools);
    return resolutionMap.get(requestedToolName)
      || resolutionMap.get(this.sanitizeExportedToolName(requestedToolName))
      || requestedToolName;
  }

  private buildCompactTools(allTools: MCPToolDefinition[]): MCPToolDefinition[] {
    const compactTools: MCPToolDefinition[] = [];

    for (const [compactName, legacyName] of Object.entries(this.compactAliasToLegacy)) {
      const source = allTools.find((tool) => tool.name === legacyName);
      if (!source) {
        continue;
      }

      compactTools.push({
        ...source,
        name: compactName,
        description: `[compact alias of ${legacyName}] ${source.description}`,
      });
    }

    return compactTools;
  }

  private jsonTextResponse(payload: unknown): { content: Array<{ type: string; text: string }> } {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      }],
    };
  }

  private buildLegacyToCompactAliasMap(): Map<string, string> {
    return new Map(
      Object.entries(this.compactAliasToLegacy).map(([compactName, legacyName]) => [legacyName, compactName]),
    );
  }

  private buildToolGroupLookup(): Map<string, { group: string; type: 'core' | 'dynamic' }> {
    const toolToGroup = new Map<string, { group: string; type: 'core' | 'dynamic' }>();
    const registerGroups = (groups: Record<string, { tools: string[] }>, type: 'core' | 'dynamic') => {
      for (const [groupName, group] of Object.entries(groups)) {
        for (const toolName of group.tools) {
          toolToGroup.set(toolName, { group: groupName, type });
        }
      }
    };

    registerGroups(CORE_TOOL_GROUPS, 'core');
    registerGroups(TOOL_GROUPS, 'dynamic');

    return toolToGroup;
  }

  private getActivatedToolNames(): Set<string> {
    const activatedToolNames = new Set<string>();

    for (const groupName of this.activeGroups) {
      const group = TOOL_GROUPS[groupName];
      if (!group) {
        continue;
      }

      for (const toolName of group.tools) {
        activatedToolNames.add(toolName);
      }
    }

    return activatedToolNames;
  }

  private getAvailableDynamicGroups(): string[] {
    return Object.keys(TOOL_GROUPS);
  }

  private getUnknownDynamicGroupError(groupName: string): string {
    return `Unknown group '${groupName}'. Available dynamic groups: ${this.getAvailableDynamicGroups().join(', ')}`;
  }

  private notifyToolListChanged(): void {
    this.cachedToolDefinitions = [];
    this.server.sendToolListChanged().catch(() => {});
  }

  /**
   * Seed `this.activeGroups` from `GOPEAK_STARTUP_ACTIVE_GROUPS` (or fallback
   * `MCP_STARTUP_ACTIVE_GROUPS`). Called from the constructor before
   * `this.server` is instantiated, so the first `tools/list` response on MCP
   * handshake already includes these groups' tools. This is the workaround
   * for clients whose tool cache does not refresh on
   * `notifications/tools/list_changed` (e.g. Claude Code).
   *
   * Contract:
   *  - Unset or empty env: no-op.
   *  - `toolExposureProfile !== 'compact'`: no-op + one-line stderr warning
   *    (full/legacy already expose all tools, so pre-activation is redundant).
   *  - Unknown group names: per-batch stderr warning; valid names still applied.
   *  - Case-insensitive match against `Object.keys(TOOL_GROUPS)`.
   *  - Whitespace around commas tolerated; empty items dropped.
   *
   * Parse logic lives in `./startup-active-groups.ts` as a pure function so
   * it is unit-testable without spawning the MCP server.
   */
  private applyStartupActiveGroups(): void {
    const raw = process.env.GOPEAK_STARTUP_ACTIVE_GROUPS ?? process.env.MCP_STARTUP_ACTIVE_GROUPS ?? '';
    if (raw.trim() === '') {
      return;
    }

    if (this.toolExposureProfile !== 'compact') {
      console.error(
        `[SERVER] GOPEAK_STARTUP_ACTIVE_GROUPS ignored under profile=${this.toolExposureProfile} ` +
        `(only the compact profile benefits from pre-activation; full/legacy already expose all tools).`,
      );
      return;
    }

    const knownGroups = Object.keys(TOOL_GROUPS);
    const { activated, unknown } = parseStartupActiveGroups(raw, knownGroups);

    for (const name of activated) {
      this.activeGroups.add(name);
    }

    if (unknown.length > 0) {
      console.error(
        `[SERVER] GOPEAK_STARTUP_ACTIVE_GROUPS: ignoring unknown group(s): ${unknown.join(', ')}. ` +
        `Known dynamic groups: ${knownGroups.join(', ')}.`,
      );
    }

    if (activated.length > 0) {
      console.error(
        `[SERVER] Pre-activating ${activated.length} tool group(s) from startup env: ${activated.join(', ')}.`,
      );
    }

    // Auto-raise the tools/list page size if pre-activation pushes the
    // exposed tool count past the configured page. MCP `tools/list` chunks
    // at `toolsListPageSize` with `nextCursor` for subsequent pages;
    // clients that do not follow `nextCursor` for deferred-tool discovery
    // (Claude Code) only see page 1, so pre-activated dynamic tools would
    // be stranded on page 2+. Only auto-raise when the user has not set
    // `GOPEAK_TOOLS_PAGE_SIZE` explicitly.
    if (!this.toolsListPageSizeExplicit && this.toolExposureProfile === 'compact' && activated.length > 0) {
      let activatedToolCount = 0;
      for (const groupName of activated) {
        const group = TOOL_GROUPS[groupName];
        if (group) {
          activatedToolCount += group.tools.length;
        }
      }
      const compactAliasCount = Object.keys(this.compactAliasToLegacy).length;
      const needed = compactAliasCount + activatedToolCount;
      if (needed > this.toolsListPageSize) {
        console.error(
          `[SERVER] Raising tools/list page size ${this.toolsListPageSize} → ${needed} so all pre-activated tools fit in the first page (clients that do not follow nextCursor would otherwise miss ${needed - this.toolsListPageSize} tool(s)). Set GOPEAK_TOOLS_PAGE_SIZE explicitly to override.`,
        );
        this.toolsListPageSize = needed;
      }
    }
  }

  private autoActivateMatchingGroups(query: string): string[] {
    if (!query || this.toolExposureProfile !== 'compact') {
      return [];
    }

    const newlyActivated: string[] = [];
    for (const [groupName, group] of Object.entries(TOOL_GROUPS)) {
      if (this.activeGroups.has(groupName)) {
        continue;
      }

      const hasMatchingKeyword = group.keywords.some((kw) => query.includes(kw) || kw.includes(query));
      const hasMatchingToolName = group.tools.some((toolName) => toolName.toLowerCase().includes(query));
      if (hasMatchingKeyword || hasMatchingToolName) {
        this.activeGroups.add(groupName);
        newlyActivated.push(groupName);
      }
    }

    if (newlyActivated.length > 0) {
      this.notifyToolListChanged();
    }

    return newlyActivated;
  }

  private setDynamicGroupActivation(groupName: string, active: boolean): boolean {
    const wasActive = this.activeGroups.has(groupName);

    if (active) {
      this.activeGroups.add(groupName);
    } else {
      this.activeGroups.delete(groupName);
    }

    if (wasActive !== active) {
      this.notifyToolListChanged();
    }

    return wasActive;
  }

  private sanitizeToolsForList(tools: MCPToolDefinition[]): MCPToolDefinition[] {
    const seenNames = new Map<string, string>();

    return tools.map((tool) => {
      const sanitizedName = this.sanitizeExportedToolName(tool.name);
      const existing = seenNames.get(sanitizedName);
      if (existing && existing !== tool.name) {
        throw new Error(`Sanitized tool name collision in tools/list: "${sanitizedName}" from "${existing}" and "${tool.name}"`);
      }

      seenNames.set(sanitizedName, tool.name);

      if (sanitizedName !== tool.name) {
        this.logDebug(`Exporting tool "${tool.name}" as "${sanitizedName}" for OpenAI-compatible clients`);
      }

      return sanitizedName === tool.name
        ? tool
        : {
            ...tool,
            name: sanitizedName,
          };
    });
  }

  private getExposedTools(allTools: MCPToolDefinition[]): MCPToolDefinition[] {
    if (this.toolExposureProfile === 'full' || this.toolExposureProfile === 'legacy') {
      return allTools;
    }

    // Start with compact profile tools
    const exposed = this.buildCompactTools(allTools);

    // Add dynamically activated group tools (using their legacy names)
    if (this.activeGroups.size > 0) {
      const activatedToolNames = this.getActivatedToolNames();

      for (const tool of allTools) {
        if (activatedToolNames.has(tool.name)) {
          exposed.push({
            ...tool,
            description: `[dynamic] ${tool.description}`,
          });
        }
      }
    }

    return exposed;
  }

  private parseToolsListCursor(cursor: unknown, total: number): number {
    if (typeof cursor !== 'string' || cursor.length === 0) {
      return 0;
    }

    const offset = Number.parseInt(cursor, 10);
    if (!Number.isInteger(offset) || offset < 0 || offset > total) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid tools/list cursor: ${cursor}`);
    }

    return offset;
  }

  private paginateToolsForList(tools: MCPToolDefinition[], cursor: unknown): { tools: MCPToolDefinition[]; nextCursor?: string } {
    const start = this.parseToolsListCursor(cursor, tools.length);
    const end = Math.min(start + this.toolsListPageSize, tools.length);
    const page = tools.slice(start, end);

    if (end < tools.length) {
      return {
        tools: page,
        nextCursor: String(end),
      };
    }

    return { tools: page };
  }

  private getAllToolDefinitions(): MCPToolDefinition[] {
    if (this.cachedToolDefinitions.length > 0) {
      return this.cachedToolDefinitions;
    }

    if (this.toolDefinitionFactory) {
      this.cachedToolDefinitions = this.toolDefinitionFactory();
    }

    return this.cachedToolDefinitions;
  }

  private getMissingRequiredArguments(toolName: string, args: Record<string, unknown>): string[] {
    const toolDefinition = this.getAllToolDefinitions().find((tool) => tool.name === toolName);
    const required = (toolDefinition?.inputSchema as { required?: unknown } | undefined)?.required;

    if (!Array.isArray(required) || required.length === 0) {
      return [];
    }

    return required
      .filter((field): field is string => typeof field === 'string')
      .filter((field) => {
        const value = args[field];
        return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
      });
  }

  private async handleToolCatalog(args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    const normalizedArgs = this.normalizeParameters(args || {});
    const query = typeof normalizedArgs.query === 'string' ? normalizedArgs.query.trim().toLowerCase() : '';
    const rawLimit = typeof normalizedArgs.limit === 'number' ? normalizedArgs.limit : 30;
    const limit = Math.max(1, Math.min(100, rawLimit));

    const tools = this.getAllToolDefinitions();
    const reverseAlias = this.buildLegacyToCompactAliasMap();
    const toolToGroup = this.buildToolGroupLookup();

    const filtered = tools.filter((tool) => {
      if (!query) return true;
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      return haystack.includes(query);
    });

    const items = filtered.slice(0, limit).map((tool) => {
      const groupInfo = toolToGroup.get(tool.name) || null;
      return {
        tool: tool.name,
        compactAlias: reverseAlias.get(tool.name) || null,
        group: groupInfo?.group || null,
        groupType: groupInfo?.type || null,
        description: tool.description,
      };
    });

    // Auto-activate matching tool groups when query matches their keywords
    // or when the query directly matches a group's tool NAME (not description).
    // This prevents over-activation from incidental description matches.
    const newlyActivated = this.autoActivateMatchingGroups(query);

    return this.jsonTextResponse({
      profile: this.toolExposureProfile,
      totalTools: tools.length,
      query: query || null,
      returned: items.length,
      activeGroups: Array.from(this.activeGroups),
      newlyActivated: newlyActivated.length > 0 ? newlyActivated : undefined,
      tools: items,
    });
  }

  private async handleManageToolGroups(args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    const normalizedArgs = this.normalizeParameters(args || {});
    const action = typeof normalizedArgs.action === 'string' ? normalizedArgs.action.toLowerCase() : 'status';
    const groupName = typeof normalizedArgs.group === 'string' ? normalizedArgs.group : '';

    switch (action) {
      case 'list': {
        const coreGroups = Object.entries(CORE_TOOL_GROUPS).map(([name, group]) => ({
          name,
          type: 'core' as const,
          description: group.description,
          tools: group.tools,
          toolCount: group.tools.length,
          alwaysVisible: true,
        }));
        const dynamicGroups = Object.entries(TOOL_GROUPS).map(([name, group]) => ({
          name,
          type: 'dynamic' as const,
          description: group.description,
          tools: group.tools,
          toolCount: group.tools.length,
          active: this.activeGroups.has(name),
        }));
        const allGroups = [...coreGroups, ...dynamicGroups];
        const totalCoreTools = coreGroups.reduce((sum, g) => sum + g.toolCount, 0);
        const totalDynTools = dynamicGroups.reduce((sum, g) => sum + g.toolCount, 0);
        return this.jsonTextResponse({
          totalGroups: allGroups.length,
          coreGroups: coreGroups.length,
          dynamicGroups: dynamicGroups.length,
          coreTools: totalCoreTools,
          dynamicTools: totalDynTools,
          groups: allGroups,
        });
      }

      case 'activate': {
        if (groupName && CORE_TOOL_GROUPS[groupName]) {
          return this.jsonTextResponse({ error: `'${groupName}' is a core group and always visible. No activation needed.` });
        }
        if (!groupName || !TOOL_GROUPS[groupName]) {
          return this.jsonTextResponse({ error: this.getUnknownDynamicGroupError(groupName) });
        }
        const wasAlreadyActive = this.setDynamicGroupActivation(groupName, true);
        return this.jsonTextResponse({
          activated: groupName,
          tools: TOOL_GROUPS[groupName].tools,
          wasAlreadyActive,
          activeGroups: Array.from(this.activeGroups),
        });
      }

      case 'deactivate': {
        if (groupName && CORE_TOOL_GROUPS[groupName]) {
          return this.jsonTextResponse({ error: `'${groupName}' is a core group and cannot be deactivated.` });
        }
        if (!groupName || !TOOL_GROUPS[groupName]) {
          return this.jsonTextResponse({ error: this.getUnknownDynamicGroupError(groupName) });
        }
        const wasActive = this.setDynamicGroupActivation(groupName, false);
        return this.jsonTextResponse({
          deactivated: groupName,
          wasActive,
          activeGroups: Array.from(this.activeGroups),
        });
      }

      case 'reset': {
        const previouslyActive = Array.from(this.activeGroups);
        this.activeGroups.clear();
        if (previouslyActive.length > 0) {
          this.notifyToolListChanged();
        }
        return this.jsonTextResponse({
          reset: true,
          deactivated: previouslyActive,
          activeGroups: [],
        });
      }

      case 'status':
      default: {
        const coreGroupDetails = Object.entries(CORE_TOOL_GROUPS).map(([name, group]) => ({
          name,
          type: 'core' as const,
          description: group.description,
          tools: group.tools,
          alwaysVisible: true,
        }));
        const activeGroupDetails = Array.from(this.activeGroups).map((name) => ({
          name,
          type: 'dynamic' as const,
          description: TOOL_GROUPS[name]?.description,
          tools: TOOL_GROUPS[name]?.tools,
        }));
        const totalCoreTools = coreGroupDetails.reduce((sum, g) => sum + g.tools.length, 0);
        const totalDynamicTools = activeGroupDetails.reduce((sum, g) => sum + (g.tools?.length || 0), 0);
        return this.jsonTextResponse({
          coreGroups: { count: coreGroupDetails.length, tools: totalCoreTools, groups: coreGroupDetails },
          dynamicGroups: { activeCount: this.activeGroups.size, tools: totalDynamicTools, groups: activeGroupDetails },
          availableDynamicGroups: this.getAvailableDynamicGroups(),
        });
      }
    }
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') {
      return params;
    }
    
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        let normalizedKey = key;
        
        // Preserve sentinel keys like _type, but normalize regular snake_case keys.
        if (key.startsWith('_')) {
          normalizedKey = key;
        } else if (key.includes('_')) {
          normalizedKey = this.parameterMappings[key] || key.replace(/_([a-zA-Z0-9])/g, (_, letter: string) => letter.toUpperCase());
        }
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        } else {
          result[normalizedKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        // Convert camelCase to snake_case while preserving sentinel keys like _type.
        const snakeKey = key.startsWith('_')
          ? key
          : (this.reverseParameterMappings[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`));
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize parameters into a temp file to avoid shell/cmd JSON escaping issues
      // (notably Windows command-line parsing of sequences such as \t, \r, and \").
      // Under WSL→Windows Godot, /tmp is not visible to the Windows process — write
      // the payload to a Windows-visible location (e.g. /mnt/c/Windows/Temp) and
      // pass the Windows-form path via the @file: flag so Godot's FileAccess can
      // resolve it.
      const paramsJson = JSON.stringify(snakeCaseParams);
      const interop = this.getWSLInteropDetails(this.godotPath);
      const windowsTempRoot = resolveWSLWindowsTempDir(interop);
      const paramsRoot = windowsTempRoot ?? tmpdir();
      const paramsDir = mkdtempSync(join(paramsRoot, 'gopeak-params-'));
      const paramsFilePath = join(paramsDir, `${operation}.json`);
      writeFileSync(paramsFilePath, paramsJson, 'utf8');
      const paramsFilePathForGodot = wslTranslatePathForGodot(
        paramsFilePath,
        interop,
        'Operation params file'
      );

      // Add debug arguments if debug mode is enabled
      const debugArgs = this.godotDebugMode ? ['--debug-godot'] : [];
      const operationsScriptPath = this.translatePathForGodot(
        this.operationsScriptPath,
        interop,
        'Godot operations script'
      );
      const prepared = this.prepareProjectScopedCommand(
        projectPath,
        ['--headless'],
        ['--script', operationsScriptPath, operation, `@file:${paramsFilePathForGodot}`, ...debugArgs]
      );

      this.logDebug(`Command: ${prepared.command} ${prepared.args.join(' ')}`);

      try {
        const execOptions = prepared.cwd ? { cwd: prepared.cwd } : undefined;
        const { stdout, stderr } = await execFileAsync(prepared.command, prepared.args, execOptions);
        return { stdout: String(stdout), stderr: this.sanitizeGodotStderr(String(stderr)) };
      } finally {
        rmSync(paramsDir, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      // If execFileAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string | Buffer; stderr: string | Buffer };
        return {
          stdout: String(execError.stdout),
          stderr: this.sanitizeGodotStderr(String(execError.stderr)),
        };
      }

      throw error;
    }
  }

  private getEditorStatusPayload() {
    const status = this.godotBridge.getStatus();
    const isPortConflict = this.bridgeStartupErrorInfo?.code === 'EADDRINUSE'
      || (this.bridgeStartupError?.includes('EADDRINUSE') ?? false);

    const launchedByMcp = this.editorProcess !== null;
    const editorPid = this.editorProcess?.process?.pid ?? null;
    const launchedAt = this.editorProcess ? new Date(this.editorProcess.launchedAt).toISOString() : null;
    const tracked_project_path = this.editorProcess?.projectPath ?? null;

    const conflictNote = (() => {
      if (!isPortConflict) {
        return undefined;
      }
      const info = this.bridgeStartupErrorInfo;
      if (info?.holderPid !== null && info?.holderPid !== undefined) {
        return `Bridge port is already in use by ${info.holderCommand ?? 'unknown'} (PID ${info.holderPid}). Another gopeak instance may own the editor bridge, so this server cannot report that editor connection.`;
      }
      return 'Bridge port is already in use. Another gopeak instance may own the editor bridge, so this server cannot report that editor connection.';
    })();

    const conflictSuggestion = (() => {
      if (!isPortConflict) {
        return undefined;
      }
      const info = this.bridgeStartupErrorInfo;
      if (info?.holderPid !== null && info?.holderPid !== undefined) {
        return `Run \`kill ${info.holderPid}\` to free the port, then restart Claude Code.`;
      }
      return 'Stop duplicate gopeak/MCP server instances or re-run the command from the same server process that owns the bridge port.';
    })();

    return {
      ...status,
      // Backward-compatible surface: `bridgeAvailable` boolean + `startupError`
      // string (matches /EADDRINUSE/i in legacy regression test).
      bridgeAvailable: this.bridgeStartupError === null,
      startupError: this.bridgeStartupError,
      // Structured holder info from BridgeStartupErrorInfo (new fields).
      startupErrorInfo: this.bridgeStartupErrorInfo,
      holderPid: this.bridgeStartupErrorInfo?.holderPid ?? null,
      holderCommand: this.bridgeStartupErrorInfo?.holderCommand ?? null,
      reclaimedPidsAtStartup: this.bridgeStartupErrorInfo?.reclaimedPids ?? [],
      launched_by_mcp: launchedByMcp,
      editor_pid: editorPid,
      launched_at: launchedAt,
      tracked_project_path,
      // Multi-session: the project this server is bound to + its allocated
      // ports, so an agent can confirm two worktrees got distinct ports.
      session_project_path: this.primaryProjectPath,
      // True when the bridge rejects editors whose project doesn't match. False
      // (accept-any) until a project is known — usually transient until the
      // first launch_editor/run_project, but worth surfacing for diagnosis.
      project_gated: this.godotBridge.getExpectedProjectPath() !== null,
      allocated_ports: {
        bridge: this.allocatedBridgePort || status.port,
        runtime: this.allocatedRuntimePort || null,
        dap_relay: this.allocatedDapRelayPort || null,
      },
      // In-editor Play-button game state (refreshed via the bridge in the
      // get_editor_status dispatch). Null when the bridge isn't connected —
      // query get_play_state for a live read. Distinct from `active_process`
      // semantics: editor_play_state is stopped with stop_playing_scene; an
      // MCP-spawned run_project game is stopped with stop_project.
      editor_play_state: this.lastKnownPlayState,
      note: conflictNote,
      suggestion: conflictSuggestion,
    };
  }

  /**
   * Refresh the cached editor Play-button state via the bridge. Best-effort:
   * keeps the existing cache on error so get_editor_status never fails because
   * of a play-state probe. No-op when the bridge isn't connected.
   */
  private async refreshPlayState(): Promise<void> {
    if (!this.godotBridge.isConnected()) {
      return;
    }
    try {
      const result = await this.godotBridge.invokeTool('get_play_state', {}) as
        { is_playing?: unknown; played_scene?: unknown } | null;
      if (result && typeof result === 'object') {
        this.lastKnownPlayState = {
          is_playing: Boolean((result as { is_playing?: unknown }).is_playing),
          played_scene: typeof (result as { played_scene?: unknown }).played_scene === 'string'
            ? (result as { played_scene: string }).played_scene
            : '',
          fetchedAt: Date.now(),
        };
      }
    } catch {
      // leave the previous cache in place
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return listPrompts(request.params?.cursor);
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return getPrompt(request.params.name, request.params.arguments);
    });

    // Define available tools
    const buildToolDefinitions = (): MCPToolDefinition[] => buildToolDefinitionsForServer(this.godotBridge.getStatus().port);

    this.toolDefinitionFactory = buildToolDefinitions;
    this.cachedToolDefinitions = buildToolDefinitions();

    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const allTools = buildToolDefinitions();
      this.cachedToolDefinitions = allTools;

      const exposedTools = this.sanitizeToolsForList(this.getExposedTools(allTools));
      return this.paginateToolsForList(exposedTools, request.params?.cursor);
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      const rawArgs = request.params.arguments as Record<string, unknown> | undefined;
      const normalizedArgs = this.normalizeParameters((rawArgs || {}) as OperationParams);
      if (typeof normalizedArgs?.projectPath === 'string') {
        this.lastProjectPath = normalizedArgs.projectPath;
      }
      const resolvedToolName = this.resolveToolAlias(request.params.name);
      switch (resolvedToolName) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments, false);
        case 'run_project_headless':
          return await this.handleRunProject(request.params.arguments, true);
        case 'get_debug_output':
          return await this.handleGetDebugOutput();
        case 'stop_project':
          return await this.handleStopProject();
        case 'close_editor':
          return await this.handleCloseEditor(request.params.arguments);
        case 'restart_editor':
          return await this.handleRestartEditor(request.params.arguments);
        case 'get_fs_scanning_status':
          return await this.handleViaBridge('get_fs_scanning_status', request.params.arguments);
        case 'get_play_state':
          return await this.handleViaBridge('get_play_state', request.params.arguments);
        case 'play_scene':
          return await this.handleViaBridge('play_scene', request.params.arguments);
        case 'stop_playing_scene':
          return await this.handleViaBridge('stop_playing_scene', request.params.arguments);
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'scaffold_gameplay_prototype':
          return await this.handleScaffoldGameplayPrototype(request.params.arguments);
        case 'validate_patch_with_lsp':
          return await this.handleValidatePatchWithLsp(request.params.arguments);
        case 'enforce_version_gate':
          return await this.handleEnforceVersionGate(request.params.arguments);
        case 'capture_intent_snapshot':
          return await this.handleCaptureIntentSnapshot(request.params.arguments);
        case 'record_decision_log':
          return await this.handleRecordDecisionLog(request.params.arguments);
        case 'generate_handoff_brief':
          return await this.handleGenerateHandoffBrief(request.params.arguments);
        case 'summarize_intent_context':
          return await this.handleSummarizeIntentContext(request.params.arguments);
        case 'record_work_step':
          return await this.handleRecordWorkStep(request.params.arguments);
        case 'record_execution_trace':
          return await this.handleRecordExecutionTrace(request.params.arguments);
        case 'export_handoff_pack':
          return await this.handleExportHandoffPack(request.params.arguments);
        case 'set_recording_mode':
          return await this.handleSetRecordingMode(request.params.arguments);
        case 'get_recording_mode':
          return await this.handleGetRecordingMode();
        case 'tool_catalog':
          return await this.handleToolCatalog(request.params.arguments);
        case 'manage_tool_groups':
          return await this.handleManageToolGroups(request.params.arguments);
        case 'create_scene':
          return await this.handleViaBridge('create_scene', normalizedArgs);
        case 'add_node':
          return await this.handleViaBridge('add_node', normalizedArgs);
        case 'load_sprite':
          return await this.handleViaBridge('load_sprite', normalizedArgs);
        case 'save_scene':
          return await this.handleViaBridge('save_scene', normalizedArgs);
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        // Phase 1: Scene Operations handlers
        case 'list_scene_nodes':
          return await this.handleViaBridge('list_scene_nodes', normalizedArgs);
        case 'get_node_properties':
          return await this.handleViaBridge('get_node_properties', normalizedArgs);
        case 'set_node_properties':
          return await this.handleViaBridge('set_node_properties', normalizedArgs);
        case 'delete_node':
          return await this.handleViaBridge('delete_node', normalizedArgs);
        case 'duplicate_node':
          return await this.handleViaBridge('duplicate_node', normalizedArgs);
        case 'reparent_node':
          return await this.handleViaBridge('reparent_node', normalizedArgs);
        // Phase 2: Import/Export Pipeline handlers
        case 'get_import_status':
          return await this.handleGetImportStatus(request.params.arguments);
        case 'get_import_options':
          return await this.handleGetImportOptions(request.params.arguments);
        case 'set_import_options':
          return await this.handleSetImportOptions(request.params.arguments);
        case 'reimport_resource':
          return await this.handleReimportResource(request.params.arguments);
        case 'list_export_presets':
          return await this.handleListExportPresets(request.params.arguments);
        case 'export_project':
          return await this.handleExportProject(request.params.arguments);
        case 'validate_project':
          return await this.handleValidateProject(request.params.arguments);
        // Phase 3: DX Tools handlers
        case 'get_dependencies':
          return await this.handleGetDependencies(request.params.arguments);
        case 'find_resource_usages':
          return await this.handleFindResourceUsages(request.params.arguments);
        case 'parse_error_log':
          return await this.handleParseErrorLog(request.params.arguments);
        case 'get_project_health':
          return await this.handleGetProjectHealth(request.params.arguments);
        // Phase 3: Config Tools handlers
        case 'get_project_setting':
          return await this.handleGetProjectSetting(request.params.arguments);
        case 'set_project_setting':
          return await this.handleSetProjectSetting(request.params.arguments);
        case 'add_autoload':
          return await this.handleAddAutoload(request.params.arguments);
        case 'remove_autoload':
          return await this.handleRemoveAutoload(request.params.arguments);
        case 'list_autoloads':
          return await this.handleListAutoloads(request.params.arguments);
        case 'set_main_scene':
          return await this.handleSetMainScene(request.params.arguments);
        // Signal Management handlers
        case 'connect_signal':
          return await this.handleViaBridge('connect_signal', normalizedArgs);
        case 'disconnect_signal':
          return await this.handleViaBridge('disconnect_signal', normalizedArgs);
        case 'list_connections':
          return await this.handleViaBridge('list_connections', normalizedArgs);
        // Phase 4: Runtime Tools handlers
        case 'get_runtime_status':
          return await this.handleGetRuntimeStatus(request.params.arguments);
        case 'inspect_runtime_tree':
          return await this.handleInspectRuntimeTree(request.params.arguments);
        case 'set_runtime_property':
          return await this.handleSetRuntimeProperty(request.params.arguments);
        case 'call_runtime_method':
          return await this.handleCallRuntimeMethod(request.params.arguments);
        case 'get_runtime_metrics':
          return await this.handleGetRuntimeMetrics(request.params.arguments);
        // Resource Creation Tools handlers
        case 'create_resource':
          return await this.handleViaBridge('create_resource', normalizedArgs);
        case 'create_material':
          return await this.handleViaBridge('create_material', normalizedArgs);
        case 'create_shader':
          return await this.handleViaBridge('create_shader', normalizedArgs);
        // GDScript File Operations handlers
        case 'create_script':
          return await this.handleCreateScript(request.params.arguments);
        case 'modify_script':
          return await this.handleModifyScript(request.params.arguments);
        case 'get_script_info':
          return await this.handleGetScriptInfo(request.params.arguments);
        // Animation Tools handlers
        case 'create_animation':
          return await this.handleViaBridge('create_animation', normalizedArgs);
        case 'add_animation_track':
          return await this.handleViaBridge('add_animation_track', normalizedArgs);
        // Plugin Management handlers
        case 'list_plugins':
          return await this.handleListPlugins(request.params.arguments);
        case 'enable_plugin':
          return await this.handleEnablePlugin(request.params.arguments);
        case 'disable_plugin':
          return await this.handleDisablePlugin(request.params.arguments);
        // Input Action handlers
        case 'add_input_action':
          return await this.handleAddInputAction(request.params.arguments);
        // Project Search handlers
        case 'search_project':
          return await this.handleSearchProject(request.params.arguments);
        // 2D Tile Tools handlers
        case 'create_tileset':
          return await this.handleViaBridge('create_tileset', normalizedArgs);
        case 'set_tilemap_cells':
          return await this.handleViaBridge('set_tilemap_cells', normalizedArgs);
        // Audio System Tools handlers
        case 'create_audio_bus':
          return await this.handleCreateAudioBus(request.params.arguments);
        case 'get_audio_buses':
          return await this.handleGetAudioBuses(request.params.arguments);
        case 'set_audio_bus_effect':
          return await this.handleSetAudioBusEffect(request.params.arguments);
        case 'set_audio_bus_volume':
          return await this.handleSetAudioBusVolume(request.params.arguments);
        // Networking Tools handlers
        // Physics Tools handlers
        // Navigation Tools handlers
        case 'create_navigation_region':
          return await this.handleViaBridge('create_navigation_region', normalizedArgs);
        case 'create_navigation_agent':
          return await this.handleViaBridge('create_navigation_agent', normalizedArgs);
        // Rendering Tools handlers
        // Animation Tree Tools handlers
        case 'create_animation_tree':
          return await this.handleViaBridge('create_animation_tree', normalizedArgs);
        case 'add_animation_state':
          return await this.handleViaBridge('add_animation_state', normalizedArgs);
        case 'connect_animation_states':
          return await this.handleViaBridge('connect_animation_states', normalizedArgs);
        // UI/Theme Tools handlers
        case 'set_theme_color':
          return await this.handleViaBridge('set_theme_color', normalizedArgs);
        case 'set_theme_font_size':
          return await this.handleViaBridge('set_theme_font_size', normalizedArgs);
        case 'apply_theme_shader':
          return await this.handleViaBridge('apply_theme_shader', normalizedArgs);
        case 'search_assets':
          return await this.handleSearchAssets(request.params.arguments);
        case 'fetch_asset':
          return await this.handleFetchAsset(request.params.arguments);
        case 'list_asset_providers':
          return await this.handleListAssetProviders();
        // ClassDB Introspection Tools
        case 'query_classes':
          return await this.handleQueryClasses(request.params.arguments);
        case 'query_class_info':
          return await this.handleQueryClassInfo(request.params.arguments);
        case 'inspect_inheritance':
          return await this.handleInspectInheritance(request.params.arguments);
        // Resource Modification Tool
        case 'modify_resource':
          return await this.handleViaBridge('modify_resource', normalizedArgs);
        // Editor Plugin Bridge Status
        case 'get_editor_status':
          await this.refreshPlayState();
          return { content: [{ type: 'text', text: JSON.stringify(this.getEditorStatusPayload(), null, 2) }] };
        // Project Visualizer Tool
        case 'map_project':
          return await this.handleMapProject(request.params.arguments);
        case 'capture_screenshot':
          return await this.handleRuntimeCommand('capture_screenshot', request.params.arguments);
        case 'capture_viewport':
          return await this.handleRuntimeCommand('capture_viewport', request.params.arguments);
        case 'capture_editor_viewport':
          return await this.handleEditorScreenshot(request.params.arguments);
        case 'inject_action':
          return await this.handleRuntimeCommand('inject_action', request.params.arguments);
        case 'inject_key':
          return await this.handleRuntimeCommand('inject_key', request.params.arguments);
        case 'inject_mouse_click':
          return await this.handleRuntimeCommand('inject_mouse_click', request.params.arguments);
        case 'inject_mouse_motion':
          return await this.handleRuntimeCommand('inject_mouse_motion', request.params.arguments);
        case 'lsp_get_diagnostics':
        case 'lsp_get_completions':
        case 'lsp_get_hover':
        case 'lsp_get_symbols':
          return await this.handleLSP(resolvedToolName, request.params.arguments);
        case 'dap_get_output':
        case 'dap_set_breakpoint':
        case 'dap_remove_breakpoint':
        case 'dap_continue':
        case 'dap_pause':
        case 'dap_step_over':
        case 'dap_get_stack_trace':
          return await this.handleDAP(resolvedToolName, request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const displayPath = await this.launchEditorForProject(args.projectPath);
      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${displayPath}.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Spawn a Godot editor bound to `projectPath` and track it. Shared by the
   * launch_editor tool and the opt-in auto-launch path. Binds the session
   * (discovery file + bridge gate) before spawning so the editor's addon
   * connects to THIS session's ports. Throws on failure (missing Godot, not a
   * project) for the caller to surface.
   * @returns the display path for user-facing messages.
   */
  private async launchEditorForProject(projectPath: string): Promise<string> {
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path. Set GODOT_PATH or install Godot.');
      }
    }

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      throw new Error(`Not a valid Godot project: ${projectPath} (no project.godot)`);
    }

    // Bind this session to the project before spawning so the discovery file
    // and bridge gate are in place when the editor's addon connects.
    this.ensureSessionProject(projectPath);

    const prepared = this.prepareProjectScopedCommand(projectPath, ['-e']);
    this.logDebug(`Launching Godot editor for project: ${prepared.projectPathForDisplay}`);
    const editorChild = spawn(prepared.command, prepared.args, {
      stdio: 'pipe',
      cwd: prepared.cwd,
      env: this.buildGodotSpawnEnv(),
    });

    editorChild.on('error', (err: Error) => {
      console.error('Failed to start Godot editor:', err);
      if (this.editorProcess && this.editorProcess.process === editorChild) {
        this.editorProcess = null;
      }
    });
    editorChild.on('exit', () => {
      if (this.editorProcess && this.editorProcess.process === editorChild) {
        this.editorProcess = null;
      }
    });

    this.editorProcess = {
      process: editorChild,
      projectPath: prepared.targetProjectPath,
      launchedAt: Date.now(),
      bridgePort: this.allocatedBridgePort || this.godotBridge.getStatus().port,
      runtimePort: this.allocatedRuntimePort || resolveDefaultRuntimePort(),
      dapRelayPort: this.allocatedDapRelayPort || DEFAULT_DAP_RELAY_PORT,
    };

    return prepared.projectPathForDisplay;
  }

  /**
   * Opt-in (GOPEAK_AUTO_LAUNCH_EDITOR=1) recovery for a bridge tool called with
   * no editor connected: spawn the editor for this session's bound project and
   * wait (up to GOPEAK_AUTO_LAUNCH_TIMEOUT_MS, default 45000) for its addon to
   * connect. Single-flight — a concurrent burst shares one spawn. Off by
   * default so headless/CI runs are never surprised by a GUI editor.
   */
  private async maybeAutoLaunchEditor(): Promise<{ connected: boolean; errorPayload?: Record<string, unknown> }> {
    const enabled = process.env.GOPEAK_AUTO_LAUNCH_EDITOR === '1';
    const project = this.primaryProjectPath;

    if (!enabled || !project) {
      return {
        connected: false,
        errorPayload: {
          error: 'Godot Editor not connected. Launch Godot Editor and enable the "Godot MCP Editor" plugin to use this tool.',
          suggestion: enabled
            ? 'Auto-launch is on but no project is bound to this session. Set GOPEAK_PROJECT_PATH (or start the server from the project root), or call launch_editor with an explicit projectPath.'
            : 'Use launch_editor to open the editor, then enable the plugin in Project > Project Settings > Plugins. Tip: set GOPEAK_AUTO_LAUNCH_EDITOR=1 to auto-launch the bound project on demand.',
          autoLaunch: enabled ? 'enabled-but-no-bound-project' : 'disabled',
          boundProject: project ?? null,
        },
      };
    }

    // Single-flight across the WHOLE recovery (spawn + wait-for-connect), not
    // just the spawn. launchEditorForProject resolves in microseconds (spawn is
    // synchronous), so guarding only the spawn would leave the ~45s editor-boot
    // window unguarded — a tool call retried mid-boot would then spawn a second
    // editor. Concurrent or staggered callers join this one recovery and share
    // its outcome.
    // INVARIANT: the read of editorLaunchInFlight and the write-back below must
    // stay await-free — that synchronous read-modify-write is what guarantees
    // single-flight (two concurrent callers cannot both observe null). Do not
    // insert an await between them.
    let recovery = this.editorLaunchInFlight;
    if (!recovery) {
      recovery = this.runAutoLaunch(project);
      this.editorLaunchInFlight = recovery;
      const tracked = recovery;
      void tracked.catch(() => undefined).finally(() => {
        if (this.editorLaunchInFlight === tracked) {
          this.editorLaunchInFlight = null;
        }
      });
    }
    return recovery;
  }

  /**
   * Spawn (if needed) and wait for the editor's addon to connect, run under the
   * maybeAutoLaunchEditor single-flight guard. Resolves connected=true once the
   * bridge is live, or with an error payload if the spawn fails, the editor
   * exits before connecting, or the connect times out.
   */
  private async runAutoLaunch(project: string): Promise<{ connected: boolean; errorPayload?: Record<string, unknown> }> {
    if (this.godotBridge.isConnected()) {
      return { connected: true };
    }
    const timeoutMs = this.resolveAutoLaunchTimeoutMs();
    // Don't spawn a duplicate: a prior recovery may have already launched an
    // editor that booted but hasn't connected (e.g. plugin not enabled). Only
    // spawn when no editor is currently tracked.
    if (this.editorProcess === null) {
      try {
        await this.launchEditorForProject(project);
      } catch (err) {
        return {
          connected: false,
          errorPayload: {
            error: `Auto-launch failed: ${err instanceof Error ? err.message : String(err)}`,
            boundProject: project,
            autoLaunch: 'spawn-failed',
          },
        };
      }
    } else if (Date.now() - this.editorProcess.launchedAt >= timeoutMs) {
      // The tracked editor has already had a full connect window and still
      // hasn't connected — re-waiting another timeoutMs makes no progress and
      // just blocks the caller. Report immediately so a retried tool call fails
      // fast (the usual fix is enabling the Godot MCP Editor plugin).
      return {
        connected: false,
        errorPayload: {
          error: `The Godot editor for ${project} is running but its MCP addon has not connected.`,
          suggestion: 'Enable the "Godot MCP Editor" plugin in this project (Project > Project Settings > Plugins), then retry. The editor is already open — no new launch was attempted.',
          boundProject: project,
          autoLaunch: 'connect-timeout',
        },
      };
    }

    // Poll for the addon to connect. Bail early if the spawned editor process
    // dies first — spawn reports a bad GODOT_PATH via an async 'error'/'exit'
    // event (it does not throw), which nulls editorProcess — so a
    // misconfiguration surfaces promptly instead of after the full timeout.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.godotBridge.isConnected()) {
        return { connected: true };
      }
      if (this.editorProcess === null) {
        return {
          connected: false,
          errorPayload: {
            error: `Auto-launched editor for ${project} exited before its MCP addon connected.`,
            suggestion: 'Check GODOT_PATH points to a real Godot executable, and that the project\'s "Godot MCP Editor" plugin is enabled (Project > Project Settings > Plugins).',
            boundProject: project,
            autoLaunch: 'editor-exited',
          },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (this.godotBridge.isConnected()) {
      return { connected: true };
    }
    return {
      connected: false,
      errorPayload: {
        error: `Auto-launched the Godot editor for ${project} but its MCP addon did not connect within ${timeoutMs}ms.`,
        suggestion: 'Confirm the "Godot MCP Editor" plugin is enabled in this project (Project > Project Settings > Plugins). The editor may still be booting — retry the tool shortly.',
        boundProject: project,
        autoLaunch: 'connect-timeout',
      },
    };
  }

  private resolveAutoLaunchTimeoutMs(): number {
    const raw = Number.parseInt(process.env.GOPEAK_AUTO_LAUNCH_TIMEOUT_MS || '', 10);
    return Number.isInteger(raw) && raw > 0 ? raw : 45000;
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any, headless = false) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Stop any existing run FIRST — unconditionally, not just when a proxy is
      // tracked: on WSL→Windows spawns a proxy-kill alone orphans the Windows-side
      // game window, which keeps holding the runtime port and turns the next run
      // passive (friction editor-run-orphan-window). stopActiveRun's runtime-quit
      // also reaps an already-orphaned game whose proxy died earlier.
      await this.stopActiveRun('replacing with a new run');

      const suffixArgs: string[] = [];
      if (args.scene && this.validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        suffixArgs.push(args.scene);
      }

      // Bind this session to the project so the runtime autoload (which
      // inherits this env) binds the right port and the discovery file exists.
      this.ensureSessionProject(args.projectPath);

      // Windowed (default, run_project) renders frames so capture-screenshot/-viewport work. Headless
      // (run_project_headless) prepends --headless for a fast, windowless data/logic run — but Godot's
      // headless mode disables ALL rendering, so screenshots are BLACK. The two run tools differ ONLY by
      // this flag; the WSL path translation, cwd, env, and output capture below are shared.
      const prefixArgs = headless ? ['--headless', '-d'] : ['-d'];
      const prepared = this.prepareProjectScopedCommand(args.projectPath, prefixArgs, suffixArgs);
      this.logDebug(`Running Godot project${headless ? ' (headless)' : ''}: ${prepared.projectPathForDisplay}`);
      const process = spawn(prepared.command, prepared.args, { stdio: 'pipe', cwd: prepared.cwd, env: this.buildGodotSpawnEnv() });
      const output: string[] = [];
      const errors: string[] = [];

      process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = { process, output, errors, launchedAt: Date.now() };

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output. Call stop_project when you are done with the run — an unstopped run leaves the game window open (on WSL, as an orphan holding the runtime port).`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Capture the editor's 2D viewport via the editor bridge. Mirrors the runtime
   * screenshot read-back, but routes through the editor bridge and writes the PNG
   * to a Windows-visible temp path so a Windows Godot can write a file the WSL
   * bridge reads back (same pattern as the @file: operation params).
   */
  private async handleEditorScreenshot(args: any): Promise<any> {
    if (!this.godotBridge.isConnected()) {
      const recovery = await this.maybeAutoLaunchEditor();
      if (!recovery.connected) {
        return {
          content: [{ type: 'text', text: JSON.stringify(recovery.errorPayload, null, 2) }],
          isError: true,
        };
      }
    }

    const interop = this.getWSLInteropDetails(this.godotPath);
    const tempRoot = resolveWSLWindowsTempDir(interop) ?? tmpdir();
    const shotDir = mkdtempSync(join(tempRoot, 'gopeak-editor-screenshot-'));
    const shotPath = join(shotDir, 'capture.png');
    const cleanup = () => { try { rmSync(shotDir, { recursive: true, force: true }); } catch {} };

    try {
      // Windows-form path for Godot; we read the PNG back from the WSL mount.
      const shotPathForGodot = wslTranslatePathForGodot(shotPath, interop, 'Editor screenshot file');
      const normalizedArgs = this.normalizeParameters((args || {}) as OperationParams);
      const result = await this.godotBridge.invokeTool('capture_editor_viewport', {
        ...(normalizedArgs as Record<string, unknown>),
        output_path: shotPathForGodot,
      }) as Record<string, unknown>;

      if (result && result.type === 'screenshot_file') {
        const imageData = readFileSync(shotPath).toString('base64');
        cleanup();
        return {
          content: [
            { type: 'text', text: `Editor viewport captured: ${result.width}x${result.height} ${result.format}` },
            { type: 'image', data: imageData, mimeType: 'image/png' },
          ],
        };
      }

      if (result && result.type === 'screenshot' && result.data) {
        cleanup();
        return {
          content: [
            { type: 'text', text: `Editor viewport captured: ${result.width}x${result.height} ${result.format}` },
            { type: 'image', data: String(result.data), mimeType: 'image/png' },
          ],
        };
      }

      cleanup();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!(result && result.ok === false),
      };
    } catch (error) {
      cleanup();
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2) }],
        isError: true,
      };
    }
  }

  /**
   * Route a tool call through the Godot Editor Plugin bridge (WebSocket).
   * Returns an error response if the editor is not connected.
   */
  private async handleViaBridge(toolName: string, args: any): Promise<any> {
    if (!this.godotBridge.isConnected()) {
      const recovery = await this.maybeAutoLaunchEditor();
      if (!recovery.connected) {
        return {
          content: [{ type: 'text', text: JSON.stringify(recovery.errorPayload, null, 2) }],
          isError: true,
        };
      }
    }
    try {
      const normalizedArgs = this.normalizeParameters((args || {}) as OperationParams);
      const missingRequiredArgs = this.getMissingRequiredArguments(
        toolName,
        normalizedArgs as Record<string, unknown>
      );
      if (missingRequiredArgs.length > 0) {
        return this.createErrorResponse(
          `Missing required arguments for ${toolName}: ${missingRequiredArgs.join(', ')}`,
          [`Provide required argument(s): ${missingRequiredArgs.join(', ')}`]
        );
      }
      const result = await this.godotBridge.invokeTool(toolName, normalizedArgs as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }, null, 2) }],
        isError: true,
      };
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output,
              errors: this.activeProcess.errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    await this.stopActiveRun('stop_project');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the close_editor tool
   *
   * Safety contract (in order):
   *  - C4: if a game-debug session is active (this.activeProcess), stop it
   *    first via handleStopProject so its tracking is clean.
   *  - HITL gate: if the editor was NOT launched by this MCP server
   *    (this.editorProcess === null) and bridge IS connected (i.e., a user-
   *    owned editor), refuse by default. Caller must opt-in via force=true
   *    paired with i_understand_data_loss_risk=true, OR via prefer_pid_kill.
   *    Prevents AI agents from closing the user's working editor.
   *  - Force-on-user-editor gate: force=true alone is not enough on a user-
   *    owned editor; also requires i_understand_data_loss_risk=true.
   *
   * Two paths after gates pass:
   *  - Path A (preferred): bridge IPC dispatch. Addon enforces safety guards
   *    (fs_scanning, modal_open, save_blocked / writability pre-check) and
   *    calls get_tree().quit() via call_deferred so the response flushes
   *    before termination. Respects `force`, `save_first` flags.
   *  - Path B (fallback): direct process.kill() when bridge is disconnected
   *    but `editorProcess` is tracked. SIGTERM by default, SIGKILL if
   *    `force_kill=true`. Bypasses GDScript guards (editor is unresponsive).
   *
   * editorProcess null transition is owned by spawn's on('exit') listener —
   * we never null it here on Path A success because the editor hasn't actually
   * quit at response time (quit is deferred). C2 fix.
   */
  private async handleCloseEditor(args: any): Promise<any> {
    const opts = (args || {}) as {
      force?: boolean;
      save_first?: boolean;
      force_kill?: boolean;
      prefer_pid_kill?: boolean;
      i_understand_data_loss_risk?: boolean;
    };

    // C4: stop active game-debug FIRST so activeProcess tracking is clean.
    if (this.activeProcess !== null) {
      this.logDebug('close_editor: stopping active game-debug session first (C4)');
      try {
        await this.handleStopProject();
      } catch {
        // handleStopProject swallows its own errors and returns a response; on
        // throw we still want to proceed to the editor close.
      }
    }

    const bridgeConnected = this.godotBridge.isConnected();
    const hasTrackedPid = this.editorProcess !== null;

    // HITL gates apply only when bridge is connected (i.e., there's actually
    // an editor to close) and we don't own the editor.
    if (bridgeConnected && !hasTrackedPid) {
      const userAcked = opts.i_understand_data_loss_risk === true;
      const willPidKill = opts.prefer_pid_kill === true;
      if (!opts.force && !willPidKill) {
        console.error('[close_editor] HITL refusal: user-owned editor; no force/prefer_pid_kill flag');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              reason: 'user_editor_not_owned_by_mcp',
              remediation: 'this editor was opened by the user (launched_by_mcp=false). To close it anyway, retry with force=true AND i_understand_data_loss_risk=true. The auto-save guard still runs unless you also pass force=true without save_first.',
              hint: 'check editor-status.launched_by_mcp to confirm ownership',
            }, null, 2),
          }],
          isError: true,
        };
      }
      if (opts.force === true && !userAcked) {
        console.error('[close_editor] HITL refusal: force=true on user-owned editor requires explicit data-loss acknowledgement');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              reason: 'force_requires_acknowledgement',
              remediation: 'force=true on a user-owned editor needs i_understand_data_loss_risk=true paired with it. This is a double-explicit gate to prevent accidental data loss from a misconfigured caller.',
            }, null, 2),
          }],
          isError: true,
        };
      }
    }

    const usePidKill = (!bridgeConnected && hasTrackedPid) || (opts.prefer_pid_kill === true && hasTrackedPid);

    if (usePidKill) {
      // Path B: PID-kill fallback. Guards bypassed (no GDScript-side check).
      const tracked = this.editorProcess!;
      if (!tracked.process || typeof tracked.process.kill !== 'function') {
        return this.createErrorResponse(
          'Tracked editor process handle is invalid; cannot signal.',
          ['Process may have already exited', 'Check editor-status for current state'],
        );
      }
      const signal: NodeJS.Signals = opts.force_kill ? 'SIGKILL' : 'SIGTERM';
      const bridgeWasAvailable = bridgeConnected;
      console.error(`[close_editor] path=pid_kill signal=${signal} bridge_was_available=${bridgeWasAvailable} prefer_pid_kill=${opts.prefer_pid_kill === true}`);
      try {
        tracked.process.kill(signal);
      } catch (err) {
        return this.createErrorResponse(
          `Failed to signal Godot editor process: ${err instanceof Error ? err.message : String(err)}`,
          ['Process may have already exited', 'Check editor-status for current state'],
        );
      }
      const launchedAtMs = tracked.launchedAt;
      // NOTE: do not null editorProcess here — let the on('exit') listener own
      // the null transition so it fires exactly when the OS reports the exit.
      const warningText = bridgeWasAvailable
        ? 'guards bypassed via prefer_pid_kill=true (bridge was available; guards skipped by caller request)'
        : 'guards bypassed (bridge unavailable); unsaved changes may be lost';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            path: 'pid_kill',
            signal,
            warning: warningText,
            launched_at: new Date(launchedAtMs).toISOString(),
          }, null, 2),
        }],
      };
    }

    if (!bridgeConnected) {
      return this.createErrorResponse(
        'Godot Editor not connected. No bridge channel; no tracked PID. Cannot close.',
        [
          'Launch the editor via launch_editor or open it manually',
          'If the editor is open but bridge unreachable, check editor-status.bridgeAvailable',
          'For headless Godot this is expected — there is no editor to close',
        ]
      );
    }

    // Path A: bridge IPC dispatch. Addon enforces safety guards.
    console.error(`[close_editor] path=bridge_ipc force=${opts.force === true} save_first=${opts.save_first === true} launched_by_mcp=${hasTrackedPid}`);
    try {
      const result = await this.godotBridge.invokeTool('close_editor', {
        force: opts.force === true,
        save_first: opts.save_first === true,
      });
      const resultObj = (result && typeof result === 'object') ? (result as Record<string, unknown>) : { value: result };
      const addonReportedOk = resultObj.ok === true;
      // C2: do NOT null editorProcess here. The addon's get_tree().quit() is
      // deferred; the editor is still alive when this response arrives. The
      // spawn on('exit') listener clears editorProcess when the OS reports
      // the actual exit (line ~2031 in handleLaunchEditor).
      return {
        content: [{ type: 'text', text: JSON.stringify({ path: 'bridge_ipc', ...resultObj }, null, 2) }],
        // Propagate addon refusals as isError so callers (especially
        // handleRestartEditor) can detect them without parsing the inner JSON.
        ...(addonReportedOk ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: false,
            path: 'bridge_ipc',
            error: err instanceof Error ? err.message : String(err),
          }, null, 2),
        }],
        isError: true,
      };
    }
  }

  /**
   * Best-effort teardown of whatever game holds this server's runtime port
   * (normally this session's run; an identity check via the welcome frame's
   * project_name is a possible follow-up). Two layers,
   * both required on WSL→Windows spawns:
   *  1. Runtime-socket `quit` — reaches the WINDOWS game process, which a
   *     proxy-kill cannot (killing the WSL-side wrapper orphans the game
   *     window, which keeps holding the runtime port so the next run binds
   *     passive). Bounded at 2.5s; with no game listening the connect
   *     refuses immediately.
   *  2. Proxy kill + tracking reset for the WSL-side wrapper itself.
   * Never throws — a failed teardown must not block the caller's own path.
   */
  private async stopActiveRun(reason: string): Promise<void> {
    this.logDebug(`Stopping active run (${reason})`);
    try {
      await Promise.race([
        this.handleRuntimeCommand('quit', {}),
        new Promise((resolve) => setTimeout(resolve, 2500).unref()),
      ]);
    } catch {
      // defensive only — handleRuntimeCommand resolves (never rejects) today
    }
    if (this.activeProcess) {
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
  }

  /**
   * Handle the restart_editor tool — close + relaunch.
   * Inherits guard refusals from inner close_editor (C3: refusal detection
   * via isError propagation). Forwards force / save_first / force_kill /
   * i_understand_data_loss_risk so callers can chain through.
   */
  private async handleRestartEditor(args: any): Promise<any> {
    const opts = (args || {}) as {
      projectPath?: string;
      force?: boolean;
      save_first?: boolean;
      force_kill?: boolean;
      i_understand_data_loss_risk?: boolean;
    };
    if (!opts.projectPath) {
      return this.createErrorResponse('projectPath required for restart_editor', [
        'Pass the project directory path containing project.godot',
      ]);
    }
    const closeResult = await this.handleCloseEditor({
      force: opts.force,
      save_first: opts.save_first,
      force_kill: opts.force_kill,
      i_understand_data_loss_risk: opts.i_understand_data_loss_risk,
    });
    // C3: addon guard refusals (e.g., fs_scanning) now propagate as isError,
    // so this check correctly stops the restart chain rather than racing into
    // a launch on top of a still-open editor.
    if ((closeResult as { isError?: boolean }).isError === true) {
      return closeResult;
    }
    // Poll until bridge disconnects (5s cap).
    const disconnectDeadline = Date.now() + 5000;
    while (this.godotBridge.isConnected() && Date.now() < disconnectDeadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.godotBridge.isConnected()) {
      return this.createErrorResponse('Editor did not disconnect within 5s of close_editor', [
        'Editor may be stuck; try editor-close with force_kill=true',
        'Then call launch_editor manually',
      ]);
    }
    const launchResult = await this.handleLaunchEditor({ projectPath: opts.projectPath });
    if ((launchResult as { isError?: boolean }).isError === true) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          phase: 'launch_after_close',
          suggestion: 'editor closed but relaunch failed; call launch_editor manually',
          launch_error: launchResult,
        }, null, 2) }],
        isError: true,
      };
    }
    // Poll until bridge reconnects (15s cap).
    const reconnectDeadline = Date.now() + 15000;
    while (!this.godotBridge.isConnected() && Date.now() < reconnectDeadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        bridge_reconnected: this.godotBridge.isConnected(),
        editor_pid: this.editorProcess?.process?.pid ?? null,
        launched_at: this.editorProcess ? new Date(this.editorProcess.launchedAt).toISOString() : null,
        project_path: this.editorProcess?.projectPath ?? null,
      }, null, 2) }],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      const version = await this.getGodotVersionText();
      return {
        content: [
          {
            type: 'text',
            text: version,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const version = await this.getGodotVersionText(10000);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const projectFileContent = readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: version,
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  private compareMajorMinorVersions(actual: string, minimum: string): boolean {
    const parse = (value: string): [number, number] => {
      const m = value.match(/(\d+)\.(\d+)/);
      if (!m) return [0, 0];
      return [parseInt(m[1], 10), parseInt(m[2], 10)];
    };

    const [aMaj, aMin] = parse(actual);
    const [mMaj, mMin] = parse(minimum);

    if (aMaj > mMaj) return true;
    if (aMaj < mMaj) return false;
    return aMin >= mMin;
  }

  /**
   * One-shot gameplay prototype scaffold
   */
  private async handleScaffoldGameplayPrototype(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide projectPath']);
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
        'Ensure project.godot exists in the provided path',
      ]);
    }

    const scenePath = args.scenePath || 'scenes/Main.tscn';
    const playerScenePath = args.playerScenePath || 'scenes/Player.tscn';
    const includePlayerScript = args.includePlayerScript !== false;

    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];

    const runOperation = async (operation: string, params: Record<string, any>) => {
      const { stdout, stderr } = await this.executeOperation(operation, params, args.projectPath);
      const ok = !(stderr && stderr.includes('ERROR'));
      return { ok, stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' };
    };

    try {
      // 1) Create main scene
      const createMain = await runOperation('create_scene', {
        scenePath,
        rootNodeType: 'Node2D',
      });
      steps.push({ step: 'create_main_scene', ok: createMain.ok, detail: createMain.stderr || createMain.stdout });
      if (!createMain.ok) {
        return this.createErrorResponse('Failed to scaffold: could not create main scene', [createMain.stderr || 'Unknown error']);
      }

      // 2) Create player scene
      const createPlayerScene = await runOperation('create_scene', {
        scenePath: playerScenePath,
        rootNodeType: 'CharacterBody2D',
      });
      steps.push({ step: 'create_player_scene', ok: createPlayerScene.ok, detail: createPlayerScene.stderr || createPlayerScene.stdout });
      if (!createPlayerScene.ok) {
        return this.createErrorResponse('Failed to scaffold: could not create player scene', [createPlayerScene.stderr || 'Unknown error']);
      }

      // 3) Add common player child nodes
      const playerNodeAdds: Array<{ nodeType: string; nodeName: string; properties?: any }> = [
        { nodeType: 'Sprite2D', nodeName: 'Sprite2D' },
        { nodeType: 'CollisionShape2D', nodeName: 'CollisionShape2D' },
        { nodeType: 'Camera2D', nodeName: 'Camera2D', properties: { enabled: true } },
      ];

      for (const node of playerNodeAdds) {
        const add = await runOperation('add_node', {
          scenePath: playerScenePath,
          nodeType: node.nodeType,
          nodeName: node.nodeName,
          properties: node.properties,
        });
        steps.push({ step: `add_node_${node.nodeName}`, ok: add.ok, detail: add.stderr || add.stdout });
      }

      // 4) Add Player instance placeholder to main scene (as Node2D) and attach player scene path as meta hint
      const addPlayerRoot = await runOperation('add_node', {
        scenePath,
        nodeType: 'Node2D',
        nodeName: 'Player',
      });
      steps.push({ step: 'add_player_root_to_main', ok: addPlayerRoot.ok, detail: addPlayerRoot.stderr || addPlayerRoot.stdout });

      // 5) Input actions
      const inputActions = [
        {
          actionName: 'move_left',
          events: [{ type: 'key', keycode: 'A' }, { type: 'key', keycode: 'Left' }],
        },
        {
          actionName: 'move_right',
          events: [{ type: 'key', keycode: 'D' }, { type: 'key', keycode: 'Right' }],
        },
        {
          actionName: 'jump',
          events: [{ type: 'key', keycode: 'Space' }],
        },
      ];

      for (const action of inputActions) {
        const inputResult = await runOperation('add_input_action', action);
        steps.push({ step: `add_input_${action.actionName}`, ok: inputResult.ok, detail: inputResult.stderr || inputResult.stdout });
      }

      // 6) Optional starter player script
      if (includePlayerScript) {
        const scriptResult = await runOperation('create_script', {
          script_path: 'scripts/player.gd',
          class_name: 'PlayerController',
          extends_class: 'CharacterBody2D',
          content: "@export var speed: float = 220.0\n@export var jump_velocity: float = -420.0\n@export var gravity: float = 980.0\n\nfunc _physics_process(delta: float) -> void:\n\tvar dir := Input.get_axis(\"move_left\", \"move_right\")\n\tvelocity.x = dir * speed\n\tif not is_on_floor():\n\t\tvelocity.y += gravity * delta\n\tif is_on_floor() and Input.is_action_just_pressed(\"jump\"):\n\t\tvelocity.y = jump_velocity\n\tmove_and_slide()\n",
        });
        steps.push({ step: 'create_player_script', ok: scriptResult.ok, detail: scriptResult.stderr || scriptResult.stdout });

        // Attach script to player root
        const attachScript = await runOperation('set_node_properties', {
          scenePath: playerScenePath,
          nodePath: '.',
          properties: { script: 'res://scripts/player.gd' },
        });
        steps.push({ step: 'attach_player_script', ok: attachScript.ok, detail: attachScript.stderr || attachScript.stdout });
      }

      // 7) Set main scene
      const setMain = await runOperation('set_main_scene', { scenePath });
      steps.push({ step: 'set_main_scene', ok: setMain.ok, detail: setMain.stderr || setMain.stdout });

      const allOk = steps.every((s) => s.ok);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: allOk,
                summary: allOk
                  ? 'Gameplay prototype scaffold completed.'
                  : 'Scaffold completed with some failed steps. Check steps[] details.',
                outputs: {
                  mainScene: scenePath,
                  playerScene: playerScenePath,
                  playerScript: includePlayerScript ? 'scripts/player.gd' : null,
                },
                steps,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to scaffold gameplay prototype: ${error?.message || 'Unknown error'}`, [
        'Ensure Godot is installed and accessible',
        'Check project path and write permissions',
      ]);
    }
  }

  /**
   * Pre-apply LSP validation gate
   */
  private async handleValidatePatchWithLsp(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.scriptPath) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and scriptPath']);
    }

    try {
      const lspResult = await this.handleLSP('lsp_get_diagnostics', {
        projectPath: args.projectPath,
        scriptPath: args.scriptPath,
      });

      const textPayload = lspResult?.content?.[0]?.text || '{}';
      let diagnostics: any[] = [];
      try {
        const parsed = JSON.parse(textPayload);
        diagnostics = Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : [];
      } catch {
        diagnostics = [];
      }

      const hasBlocking = diagnostics.some((d: any) => {
        const severity = d?.severity;
        return severity === 1 || severity === 'error' || severity === 'ERROR';
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                scriptPath: args.scriptPath,
                diagnosticsCount: diagnostics.length,
                blockOnError: hasBlocking,
                canApply: !hasBlocking,
                diagnostics,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed LSP validation: ${error?.message || 'Unknown error'}`, [
        'Ensure Godot editor is running with LSP enabled (port 6005)',
      ]);
    }
  }

  /**
   * Version and protocol gate
   */
  private async handleEnforceVersionGate(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide projectPath']);
    }

    const minGodotVersion = args.minGodotVersion || '4.2';
    const minProtocolVersion = args.minProtocolVersion || '1.0';

    try {
      const versionResult = await this.handleGetGodotVersion();
      const godotVersion = (versionResult?.content?.[0]?.text || '').trim();
      const godotOk = this.compareMajorMinorVersions(godotVersion, minGodotVersion);

      let runtimeProtocol = 'unknown';
      let runtimeConnected = false;
      let protocolOk = false;
      let capabilityInfo: any = {};

      const runtime = await this.handleRuntimeCommand('ping', {});
      const runtimeText = runtime?.content?.[0]?.text || '{}';
      try {
        const parsed = JSON.parse(runtimeText);
        runtimeConnected = !parsed?.error;
        runtimeProtocol = parsed?.protocol_version || parsed?.protocolVersion || '1.0';
        capabilityInfo = {
          hasRuntime: runtimeConnected,
          responseType: parsed?.type || null,
        };
      } catch {
        runtimeConnected = false;
      }

      protocolOk = this.compareMajorMinorVersions(runtimeProtocol, minProtocolVersion);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: godotOk && (runtimeConnected ? protocolOk : true),
                requirements: {
                  minGodotVersion,
                  minProtocolVersion,
                },
                actual: {
                  godotVersion,
                  runtimeConnected,
                  runtimeProtocol,
                },
                checks: {
                  godotOk,
                  protocolOk: runtimeConnected ? protocolOk : null,
                },
                capabilityInfo,
                recommendation:
                  godotOk
                    ? runtimeConnected
                      ? protocolOk
                        ? 'Version gate passed.'
                        : 'Runtime protocol is below minimum. Update runtime addon.'
                      : 'Godot version is compatible. Runtime addon not connected; run project/addon for full protocol check.'
                    : 'Godot version below minimum requirement. Upgrade Godot.',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to enforce version gate: ${error?.message || 'Unknown error'}`, [
        'Ensure Godot is installed and runtime addon is available',
      ]);
    }
  }

  private getIntentMemoryDir(projectPath: string): string {
    const dir = join(projectPath, '.godot-mcp-memory');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private scheduleLogFlush(): void {
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => {
      this.flushLogQueue();
    }, this.logFlushIntervalMs);
  }

  private flushLogQueue(): void {
    const batch = this.logQueue.splice(0, this.logQueue.length);
    this.logFlushTimer = null;
    if (batch.length === 0) return;

    const grouped = new Map<string, string[]>();
    for (const item of batch) {
      const line = JSON.stringify(item.payload) + '\n';
      const existing = grouped.get(item.filePath) || [];
      existing.push(line);
      grouped.set(item.filePath, existing);
    }

    for (const [filePath, lines] of grouped.entries()) {
      appendFileSync(filePath, lines.join(''), 'utf8');
    }
  }

  private appendJsonl(filePath: string, payload: Record<string, unknown>): void {
    // Lite mode: asynchronous queued write to reduce user-facing latency
    // Full mode: still queued/batched to avoid frequent fs sync stalls
    this.logQueue.push({ filePath, payload });

    // Backpressure guard: if queue grows too large, flush immediately
    if (this.logQueue.length >= 50) {
      this.flushLogQueue();
      return;
    }

    this.scheduleLogFlush();
  }

  private readJsonArray(filePath: string): any[] {
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeJsonArray(filePath: string, value: any[]): void {
    writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  }

  private readJsonl(filePath: string): any[] {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((v) => v !== null);
  }

  private extractLastJsonLine(stdout: string): string | null {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!(line.startsWith('{') || line.startsWith('['))) {
        continue;
      }

      try {
        JSON.parse(line);
        return line;
      } catch {
        continue;
      }
    }

    return null;
  }

  private sanitizeGodotStderr(stderr: string): string {
    if (!stderr) {
      return stderr;
    }

    const ignoredPatterns = [
      /WARNING: ObjectDB instances leaked at exit/i,
      /at:\s+cleanup\s+\(core\/object\/object\.cpp:/i,
      /ERROR:\s+\d+\s+resources still in use at exit/i,
      /at:\s+clear\s+\(core\/io\/resource\.cpp:/i,
    ];

    const filteredLines = stderr
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return false;
        }
        return !ignoredPatterns.some((pattern) => pattern.test(trimmed));
      });

    return filteredLines.join('\n').trim();
  }

  /**
   * Capture/update current intent snapshot
   */
  private async handleCaptureIntentSnapshot(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.goal) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and goal']);
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure project.godot exists']);
    }

    const memoryDir = this.getIntentMemoryDir(args.projectPath);
    const indexPath = join(memoryDir, 'intent-index.json');

    const existing = this.readJsonArray(indexPath);
    const intentId = `intent_${Date.now()}`;

    const snapshot = {
      intent_id: intentId,
      ts: new Date().toISOString(),
      goal: args.goal,
      why: args.why || '',
      constraints: Array.isArray(args.constraints) ? args.constraints : [],
      acceptance_criteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria : [],
      non_goals: Array.isArray(args.nonGoals) ? args.nonGoals : [],
      priority: args.priority || 'P1',
      status: 'active',
    };

    for (const item of existing) {
      if (item && item.status === 'active') {
        item.status = 'archived';
      }
    }
    existing.push(snapshot);
    this.writeJsonArray(indexPath, existing);

    const eventsPath = join(memoryDir, 'dev-activity.jsonl');
    this.appendJsonl(eventsPath, {
      ts: new Date().toISOString(),
      actor: 'mcp-server',
      action: 'capture_intent_snapshot',
      intent_id: intentId,
      result: 'success',
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, intent: snapshot, files: { indexPath, eventsPath } }, null, 2),
        },
      ],
    };
  }

  /**
   * Record decision log entry
   */
  private async handleRecordDecisionLog(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.decision) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and decision']);
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure project.godot exists']);
    }

    const memoryDir = this.getIntentMemoryDir(args.projectPath);
    const indexPath = join(memoryDir, 'intent-index.json');
    const decisionsPath = join(memoryDir, 'decision-log.jsonl');

    const intents = this.readJsonArray(indexPath);
    const activeIntent = intents.find((i) => i && i.status === 'active');
    const intentId = args.intentId || activeIntent?.intent_id || null;

    const decisionRecord = {
      decision_id: `dec_${Date.now()}`,
      ts: new Date().toISOString(),
      intent_id: intentId,
      decision: args.decision,
      rationale: args.rationale || '',
      alternatives_rejected: Array.isArray(args.alternativesRejected) ? args.alternativesRejected : [],
      evidence_refs: Array.isArray(args.evidenceRefs) ? args.evidenceRefs : [],
    };

    this.appendJsonl(decisionsPath, decisionRecord);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, decision: decisionRecord, file: decisionsPath }, null, 2),
        },
      ],
    };
  }

  /**
   * Generate handoff brief
   */
  private async handleGenerateHandoffBrief(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide projectPath']);
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure project.godot exists']);
    }

    const maxItems = Number.isFinite(Number(args.maxItems)) ? Number(args.maxItems) : 5;
    const memoryDir = this.getIntentMemoryDir(args.projectPath);
    const indexPath = join(memoryDir, 'intent-index.json');
    const decisionsPath = join(memoryDir, 'decision-log.jsonl');
    const eventsPath = join(memoryDir, 'dev-activity.jsonl');

    const intents = this.readJsonArray(indexPath);
    const decisions = this.readJsonl(decisionsPath);
    const events = this.readJsonl(eventsPath);

    const activeIntent = intents.find((i) => i && i.status === 'active');
    const relatedDecisions = decisions.filter((d) => d?.intent_id && activeIntent?.intent_id && d.intent_id === activeIntent.intent_id).slice(-maxItems);
    const recentEvents = events.slice(-maxItems);

    const brief = {
      handoff_id: `handoff_${Date.now()}`,
      ts: new Date().toISOString(),
      current_goal: activeIntent?.goal || null,
      constraints: activeIntent?.constraints || [],
      acceptance_criteria: activeIntent?.acceptance_criteria || [],
      open_decisions: relatedDecisions.map((d) => d.decision),
      recent_actions: recentEvents.map((e) => `${e.ts} ${e.action}`),
      next_actions: [
        'Validate active intent against latest user message',
        'Resolve top open decision and record rationale',
        'Execute next implementation step and append execution trace',
      ],
    };

    const handoffPath = join(memoryDir, 'handoff-latest.json');
    writeFileSync(handoffPath, JSON.stringify(brief, null, 2), 'utf8');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, handoff: brief, file: handoffPath }, null, 2),
        },
      ],
    };
  }

  /**
   * Summarize current intent context
   */
  private async handleSummarizeIntentContext(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide projectPath']);
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure project.godot exists']);
    }

    const memoryDir = this.getIntentMemoryDir(args.projectPath);
    const indexPath = join(memoryDir, 'intent-index.json');
    const decisionsPath = join(memoryDir, 'decision-log.jsonl');

    const intents = this.readJsonArray(indexPath);
    const decisions = this.readJsonl(decisionsPath);
    const activeIntent = intents.find((i) => i && i.status === 'active');

    const relatedDecisions = decisions.filter((d) => d?.intent_id && activeIntent?.intent_id && d.intent_id === activeIntent.intent_id).slice(-3);

    const summary = {
      goal: activeIntent?.goal || null,
      why: activeIntent?.why || null,
      constraints: activeIntent?.constraints || [],
      acceptance_criteria: activeIntent?.acceptance_criteria || [],
      recent_decisions: relatedDecisions.map((d) => ({
        decision: d.decision,
        rationale: d.rationale,
      })),
      risk: relatedDecisions.length === 0 ? 'No decisions logged yet; context may be weak.' : null,
      next_action: 'Call generate_handoff_brief after next major change.',
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  /**
   * Unified work-step recorder (trace + optional handoff pack refresh)
   */
  private async handleRecordWorkStep(args: any) {
    args = this.normalizeParameters(args);

    const traceResponse: any = await this.handleRecordExecutionTrace(args);
    const refreshHandoffPack = args.refreshHandoffPack !== false;

    if (!refreshHandoffPack) {
      return traceResponse;
    }

    const handoffResponse: any = await this.handleExportHandoffPack({
      projectPath: args.projectPath,
      maxItems: args.maxItems,
    });

    const traceText = traceResponse?.content?.[0]?.text;
    const handoffText = handoffResponse?.content?.[0]?.text;

    let tracePayload: any = null;
    let handoffPayload: any = null;

    try { tracePayload = traceText ? JSON.parse(traceText) : null; } catch {}
    try { handoffPayload = handoffText ? JSON.parse(handoffText) : null; } catch {}

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: !!(tracePayload?.success && handoffPayload?.success),
              mode: 'record_work_step',
              trace: tracePayload,
              handoffPack: handoffPayload,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Record execution trace
   */
  private async handleRecordExecutionTrace(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.action || !args.result) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, action, result']);
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure project.godot exists']);
    }

    const memoryDir = this.getIntentMemoryDir(args.projectPath);
    const indexPath = join(memoryDir, 'intent-index.json');
    const eventsPath = join(memoryDir, 'dev-activity.jsonl');
    const tracesPath = join(memoryDir, 'execution-trace.jsonl');

    const intents = this.readJsonArray(indexPath);
    const activeIntent = intents.find((i) => i && i.status === 'active');
    const intentId = args.intentId || activeIntent?.intent_id || null;

    const liteMode = this.recordingMode === 'lite';

    const trace = {
      trace_id: `trace_${Date.now()}`,
      ts: new Date().toISOString(),
      intent_id: intentId,
      action: args.action,
      command: args.command || null,
      files_changed: Array.isArray(args.filesChanged) ? args.filesChanged : [],
      result: args.result,
      artifact: args.artifact || null,
      error: args.error || null,
      mode: this.recordingMode,
    };

    this.appendJsonl(tracesPath, trace);

    this.appendJsonl(eventsPath, {
      ts: new Date().toISOString(),
      actor: 'mcp-server',
      action: 'record_execution_trace',
      intent_id: intentId,
      result: args.result,
      summary: liteMode ? `${args.action}:${args.result}` : `${args.action}:${args.result} files=${trace.files_changed.length}`,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, trace, file: tracesPath }, null, 2),
        },
      ],
    };
  }

  /**
   * Export handoff pack for team-mode relay
   */
  private async handleExportHandoffPack(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide projectPath']);
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure project.godot exists']);
    }

    const maxItems = Number.isFinite(Number(args.maxItems)) ? Number(args.maxItems) : 10;
    const memoryDir = this.getIntentMemoryDir(args.projectPath);
    const indexPath = join(memoryDir, 'intent-index.json');
    const decisionsPath = join(memoryDir, 'decision-log.jsonl');
    const tracesPath = join(memoryDir, 'execution-trace.jsonl');

    const intents = this.readJsonArray(indexPath);
    const decisions = this.readJsonl(decisionsPath);
    const traces = this.readJsonl(tracesPath);

    const activeIntent = intents.find((i) => i && i.status === 'active');
    const intentId = activeIntent?.intent_id || null;

    const relatedDecisions = decisions.filter((d) => d?.intent_id && intentId && d.intent_id === intentId).slice(-maxItems);
    const relatedTraces = traces.filter((t) => t?.intent_id && intentId && t.intent_id === intentId).slice(-maxItems);

    const handoffPack = {
      pack_id: `pack_${Date.now()}`,
      ts: new Date().toISOString(),
      mode: this.recordingMode,
      intent: activeIntent || null,
      decisions: relatedDecisions,
      execution_traces: relatedTraces,
      summary: {
        decisions_count: relatedDecisions.length,
        traces_count: relatedTraces.length,
        latest_result: relatedTraces.length > 0 ? relatedTraces[relatedTraces.length - 1].result : null,
      },
      next_actions: [
        'Check intent acceptance criteria against latest changes',
        'Resolve remaining open decisions',
        'Execute next highest-priority trace and record result',
      ],
    };

    const packPath = join(memoryDir, 'handoff_pack.json');
    writeFileSync(packPath, JSON.stringify(handoffPack, null, 2), 'utf8');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, file: packPath, handoffPack }, null, 2),
        },
      ],
    };
  }

  /**
   * Set recording mode
   */
  private async handleSetRecordingMode(args: any) {
    args = this.normalizeParameters(args);
    const mode = `${args.mode || ''}`.toLowerCase();

    if (mode !== 'lite' && mode !== 'full') {
      return this.createErrorResponse('Invalid mode', ['Use mode="lite" or mode="full"']);
    }

    this.recordingMode = mode as 'lite' | 'full';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, recordingMode: this.recordingMode }, null, 2),
        },
      ],
    };
  }

  /**
   * Get recording mode
   */
  private async handleGetRecordingMode() {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              recordingMode: this.recordingMode,
              queueSize: this.logQueue.length,
              flushIntervalMs: this.logFlushIntervalMs,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType: args.rootNodeType || 'Node2D',
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const version = await this.getGodotVersionText();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const version = await this.getGodotVersionText();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  // ============================================
  // Phase 1: Scene Operations Handlers
  // ============================================

  /**
   * Handle the list_scene_nodes tool
   */
  private async handleListSceneNodes(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct', 'Use create_scene to create a new scene first']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        depth: args.depth !== undefined ? args.depth : -1,
        includeProperties: args.includeProperties || false,
      };

      const { stdout, stderr } = await this.executeOperation('list_scene_nodes', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to list scene nodes: ${stderr}`,
          ['Verify the scene file is valid']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list scene nodes: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the get_node_properties tool
   */
  private async handleGetNodeProperties(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and nodePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        includeDefaults: args.includeDefaults || false,
      };

      const { stdout, stderr } = await this.executeOperation('get_node_properties', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to get node properties: ${stderr}`,
          ['Verify the node path is correct', 'Check if the node exists in the scene']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get node properties: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the set_node_properties tool
   */
  private async handleSetNodeProperties(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.properties) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and properties']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        properties: args.properties,
        saveScene: args.saveScene !== false,
      };

      const { stdout, stderr } = await this.executeOperation('set_node_properties', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to set node properties: ${stderr}`,
          ['Verify the node path is correct', 'Check if properties are valid for the node type']
        );
      }

      return {
        content: [{ type: 'text', text: `Properties updated successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set node properties: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the delete_node tool
   */
  private async handleDeleteNode(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and nodePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        saveScene: args.saveScene !== false,
      };

      const { stdout, stderr } = await this.executeOperation('delete_node', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to delete node: ${stderr}`,
          ['Verify the node path is correct', 'Cannot delete root node']
        );
      }

      return {
        content: [{ type: 'text', text: `Node deleted successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to delete node: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the duplicate_node tool
   */
  private async handleDuplicateNode(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.newName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and newName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        newName: args.newName,
        saveScene: args.saveScene !== false,
      };

      if (args.parentPath) {
        params.parentPath = args.parentPath;
      }

      const { stdout, stderr } = await this.executeOperation('duplicate_node', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to duplicate node: ${stderr}`,
          ['Verify the node path is correct', 'Check if the new name is valid']
        );
      }

      return {
        content: [{ type: 'text', text: `Node duplicated successfully as '${args.newName}'.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to duplicate node: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the reparent_node tool
   */
  private async handleReparentNode(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.newParentPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and newParentPath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        newParentPath: args.newParentPath,
        saveScene: args.saveScene !== false,
      };

      const { stdout, stderr } = await this.executeOperation('reparent_node', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to reparent node: ${stderr}`,
          ['Verify both node paths are correct', 'Cannot reparent root node']
        );
      }

      return {
        content: [{ type: 'text', text: `Node reparented successfully to '${args.newParentPath}'.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to reparent node: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Phase 2: Import/Export Pipeline Handlers
  // ============================================

  /**
   * Handle the get_import_status tool
   */
  private async handleGetImportStatus(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        resourcePath: args.resourcePath || '',
        includeUpToDate: args.includeUpToDate || false,
      };

      const { stdout, stderr } = await this.executeOperation('get_import_status', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to get import status: ${stderr}`,
          ['Verify the resource path if specified']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get import status: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the get_import_options tool
   */
  private async handleGetImportOptions(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.resourcePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and resourcePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.resourcePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const resourceFile = join(args.projectPath, args.resourcePath);
      if (!existsSync(resourceFile)) {
        return this.createErrorResponse(
          `Resource file does not exist: ${args.resourcePath}`,
          ['Ensure the resource path is correct']
        );
      }

      const params: any = {
        resourcePath: args.resourcePath,
      };

      const { stdout, stderr } = await this.executeOperation('get_import_options', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to get import options: ${stderr}`,
          ['Verify the resource is an importable file type']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get import options: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the set_import_options tool
   */
  private async handleSetImportOptions(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.resourcePath || !args.options) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, resourcePath, and options']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.resourcePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const resourceFile = join(args.projectPath, args.resourcePath);
      if (!existsSync(resourceFile)) {
        return this.createErrorResponse(
          `Resource file does not exist: ${args.resourcePath}`,
          ['Ensure the resource path is correct']
        );
      }

      const params: any = {
        resourcePath: args.resourcePath,
        options: args.options,
        reimport: args.reimport !== false,
      };

      const { stdout, stderr } = await this.executeOperation('set_import_options', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to set import options: ${stderr}`,
          ['Verify the options are valid for this resource type']
        );
      }

      return {
        content: [{ type: 'text', text: `Import options updated successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set import options: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the reimport_resource tool
   */
  private async handleReimportResource(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      if (args.resourcePath) {
        const resourceFile = join(args.projectPath, args.resourcePath);
        if (!existsSync(resourceFile)) {
          return this.createErrorResponse(
            `Resource file does not exist: ${args.resourcePath}`,
            ['Ensure the resource path is correct']
          );
        }
      }

      const params: any = {
        resourcePath: args.resourcePath || '',
        force: args.force || false,
      };

      const { stdout, stderr } = await this.executeOperation('reimport_resource', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to reimport resource: ${stderr}`,
          ['Verify the resource path if specified']
        );
      }

      return {
        content: [{ type: 'text', text: `Reimport completed.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to reimport resource: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the list_export_presets tool
   */
  private async handleListExportPresets(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        includeTemplateStatus: args.includeTemplateStatus !== false,
      };

      const { stdout, stderr } = await this.executeOperation('list_export_presets', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to list export presets: ${stderr}`,
          ['Check if export_presets.cfg exists in the project']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list export presets: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the export_project tool
   */
  private async handleExportProject(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.preset || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, preset, and outputPath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.outputPath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      // Export uses Godot's CLI directly, not our script
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            ['Ensure Godot is installed correctly', 'Set GODOT_PATH environment variable']
          );
        }
      }

      const exportFlag = args.debug ? '--export-debug' : '--export-release';
      const interop = this.getWSLInteropDetails(this.godotPath);
      const translatedOutputPath = this.translatePathForGodot(args.outputPath, interop, 'Export output path');
      const prepared = this.prepareProjectScopedCommand(
        args.projectPath,
        ['--headless'],
        [exportFlag, args.preset, translatedOutputPath]
      );
      
      this.logDebug(`Export command: ${prepared.command} ${prepared.args.join(' ')}`);
      
      const execOptions = prepared.cwd
        ? { cwd: prepared.cwd, timeout: 300000 }
        : { timeout: 300000 };
      const { stdout, stderr } = await execFileAsync(prepared.command, prepared.args, execOptions); // 5 minute timeout for exports

      if (stderr && (stderr.includes('ERROR') || stderr.includes('Invalid preset'))) {
        return this.createErrorResponse(
          `Failed to export project: ${stderr}`,
          ['Verify the preset name is correct', 'Ensure export templates are installed']
        );
      }

      return {
        content: [{ type: 'text', text: `Project exported successfully to: ${args.outputPath}\n\n${stdout}${stderr}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export project: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify export templates are installed', 'Check the preset name is valid']
      );
    }
  }

  /**
   * Handle the validate_project tool
   */
  private async handleValidateProject(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        preset: args.preset || '',
        includeSuggestions: args.includeSuggestions !== false,
      };

      const { stdout, stderr } = await this.executeOperation('validate_project', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to validate project: ${stderr}`,
          ['Verify the project structure is valid']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to validate project: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Phase 3: DX Tools Handlers
  // ============================================

  /**
   * Handle the get_dependencies tool
   */
  private async handleGetDependencies(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.resourcePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and resourcePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.resourcePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        resourcePath: args.resourcePath,
        depth: args.depth !== undefined ? args.depth : -1,
        includeBuiltin: args.includeBuiltin || false,
      };

      const { stdout, stderr } = await this.executeOperation('get_dependencies', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to get dependencies: ${stderr}`,
          ['Verify the resource path is correct']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get dependencies: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the find_resource_usages tool
   */
  private async handleFindResourceUsages(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.resourcePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and resourcePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.resourcePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        resourcePath: args.resourcePath,
        fileTypes: args.fileTypes || ['tscn', 'tres', 'gd'],
      };

      const { stdout, stderr } = await this.executeOperation('find_resource_usages', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to find resource usages: ${stderr}`,
          ['Verify the resource path is correct']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to find resource usages: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the parse_error_log tool
   */
  private async handleParseErrorLog(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        logContent: args.logContent || '',
        maxErrors: args.maxErrors || 50,
      };

      const { stdout, stderr } = await this.executeOperation('parse_error_log', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to parse error log: ${stderr}`,
          ['Verify the log content or ensure godot.log exists']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to parse error log: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the get_project_health tool
   */
  private async handleGetProjectHealth(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        includeDetails: args.includeDetails !== false,
      };

      const { stdout, stderr } = await this.executeOperation('get_project_health', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to get project health: ${stderr}`,
          ['Verify the project structure']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project health: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Phase 3: Project Configuration Handlers
  // ============================================

  /**
   * Handle the get_project_setting tool
   */
  private async handleGetProjectSetting(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.setting) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and setting']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        setting: args.setting,
      };

      const { stdout, stderr } = await this.executeOperation('get_project_setting', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to get project setting: ${stderr}`,
          ['Verify the setting path is correct']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project setting: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the set_project_setting tool
   */
  private async handleSetProjectSetting(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.setting || args.value === undefined) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, setting, and value']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        setting: args.setting,
        value: args.value,
      };

      const { stdout, stderr } = await this.executeOperation('set_project_setting', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to set project setting: ${stderr}`,
          ['Verify the setting path and value']
        );
      }

      return {
        content: [{ type: 'text', text: `Setting updated successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set project setting: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the add_autoload tool
   */
  private async handleAddAutoload(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.name || !args.path) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, name, and path']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.path)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        name: args.name,
        path: args.path,
        enabled: args.enabled !== false,
      };

      const { stdout, stderr } = await this.executeOperation('add_autoload', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to add autoload: ${stderr}`,
          ['Verify the script/scene path exists']
        );
      }

      return {
        content: [{ type: 'text', text: `Autoload '${args.name}' added successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add autoload: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the remove_autoload tool
   */
  private async handleRemoveAutoload(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.name) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and name']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        name: args.name,
      };

      const { stdout, stderr } = await this.executeOperation('remove_autoload', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to remove autoload: ${stderr}`,
          ['Verify the autoload name exists']
        );
      }

      return {
        content: [{ type: 'text', text: `Autoload '${args.name}' removed successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to remove autoload: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the list_autoloads tool
   */
  private async handleListAutoloads(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const { stdout, stderr } = await this.executeOperation('list_autoloads', {}, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to list autoloads: ${stderr}`,
          ['Verify the project structure']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list autoloads: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the set_main_scene tool
   */
  private async handleSetMainScene(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const sceneFile = join(args.projectPath, args.scenePath);
      if (!existsSync(sceneFile)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
      };

      const { stdout, stderr } = await this.executeOperation('set_main_scene', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to set main scene: ${stderr}`,
          ['Verify the scene path is correct']
        );
      }

      return {
        content: [{ type: 'text', text: `Main scene set to '${args.scenePath}'.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set main scene: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Signal Management Handlers
  // ============================================

  /**
   * Handle the connect_signal tool
   */
  private async handleConnectSignal(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.sourceNodePath || !args.signalName || !args.targetNodePath || !args.methodName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, sourceNodePath, signalName, targetNodePath, and methodName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct', 'Use create_scene to create a new scene first']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        sourceNodePath: args.sourceNodePath,
        signalName: args.signalName,
        targetNodePath: args.targetNodePath,
        methodName: args.methodName,
      };

      if (args.flags !== undefined) {
        params.flags = args.flags;
      }

      const { stdout, stderr } = await this.executeOperation('connect_signal', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to connect signal: ${stderr}`,
          ['Verify node paths are correct', 'Ensure the signal exists on the source node']
        );
      }

      return {
        content: [{ type: 'text', text: `Signal '${args.signalName}' connected successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to connect signal: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the disconnect_signal tool
   */
  private async handleDisconnectSignal(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.sourceNodePath || !args.signalName || !args.targetNodePath || !args.methodName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, sourceNodePath, signalName, targetNodePath, and methodName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        sourceNodePath: args.sourceNodePath,
        signalName: args.signalName,
        targetNodePath: args.targetNodePath,
        methodName: args.methodName,
      };

      const { stdout, stderr } = await this.executeOperation('disconnect_signal', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to disconnect signal: ${stderr}`,
          ['Verify the connection exists', 'Check node paths and signal/method names']
        );
      }

      return {
        content: [{ type: 'text', text: `Signal '${args.signalName}' disconnected successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to disconnect signal: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the list_connections tool
   */
  private async handleListConnections(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
      };

      if (args.nodePath) {
        params.nodePath = args.nodePath;
      }

      const { stdout, stderr } = await this.executeOperation('list_connections', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to list connections: ${stderr}`,
          ['Verify the scene path is correct']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list connections: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Phase 4: Runtime Tools Handlers
  // ============================================

  /**
   * Handle the get_runtime_status tool
   */
  private async handleGetRuntimeStatus(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    // Resolve once so diagnostic messages report the actual port this session's
    // handleRuntimeCommand probes — the allocated per-session port (multi-session),
    // not a stale 7777 literal or the unoffset env default.
    const runtimePort = this.allocatedRuntimePort || resolveDefaultRuntimePort();

    try {
      const runtime = await this.handleRuntimeCommand('ping', {});
      const runtimeText = runtime?.content?.[0]?.text || '';

      let runtimePayload: any = null;
      try {
        runtimePayload = JSON.parse(runtimeText);
      } catch {
        runtimePayload = null;
      }

      const runtimeConnected = runtimePayload?.type === 'pong';

      if (runtimeConnected) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              connected: true,
              status: 'running',
              processActive: Boolean(this.activeProcess),
              runtimeAddon: 'connected',
              note: 'Godot runtime addon responded to ping. Use inspect_runtime_tree to explore.',
              runtimeResponse: runtimePayload,
            }, null, 2),
          }],
        };
      }

      if (this.activeProcess) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              connected: false,
              status: 'process_running_runtime_disconnected',
              processActive: true,
              runtimeAddon: 'unreachable',
              note: `A Godot process is active, but the runtime addon did not respond on port ${runtimePort}.`,
              runtimeResponse: runtimeText,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: false,
            status: 'not_running',
            processActive: false,
            runtimeAddon: 'unreachable',
            note: 'No active Godot process or runtime addon detected. Use run_project to start one.',
            runtimeResponse: runtimeText,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get runtime status: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly']
      );
    }
  }

  /**
   * Handle the inspect_runtime_tree tool
   */
  private async handleInspectRuntimeTree(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    try {
      return await this.handleRuntimeCommand('get_tree', {
        root: args.nodePath || '/root',
        depth: args.depth || 3,
        include_properties: Boolean(args.includeProperties),
      });
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to inspect runtime tree: ${error?.message || 'Unknown error'}`,
        ['Ensure a Godot process is running with the runtime addon enabled']
      );
    }
  }

  /**
   * Handle the set_runtime_property tool
   */
  private async handleSetRuntimeProperty(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.nodePath || !args.property || args.value === undefined) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, nodePath, property, and value']
      );
    }

    try {
      return await this.handleRuntimeCommand('set_property', {
        path: args.nodePath,
        property: args.property,
        value: args.value,
      });
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set runtime property: ${error?.message || 'Unknown error'}`,
        ['Ensure a Godot process is running with the runtime addon']
      );
    }
  }

  /**
   * Handle the call_runtime_method tool
   */
  private async handleCallRuntimeMethod(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.nodePath || !args.method) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, nodePath, and method']
      );
    }

    try {
      return await this.handleRuntimeCommand('call_method', {
        path: args.nodePath,
        method: args.method,
        args: Array.isArray(args.args) ? args.args : [],
      });
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to call runtime method: ${error?.message || 'Unknown error'}`,
        ['Ensure a Godot process is running with the runtime addon']
      );
    }
  }

  /**
   * Handle the get_runtime_metrics tool
   */
  private async handleGetRuntimeMetrics(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    try {
      return await this.handleRuntimeCommand('get_metrics', {
        metrics: Array.isArray(args.metrics) ? args.metrics : [],
      });
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get runtime metrics: ${error?.message || 'Unknown error'}`,
        ['Ensure a Godot process is running']
      );
    }
  }

  // ============================================
  // GDScript File Operations Handlers
  // ============================================

  /**
   * Handle the create_script tool
   * Creates a new GDScript file with proper structure and optional templates
   */
  private async handleCreateScript(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!args.scriptPath) {
      return this.createErrorResponse(
        'Script path is required',
        ['Provide a path for the new script file (e.g., "scripts/player.gd")']
      );
    }

    if (!args.scriptPath.endsWith('.gd')) {
      return this.createErrorResponse(
        'Script path must end with .gd extension',
        ['Provide a valid GDScript path (e.g., "scripts/player.gd")']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        ['Ensure the path points to a directory containing a project.godot file']
      );
    }

    try {
      const params = {
        script_path: args.scriptPath,
        class_name: args.className || '',
        extends_class: args.extends || 'Node',
        content: args.content || '',
        template: args.template || '',
      };

      const { stdout, stderr } = await this.executeOperation('create_script', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to create script: ${stderr}`,
          ['Check the script path and ensure parent directories exist']
        );
      }

      // Try to parse JSON result
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        }
      } catch {
        // Fall through to return raw output
      }

      return {
        content: [{
          type: 'text',
          text: stdout.trim(),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create script: ${error?.message || 'Unknown error'}`,
        ['Check that Godot is properly installed and accessible']
      );
    }
  }

  /**
   * Handle the modify_script tool
   * Modifies an existing GDScript file by adding functions, variables, or signals
   */
  private async handleModifyScript(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!args.scriptPath) {
      return this.createErrorResponse(
        'Script path is required',
        ['Provide the path to an existing script file']
      );
    }

    if (!args.modifications || !Array.isArray(args.modifications) || args.modifications.length === 0) {
      return this.createErrorResponse(
        'Modifications array is required',
        ['Provide an array of modifications with type and name properties']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        ['Ensure the path points to a directory containing a project.godot file']
      );
    }

    try {
      const params = {
        script_path: args.scriptPath,
        modifications: args.modifications,
      };

      const { stdout, stderr } = await this.executeOperation('modify_script', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to modify script: ${stderr}`,
          ['Check that the script file exists and is a valid GDScript']
        );
      }

      // Try to parse JSON result
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        }
      } catch {
        // Fall through to return raw output
      }

      return {
        content: [{
          type: 'text',
          text: stdout.trim(),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to modify script: ${error?.message || 'Unknown error'}`,
        ['Check that Godot is properly installed and accessible']
      );
    }
  }

  /**
   * Handle the get_script_info tool
   * Analyzes a GDScript file and returns its structure
   */
  private async handleGetScriptInfo(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!args.scriptPath) {
      return this.createErrorResponse(
        'Script path is required',
        ['Provide the path to a script file to analyze']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        ['Ensure the path points to a directory containing a project.godot file']
      );
    }

    try {
      const params = {
        script_path: args.scriptPath,
        include_inherited: args.includeInherited || false,
      };

      const { stdout, stderr } = await this.executeOperation('get_script_info', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to analyze script: ${stderr}`,
          ['Check that the script file exists and is a valid GDScript']
        );
      }

      // Try to parse JSON result
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        }
      } catch {
        // Fall through to return raw output
      }

      return {
        content: [{
          type: 'text',
          text: stdout.trim(),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to analyze script: ${error?.message || 'Unknown error'}`,
        ['Check that Godot is properly installed and accessible']
      );
    }
  }

  // ============================================
  // Resource Creation Tools Handlers
  // ============================================

  /**
   * Handle the create_resource tool
   */
  private async handleCreateResource(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.resourcePath || !args.resourceType) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, resourcePath, and resourceType']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.resourcePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      // If a script path is provided, verify it exists
      if (args.script) {
        const scriptFile = join(args.projectPath, args.script);
        if (!existsSync(scriptFile)) {
          return this.createErrorResponse(
            `Script file does not exist: ${args.script}`,
            ['Ensure the script path is correct']
          );
        }
      }

      const params: any = {
        resourcePath: args.resourcePath,
        resourceType: args.resourceType,
        properties: args.properties || {},
        script: args.script || '',
      };

      const { stdout, stderr } = await this.executeOperation('create_resource', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to create resource: ${stderr}`,
          ['Verify the resource type is valid', 'Check if the class can be instantiated']
        );
      }

      return {
        content: [{ type: 'text', text: `Resource created successfully at: ${args.resourcePath}\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create resource: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the resource type exists']
      );
    }
  }

  /**
   * Handle the create_material tool
   */
  private async handleCreateMaterial(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.materialPath || !args.materialType) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, materialPath, and materialType']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.materialPath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const validMaterialTypes = ['StandardMaterial3D', 'ShaderMaterial', 'CanvasItemMaterial', 'ParticleProcessMaterial'];
    if (!validMaterialTypes.includes(args.materialType)) {
      return this.createErrorResponse(
        `Invalid material type: ${args.materialType}`,
        [`Valid types: ${validMaterialTypes.join(', ')}`]
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      // If a shader path is provided for ShaderMaterial, verify it exists
      if (args.shader && args.materialType === 'ShaderMaterial') {
        const shaderFile = join(args.projectPath, args.shader);
        if (!existsSync(shaderFile)) {
          return this.createErrorResponse(
            `Shader file does not exist: ${args.shader}`,
            ['Ensure the shader path is correct', 'Use create_shader to create a shader first']
          );
        }
      }

      const params: any = {
        materialPath: args.materialPath,
        materialType: args.materialType,
        properties: args.properties || {},
        shader: args.shader || '',
      };

      const { stdout, stderr } = await this.executeOperation('create_material', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to create material: ${stderr}`,
          ['Verify the material type is valid', 'Check property names and values']
        );
      }

      return {
        content: [{ type: 'text', text: `Material created successfully at: ${args.materialPath}\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create material: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the material type']
      );
    }
  }

  /**
   * Handle the create_shader tool
   */
  private async handleCreateShader(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.shaderPath || !args.shaderType) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, shaderPath, and shaderType']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.shaderPath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const validShaderTypes = ['canvas_item', 'spatial', 'particles', 'sky', 'fog'];
    if (!validShaderTypes.includes(args.shaderType)) {
      return this.createErrorResponse(
        `Invalid shader type: ${args.shaderType}`,
        [`Valid types: ${validShaderTypes.join(', ')}`]
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        shaderPath: args.shaderPath,
        shaderType: args.shaderType,
        code: args.code || '',
        template: args.template || '',
      };

      const { stdout, stderr } = await this.executeOperation('create_shader', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to create shader: ${stderr}`,
          ['Verify the shader type is valid', 'Check shader code syntax']
        );
      }

      return {
        content: [{ type: 'text', text: `Shader created successfully at: ${args.shaderPath}\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create shader: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the shader type']
      );
    }
  }

  // ============================================
  // Animation Tools Handlers
  // ============================================

  /**
   * Handle the create_animation tool
   * Creates a new animation in an AnimationPlayer node
   */
  private async handleCreateAnimation(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.playerNodePath || !args.animationName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, playerNodePath, and animationName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct', 'Use create_scene to create a new scene first']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        playerNodePath: args.playerNodePath,
        animationName: args.animationName,
        length: args.length !== undefined ? args.length : 1.0,
        loopMode: args.loopMode || 'none',
        step: args.step !== undefined ? args.step : 0.1,
      };

      const { stdout, stderr } = await this.executeOperation('create_animation', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to create animation: ${stderr}`,
          ['Verify the AnimationPlayer node path is correct', 'Check if the node is an AnimationPlayer']
        );
      }

      return {
        content: [{ type: 'text', text: `Animation '${args.animationName}' created successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create animation: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the add_animation_track tool
   * Adds a track to an existing animation in an AnimationPlayer
   */
  private async handleAddAnimationTrack(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.playerNodePath || !args.animationName || !args.track) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, playerNodePath, animationName, and track']
      );
    }

    if (!args.track.type || !args.track.nodePath || !args.track.keyframes) {
      return this.createErrorResponse(
        'Invalid track configuration',
        ['Track must have type, nodePath, and keyframes properties']
      );
    }

    if (!['property', 'method'].includes(args.track.type)) {
      return this.createErrorResponse(
        `Invalid track type: ${args.track.type}`,
        ['Track type must be "property" or "method"']
      );
    }

    if (args.track.type === 'property' && !args.track.property) {
      return this.createErrorResponse(
        'Property track requires a property name',
        ['Provide the property name to animate (e.g., "position", "modulate")']
      );
    }

    if (args.track.type === 'method' && !args.track.method) {
      return this.createErrorResponse(
        'Method track requires a method name',
        ['Provide the method name to call']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct']
        );
      }

      const params: any = {
        scenePath: args.scenePath,
        playerNodePath: args.playerNodePath,
        animationName: args.animationName,
        track: args.track,
      };

      const { stdout, stderr } = await this.executeOperation('add_animation_track', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to add animation track: ${stderr}`,
          ['Verify the animation exists', 'Check the node path and property/method name']
        );
      }

      return {
        content: [{ type: 'text', text: `Track added successfully to animation '${args.animationName}'.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add animation track: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Plugin Management Handlers
  // ============================================

  /**
   * Handle the list_plugins tool
   */
  private async handleListPlugins(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const { stdout, stderr } = await this.executeOperation('list_plugins', {}, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to list plugins: ${stderr}`,
          ['Verify the project structure']
        );
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list plugins: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the enable_plugin tool
   */
  private async handleEnablePlugin(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.pluginName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and pluginName']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        pluginName: args.pluginName,
      };

      const { stdout, stderr } = await this.executeOperation('enable_plugin', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to enable plugin: ${stderr}`,
          ['Verify the plugin exists in the addons directory', 'Check the plugin name is correct']
        );
      }

      return {
        content: [{ type: 'text', text: `Plugin '${args.pluginName}' enabled successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to enable plugin: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the disable_plugin tool
   */
  private async handleDisablePlugin(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.pluginName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and pluginName']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        pluginName: args.pluginName,
      };

      const { stdout, stderr } = await this.executeOperation('disable_plugin', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to disable plugin: ${stderr}`,
          ['Verify the plugin is currently enabled', 'Check the plugin name is correct']
        );
      }

      return {
        content: [{ type: 'text', text: `Plugin '${args.pluginName}' disabled successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to disable plugin: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Input Action Handlers
  // ============================================

  /**
   * Handle the add_input_action tool
   */
  private async handleAddInputAction(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.actionName || !args.events) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, actionName, and events']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    if (!Array.isArray(args.events) || args.events.length === 0) {
      return this.createErrorResponse(
        'Events must be a non-empty array',
        ['Provide at least one input event']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        actionName: args.actionName,
        events: args.events,
        deadzone: args.deadzone !== undefined ? args.deadzone : 0.5,
      };

      const { stdout, stderr } = await this.executeOperation('add_input_action', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to add input action: ${stderr}`,
          ['Verify the event types and parameters are valid']
        );
      }

      return {
        content: [{ type: 'text', text: `Input action '${args.actionName}' added successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add input action: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Project Search Handlers
  // ============================================

  private searchProjectNatively(
    projectPath: string,
    query: string,
    fileTypes: string[],
    useRegex: boolean,
    caseSensitive: boolean,
    maxResults: number
  ): Record<string, unknown> {
    const normalizedExtensions = new Set(
      fileTypes.map((ext) => ext.replace(/^\./, '').toLowerCase()).filter(Boolean)
    );
    const result = {
      query,
      results: [] as Array<{ file: string; matches: Array<{ line: number; content: string; match: string }> }>,
      summary: {
        files_searched: 0,
        files_with_matches: 0,
        total_matches: 0,
        truncated: false,
      },
    };

    const regex = useRegex ? new RegExp(query, caseSensitive ? '' : 'i') : null;
    const queryToCheck = caseSensitive ? query : query.toLowerCase();

    const visit = (dirPath: string) => {
      if (result.summary.total_matches >= maxResults) {
        result.summary.truncated = true;
        return;
      }

      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (result.summary.total_matches >= maxResults) {
          result.summary.truncated = true;
          return;
        }

        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.godot') {
          continue;
        }

        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() || '' : '';
        if (!normalizedExtensions.has(extension)) {
          continue;
        }

        result.summary.files_searched += 1;
        const content = readFileSync(entryPath, 'utf8');
        const lines = content.split('\n');
        const matches: Array<{ line: number; content: string; match: string }> = [];

        for (let index = 0; index < lines.length; index += 1) {
          if (result.summary.total_matches >= maxResults) {
            result.summary.truncated = true;
            break;
          }

          const line = lines[index];
          const match = regex
            ? regex.exec(line)?.[0]
            : ((caseSensitive ? line : line.toLowerCase()).includes(queryToCheck) ? query : '');

          if (match) {
            matches.push({
              line: index + 1,
              content: line.trim(),
              match,
            });
            result.summary.total_matches += 1;
          }
        }

        if (matches.length > 0) {
          const relativePath = entryPath.slice(projectPath.length + 1).replace(/\\/g, '/');
          result.results.push({
            file: `res://${relativePath}`,
            matches,
          });
          result.summary.files_with_matches += 1;
        }
      }
    };

    visit(projectPath);
    return result;
  }

  /**
   * Handle the search_project tool
   */
  private async handleSearchProject(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.query) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and query']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const params: any = {
        query: args.query,
        fileTypes: args.fileTypes || ['gd', 'tscn', 'tres'],
        regex: args.regex || false,
        caseSensitive: args.caseSensitive || false,
        maxResults: args.maxResults || 100,
      };
      const result = this.searchProjectNatively(
        args.projectPath,
        params.query,
        params.fileTypes,
        params.regex,
        params.caseSensitive,
        params.maxResults
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to search project: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Attach the stdio MCP transport FIRST so the server can respond
      // to protocol-level messages (initialize, prompts/list,
      // tools/list) within ~100ms of spawn. Godot-path detection runs
      // afterwards in the background: on WSL→Windows, `execFileAsync`
      // spawning a Windows `.exe` from WSL can take 5–10s cold due to
      // binfmt_misc + Defender, which previously gated the MCP
      // handshake and starved `scripts/smoke-test.mjs` (plus any other
      // MCP supervisor) that expected an `initialize` response inside
      // a few seconds.
      const transport = new StdioServerTransport();
      // Standard MCP-stdio shutdown signal: when the parent (Claude Code,
      // MCP Inspector, etc.) closes stdin, the transport emits onclose.
      // Without this hook, gopeak survives its parent and orphans onto
      // PID 1 — the root cause of the bridge-reliability incidents
      // documented in wiki/topics/mcp_fork_notes.md (orphan gopeaks holding
      // :6505 across sessions, leaving the editor plugin paired with a
      // dead bridge). See feedback_mcp_bridge_reliability memory.
      transport.onclose = () => {
        if (!this.shutdownInitiated) {
          console.error('[SERVER] Parent stdio closed (transport onclose) — shutting down gracefully');
        }
        void this.handleShutdown('stdio:transport-close', 0);
      };
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');

      this.godotReadyPromise = this.detectAndValidateGodotPath();
      // Once the Godot path is known, rewrite the discovery file so its
      // runtime_bind_host reflects the real interop mode. At startup godotPath
      // may still be null and GODOT_PATH unset, which would mis-detect 'native'
      // and record a loopback bind host that a WSL server can't reach on a
      // Windows game. The rewrite corrects it (no-op if nothing was written yet
      // — the later writeDiscoveryFile call then uses the resolved path).
      void this.godotReadyPromise.then(() => {
        if (this.discoveryFileProject) {
          this.writeDiscoveryFile(this.discoveryFileProject);
        }
      }).catch(() => {});

      // Start the Godot Editor Bridge after the transport is live but
      // without awaiting the Godot-path probe. Bridge start is fast
      // (localhost WebSocket) and its failure is non-fatal.

      // --- Multi-session port isolation --------------------------------
      // Auto-allocate a free bridge port so concurrent worktrees don't fight
      // over the default. The bridge binds on the gopeak (WSL) side, so a
      // localhost free-port probe is accurate here. Runtime + DAP-relay ports
      // derive from the resulting offset (computed post-start) — a Windows-side
      // probe would be meaningless from WSL, and inheriting the offset keeps
      // them unique per session. Offset 0 (single session) preserves the
      // historical 6505/7777/6016 defaults byte-for-byte.
      const bridgeBasePort = this.godotBridge.getStatus().port;
      const bridgeHost = this.godotBridge.getStatus().host;
      try {
        const freePort = await findFreePortFrom(bridgeBasePort, bridgeHost);
        if (freePort !== bridgeBasePort) {
          this.godotBridge = createBridge(freePort, undefined, bridgeHost);
          console.error(`[SERVER] Bridge port ${bridgeBasePort} busy; selected ${freePort} for this session.`);
        }
      } catch (allocErr) {
        console.error(`[SERVER] Bridge port auto-allocation failed (${allocErr instanceof Error ? allocErr.message : String(allocErr)}); using base ${bridgeBasePort}.`);
      }

      // Bind the bridge to this session's project (path-gating) so a stray
      // editor that fell back to the default port can't hijack it.
      this.primaryProjectPath = this.detectPrimaryProjectPath();
      if (this.primaryProjectPath) {
        this.godotBridge.setExpectedProjectPath(this.primaryProjectPath);
      }

      // Start the Godot Editor Bridge (WebSocket server for editor plugin).
      // Bridge startup issues should not take down the stdio MCP server.
      try {
        await this.startBridgeWithRetry(bridgeHost);
        this.bridgeStartupError = null;
        this.bridgeStartupErrorInfo = null;
        const bridgeStatus = this.godotBridge.getStatus();
        this.allocatedBridgePort = bridgeStatus.port;
        const portOffset = this.allocatedBridgePort - bridgeBasePort;
        this.allocatedRuntimePort = Math.min(65535, resolveDefaultRuntimePort() + portOffset);
        this.allocatedDapRelayPort = Math.min(65535, DEFAULT_DAP_RELAY_PORT + portOffset);
        const selfTest = bridgeStatus.bridgeSelfTest;
        const selfTestNote = selfTest === null
          ? ''
          : ` (self-test ${selfTest.pass ? `OK in ${selfTest.durationMs}ms` : `FAILED: ${selfTest.error ?? 'unknown'}`})`;
        console.error(`[SERVER] Godot Editor Bridge started on ${bridgeStatus.host}:${bridgeStatus.port} (runtime ${this.allocatedRuntimePort}, dap-relay ${this.allocatedDapRelayPort})${selfTestNote}`);
        // Now that ports are final, publish the discovery file for the project
        // (if known) so a manually-opened editor connects to the right ports.
        if (this.primaryProjectPath) {
          this.writeDiscoveryFile(this.primaryProjectPath);
        }
      } catch (bridgeError) {
        const bridgeMessage = bridgeError instanceof Error ? bridgeError.message : String(bridgeError);
        this.bridgeStartupError = bridgeMessage;
        if (bridgeError instanceof BridgeStartupError) {
          this.bridgeStartupErrorInfo = bridgeError.info;
        } else {
          this.bridgeStartupErrorInfo = null;
        }
        console.error(`[SERVER] Warning: Godot Editor Bridge failed to start: ${bridgeMessage}`);
        console.error('[SERVER] Continuing without bridge-backed editor tools.');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }

  // ============================================
  // 2D Tile Tools Handlers
  // ============================================

  /**
   * Handle the create_tileset tool
   * Creates a TileSet resource with atlas sources
   */
  private async handleCreateTileset(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.tilesetPath || !args.sources) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, tilesetPath, and sources array']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.tilesetPath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    if (!Array.isArray(args.sources) || args.sources.length === 0) {
      return this.createErrorResponse(
        'Sources must be a non-empty array',
        ['Provide at least one source with texture and tileSize']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      // Verify all texture files exist
      for (const source of args.sources) {
        if (!source.texture || !source.tileSize) {
          return this.createErrorResponse(
            'Each source must have texture and tileSize',
            ['Provide texture path and tileSize { x, y } for each source']
          );
        }
        const texturePath = join(args.projectPath, source.texture);
        if (!existsSync(texturePath)) {
          return this.createErrorResponse(
            `Texture file does not exist: ${source.texture}`,
            ['Ensure the texture path is correct']
          );
        }
      }

      const params: any = {
        tilesetPath: args.tilesetPath,
        sources: args.sources,
      };

      const { stdout, stderr } = await this.executeOperation('create_tileset', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to create tileset: ${stderr}`,
          ['Verify all texture paths are correct', 'Check tile size values']
        );
      }

      return {
        content: [{ type: 'text', text: `TileSet created successfully at: ${args.tilesetPath}\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create tileset: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  /**
   * Handle the set_tilemap_cells tool
   * Sets cells in a TileMap node within a scene
   */
  private async handleSetTilemapCells(args: any) {
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.tilemapNodePath || !args.cells) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, tilemapNodePath, and cells array']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    if (!Array.isArray(args.cells)) {
      return this.createErrorResponse(
        'Cells must be an array',
        ['Provide an array of cell objects with coords, sourceId, and atlasCoords']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          ['Ensure the path points to a directory containing a project.godot file']
        );
      }

      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          ['Ensure the scene path is correct', 'Use create_scene to create a new scene first']
        );
      }

      // Validate cell structure
      for (const cell of args.cells) {
        if (!cell.coords || cell.sourceId === undefined || !cell.atlasCoords) {
          return this.createErrorResponse(
            'Each cell must have coords, sourceId, and atlasCoords',
            ['Provide coords { x, y }, sourceId (number), and atlasCoords { x, y } for each cell']
          );
        }
      }

      const params: any = {
        scenePath: args.scenePath,
        tilemapNodePath: args.tilemapNodePath,
        layer: args.layer !== undefined ? args.layer : 0,
        cells: args.cells,
      };

      const { stdout, stderr } = await this.executeOperation('set_tilemap_cells', params, args.projectPath);

      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(
          `Failed to set tilemap cells: ${stderr}`,
          ['Verify the TileMap node path is correct', 'Check that the TileMap has a valid TileSet']
        );
      }

      return {
        content: [{ type: 'text', text: `TileMap cells set successfully (${args.cells.length} cells).\n\n${stdout.trim()}` }],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set tilemap cells: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed correctly', 'Verify the project path is accessible']
      );
    }
  }

  // ============================================
  // Audio System Handlers
  // ============================================

  private async handleCreateAudioBus(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.busName) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and busName']);
    }
    try {
      const params = {
        busName: args.busName,
        parentBusIndex: args.parentBusIndex || 0,
      };
      const { stdout, stderr } = await this.executeOperation('create_audio_bus', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to create audio bus: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `Audio bus '${args.busName}' created successfully.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to create audio bus: ${error?.message}`, []);
    }
  }

  private async handleGetAudioBuses(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', []);
    }
    try {
      const { stdout, stderr } = await this.executeOperation('get_audio_buses', {}, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to get audio buses: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: stdout.trim() }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to get audio buses: ${error?.message}`, []);
    }
  }

  private async handleSetAudioBusEffect(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || args.busIndex === undefined || args.effectIndex === undefined || !args.effectType) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, busIndex, effectIndex, and effectType']);
    }
    try {
      const params = {
        busIndex: args.busIndex,
        effectIndex: args.effectIndex,
        effectType: args.effectType,
        enabled: args.enabled !== false,
      };
      const { stdout, stderr } = await this.executeOperation('set_audio_bus_effect', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set audio bus effect: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `Audio bus effect set successfully.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to set audio bus effect: ${error?.message}`, []);
    }
  }

  private async handleSetAudioBusVolume(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || args.busIndex === undefined || args.volumeDb === undefined) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, busIndex, and volumeDb']);
    }
    try {
      const params = { busIndex: args.busIndex, volumeDb: args.volumeDb };
      const { stdout, stderr } = await this.executeOperation('set_audio_bus_volume', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set audio bus volume: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `Audio bus volume set to ${args.volumeDb}dB.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to set audio bus volume: ${error?.message}`, []);
    }
  }

  // ============================================
  // Networking Handlers
  // ============================================

  // ============================================
  // Physics Handlers
  // ============================================

  // ============================================
  // Navigation Handlers
  // ============================================

  private async handleCreateNavigationRegion(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.scenePath || !args.parentPath || !args.nodeName) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, parentPath, and nodeName']);
    }
    try {
      const params = {
        scenePath: args.scenePath,
        parentPath: args.parentPath,
        nodeName: args.nodeName,
        is3D: args.is3D || false,
      };
      const { stdout, stderr } = await this.executeOperation('create_navigation_region', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to create navigation region: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `NavigationRegion '${args.nodeName}' created successfully.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to create navigation region: ${error?.message}`, []);
    }
  }

  private async handleCreateNavigationAgent(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.scenePath || !args.parentPath || !args.nodeName) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, parentPath, and nodeName']);
    }
    try {
      const params = {
        scenePath: args.scenePath,
        parentPath: args.parentPath,
        nodeName: args.nodeName,
        is3D: args.is3D || false,
        pathDesiredDistance: args.pathDesiredDistance || 4.0,
        targetDesiredDistance: args.targetDesiredDistance || 4.0,
      };
      const { stdout, stderr } = await this.executeOperation('create_navigation_agent', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to create navigation agent: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `NavigationAgent '${args.nodeName}' created successfully.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to create navigation agent: ${error?.message}`, []);
    }
  }

  // ============================================
  // Rendering Handlers
  // ============================================

  // ============================================
  // Animation Tree Handlers
  // ============================================

  private async handleCreateAnimationTree(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.scenePath || !args.parentPath || !args.nodeName || !args.animPlayerPath) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, parentPath, nodeName, and animPlayerPath']);
    }
    try {
      const params = {
        scenePath: args.scenePath,
        parentPath: args.parentPath,
        nodeName: args.nodeName,
        animPlayerPath: args.animPlayerPath,
        rootType: args.rootType || 'StateMachine',
      };
      const { stdout, stderr } = await this.executeOperation('create_animation_tree', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to create AnimationTree: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `AnimationTree '${args.nodeName}' created successfully.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to create AnimationTree: ${error?.message}`, []);
    }
  }

  private async handleAddAnimationState(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.scenePath || !args.animTreePath || !args.stateName || !args.animationName) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, animTreePath, stateName, and animationName']);
    }
    try {
      const params = {
        scenePath: args.scenePath,
        animTreePath: args.animTreePath,
        stateName: args.stateName,
        animationName: args.animationName,
        stateMachinePath: args.stateMachinePath || '',
      };
      const { stdout, stderr } = await this.executeOperation('add_animation_state', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to add animation state: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `Animation state '${args.stateName}' added successfully.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to add animation state: ${error?.message}`, []);
    }
  }

  private async handleConnectAnimationStates(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.scenePath || !args.animTreePath || !args.fromState || !args.toState) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, scenePath, animTreePath, fromState, and toState']);
    }
    try {
      const params = {
        scenePath: args.scenePath,
        animTreePath: args.animTreePath,
        fromState: args.fromState,
        toState: args.toState,
        transitionType: args.transitionType || 'immediate',
        advanceCondition: args.advanceCondition || '',
      };
      const { stdout, stderr } = await this.executeOperation('connect_animation_states', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to connect animation states: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `States '${args.fromState}' -> '${args.toState}' connected.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to connect animation states: ${error?.message}`, []);
    }
  }

  // ============================================
  // UI/Theme Handlers
  // ============================================

  private async handleSetThemeColor(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.themePath || !args.controlType || !args.colorName || !args.color) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, themePath, controlType, colorName, and color']);
    }
    try {
      const params = {
        themePath: args.themePath,
        controlType: args.controlType,
        colorName: args.colorName,
        color: args.color,
      };
      const { stdout, stderr } = await this.executeOperation('set_theme_color', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set theme color: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `Theme color '${args.colorName}' for '${args.controlType}' set.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to set theme color: ${error?.message}`, []);
    }
  }

  private async handleSetThemeFontSize(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.themePath || !args.controlType || !args.fontSizeName || !args.size) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, themePath, controlType, fontSizeName, and size']);
    }
    try {
      const params = {
        themePath: args.themePath,
        controlType: args.controlType,
        fontSizeName: args.fontSizeName,
        size: args.size,
      };
      const { stdout, stderr } = await this.executeOperation('set_theme_font_size', params, args.projectPath);
      if (stderr && stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set theme font size: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `Theme font size '${args.fontSizeName}' for '${args.controlType}' set to ${args.size}px.\n\n${stdout.trim()}` }] };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to set theme font size: ${error?.message}`, []);
    }
  }


  private async handleApplyThemeShader(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.theme) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, scenePath, nodePath, and theme',
      ]);
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, []);
      }

      const shaderTemplates: Record<string, { code: string; description: string }> = {
        medieval: {
          description: 'Warm stone/aged material look',
          code: `shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap;
uniform float roughness : hint_range(0.0, 1.0) = 0.85;
uniform float age_factor : hint_range(0.0, 1.0) = 0.3;
uniform vec3 tint_color : source_color = vec3(0.9, 0.85, 0.75);

void fragment() {
    vec4 albedo = texture(albedo_texture, UV);
    vec3 aged = mix(albedo.rgb, albedo.rgb * tint_color, age_factor);
    ALBEDO = aged;
    ROUGHNESS = roughness;
    SPECULAR = 0.2;
    METALLIC = 0.0;
}`,
        },
        cyberpunk: {
          description: 'Neon glow with pulsing effect',
          code: `shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back;

uniform vec3 neon_color : source_color = vec3(1.0, 0.0, 0.8);
uniform float pulse_speed : hint_range(0.0, 10.0) = 2.0;
uniform float intensity : hint_range(0.0, 5.0) = 2.5;
uniform float base_brightness : hint_range(0.0, 1.0) = 0.3;

void fragment() {
    float pulse = sin(TIME * pulse_speed) * 0.5 + 0.5;
    vec3 emissive = neon_color * intensity * (0.5 + pulse * 0.5);
    
    ALBEDO = neon_color * base_brightness;
    EMISSION = emissive;
    METALLIC = 0.8;
    ROUGHNESS = 0.2;
}`,
        },
        nature: {
          description: 'Wind sway for foliage',
          code: `shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_disabled;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap;
uniform float wind_strength : hint_range(0.0, 2.0) = 0.3;
uniform float wind_speed : hint_range(0.0, 5.0) = 1.5;
uniform float wind_scale : hint_range(0.1, 10.0) = 1.0;

void vertex() {
    float wind = sin(TIME * wind_speed + VERTEX.x * wind_scale + VERTEX.z * wind_scale * 0.7);
    float height_factor = UV.y;
    VERTEX.x += wind * wind_strength * height_factor;
    VERTEX.z += wind * wind_strength * height_factor * 0.5;
}

void fragment() {
    vec4 albedo = texture(albedo_texture, UV);
    ALBEDO = albedo.rgb;
    ALPHA = albedo.a;
    ALPHA_SCISSOR_THRESHOLD = 0.5;
    ROUGHNESS = 0.8;
}`,
        },
        scifi: {
          description: 'Clean metallic with LED accents',
          code: `shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap;
uniform vec3 led_color : source_color = vec3(0.0, 0.8, 1.0);
uniform float led_intensity : hint_range(0.0, 3.0) = 1.5;
uniform float metallic_value : hint_range(0.0, 1.0) = 0.9;

void fragment() {
    vec4 albedo = texture(albedo_texture, UV);
    float led_mask = step(0.9, albedo.r) * step(0.9, albedo.g) * step(0.9, albedo.b);
    
    ALBEDO = mix(albedo.rgb, albedo.rgb * 0.3, led_mask);
    EMISSION = led_color * led_intensity * led_mask;
    METALLIC = metallic_value;
    ROUGHNESS = mix(0.3, 0.1, led_mask);
}`,
        },
        horror: {
          description: 'Dark with subtle pulsing shadows',
          code: `shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap;
uniform float darkness : hint_range(0.0, 1.0) = 0.6;
uniform float pulse_speed : hint_range(0.0, 5.0) = 0.5;
uniform vec3 shadow_tint : source_color = vec3(0.1, 0.0, 0.15);

void fragment() {
    float pulse = sin(TIME * pulse_speed) * 0.1 + 0.9;
    vec4 albedo = texture(albedo_texture, UV);
    vec3 darkened = mix(albedo.rgb, shadow_tint, darkness);
    
    ALBEDO = darkened * pulse;
    ROUGHNESS = 0.9;
    METALLIC = 0.0;
}`,
        },
        cartoon: {
          description: 'Cel-shaded toon look',
          code: `shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap;
uniform vec3 outline_color : source_color = vec3(0.0, 0.0, 0.0);
uniform float shade_levels : hint_range(2.0, 8.0) = 3.0;

void fragment() {
    vec4 albedo = texture(albedo_texture, UV);
    ALBEDO = albedo.rgb;
    ROUGHNESS = 1.0;
    SPECULAR = 0.0;
}

void light() {
    float NdotL = dot(NORMAL, LIGHT);
    float stepped = floor(NdotL * shade_levels) / shade_levels;
    DIFFUSE_LIGHT += stepped * ATTENUATION * LIGHT_COLOR;
}`,
        },
      };

      const effectTemplates: Record<string, string> = {
        glow: `
uniform float glow_power : hint_range(0.0, 5.0) = 1.5;
// Add to fragment(): EMISSION += ALBEDO * glow_power;`,
        hologram: `
uniform float scan_speed : hint_range(0.0, 10.0) = 2.0;
uniform float scan_lines : hint_range(10.0, 100.0) = 50.0;
// Add to fragment(): 
// float scan = sin(UV.y * scan_lines + TIME * scan_speed) * 0.5 + 0.5;
// ALPHA = 0.7 * scan;`,
        dissolve: `
uniform sampler2D noise_texture : filter_linear;
uniform float dissolve_amount : hint_range(0.0, 1.0) = 0.0;
// Add to fragment():
// float noise = texture(noise_texture, UV).r;
// if (noise < dissolve_amount) discard;`,
      };

      const theme = args.theme as string;
      const effect = args.effect || 'none';
      
      if (!shaderTemplates[theme]) {
        return this.createErrorResponse(`Unknown theme: ${theme}`, [
          `Available themes: ${Object.keys(shaderTemplates).join(', ')}`,
        ]);
      }

      const template = shaderTemplates[theme];
      let shaderCode = template.code;
      
      if (effect !== 'none' && effectTemplates[effect]) {
        shaderCode += `\n// Effect: ${effect}\n${effectTemplates[effect]}`;
      }

      if (args.shaderParams) {
        try {
          const customParams = JSON.parse(args.shaderParams);
          for (const [key, value] of Object.entries(customParams)) {
            const regex = new RegExp(`(uniform[^;]*${key}[^=]*=\\s*)([^;]+)`, 'g');
            shaderCode = shaderCode.replace(regex, `$1${value}`);
          }
        } catch (e) {
          this.logDebug(`Failed to parse custom shader params: ${e}`);
        }
      }

      const shaderDir = join(args.projectPath, 'shaders');
      if (!existsSync(shaderDir)) {
        mkdirSync(shaderDir, { recursive: true });
      }

      const shaderFileName = `theme_${theme}${effect !== 'none' ? '_' + effect : ''}.gdshader`;
      const shaderPath = join(shaderDir, shaderFileName);
      
      const fs = await import('fs');
      fs.writeFileSync(shaderPath, shaderCode);

      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        shaderPath: `shaders/${shaderFileName}`,
      };

      const { stdout, stderr } = await this.executeOperation('apply_shader_to_node', params, args.projectPath);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            theme,
            effect,
            description: template.description,
            shaderPath: `res://shaders/${shaderFileName}`,
            appliedTo: args.nodePath,
            output: stdout.trim(),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to apply theme shader: ${error?.message}`, [
        'Ensure the node path is valid',
        'Check that the scene exists',
      ]);
    }
  }

  private async handleSearchAssets(args: any) {
    args = this.normalizeParameters(args);
    if (!args.keyword) {
      return this.createErrorResponse('Missing required parameter: keyword', []);
    }

    try {
      const { assetManager } = await import('./providers/index.js');
      
      const searchOptions = {
        keyword: args.keyword,
        assetType: args.assetType,
        maxResults: args.maxResults || 10,
      };

      let results: any[];
      const providerFilter = args.provider || 'all';
      const mode = args.mode || 'parallel';

      if (providerFilter !== 'all') {
        results = await assetManager.searchProvider(providerFilter, searchOptions);
      } else if (mode === 'sequential') {
        results = await assetManager.searchSequential(searchOptions);
      } else {
        results = await assetManager.searchAll(searchOptions);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            query: args.keyword,
            mode,
            provider: providerFilter,
            totalResults: results.length,
            results: results.map(r => ({
              id: r.id,
              name: r.name,
              provider: r.provider,
              assetType: r.assetType,
              categories: r.categories,
              tags: r.tags.slice(0, 5),
              license: r.license,
              previewUrl: r.previewUrl,
              downloadCommand: `fetch_asset(projectPath, assetId="${r.id}", provider="${r.provider}")`,
            })),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to search assets: ${error?.message}`, [
        'Check internet connection',
        'Try a different keyword',
      ]);
    }
  }

  private async handleFetchAsset(args: any) {
    args = this.normalizeParameters(args);
    if (!args.projectPath || !args.assetId || !args.provider) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, assetId, and provider',
      ]);
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid path', ['Provide a valid project path']);
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path contains a project.godot file',
        ]);
      }

      const { assetManager } = await import('./providers/index.js');

      const result = await assetManager.download({
        assetId: args.assetId,
        projectPath: args.projectPath,
        provider: args.provider,
        resolution: args.resolution || '2k',
        targetFolder: args.targetFolder,
      });

      if (result.success) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              asset: {
                id: result.assetId,
                provider: result.provider,
              },
              downloadedTo: `res://${result.localPath}`,
              license: result.license,
              attribution: result.attribution,
              sourceUrl: result.sourceUrl,
            }, null, 2),
          }],
        };
      } else {
        return this.createErrorResponse(`Failed to download asset: ${args.assetId}`, [
          'Check that the asset ID is correct',
          'Verify the provider name',
          'Try a different asset',
        ]);
      }
    } catch (error: any) {
      return this.createErrorResponse(`Failed to fetch asset: ${error?.message}`, [
        'Check internet connection',
        'Verify the asset ID and provider',
      ]);
    }
  }

  private async handleListAssetProviders() {
    try {
      const { assetManager } = await import('./providers/index.js');
      const providers = assetManager.getProviderInfo();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            providers: providers.map(p => ({
              name: p.name,
              displayName: p.displayName,
              priority: p.priority,
              supportedTypes: p.types,
              license: 'CC0',
              requiresAuth: false,
            })),
            usage: {
              search: 'search_assets(keyword="chair", assetType="models")',
              download: 'fetch_asset(projectPath, assetId="asset_id", provider="polyhaven")',
            },
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to list providers: ${error?.message}`, []);
    }
  }

  /**
   * Handle the query_classes tool — ClassDB introspection
   */
  private async handleQueryClasses(args: any) {
    const projectPath = args?.projectPath || args?.project_path;
    if (!projectPath) {
      throw new McpError(ErrorCode.InvalidParams, 'projectPath is required');
    }
    const params: Record<string, any> = {};
    if (args?.filter) params.filter = args.filter;
    if (args?.category) params.category = args.category;
    if (args?.instantiableOnly !== undefined) params.instantiable_only = args.instantiableOnly;
    if (args?.instantiable_only !== undefined) params.instantiable_only = args.instantiable_only;

    const { stdout, stderr } = await this.executeOperation('query_classes', params, projectPath);
    if (stderr && stderr.trim()) {
      return this.createErrorResponse(`Failed to query classes: ${stderr.trim()}`, [
        'Check the project path and ensure project.godot exists',
        'Verify the category/filter arguments are valid',
      ]);
    }

    return {
      content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
    };
  }

  /**
   * Handle the query_class_info tool — ClassDB introspection
   */
  private async handleQueryClassInfo(args: any) {
    const projectPath = args?.projectPath || args?.project_path;
    const className = args?.className || args?.class_name;
    if (!projectPath) {
      throw new McpError(ErrorCode.InvalidParams, 'projectPath is required');
    }
    if (!className) {
      throw new McpError(ErrorCode.InvalidParams, 'className is required');
    }
    const params: Record<string, any> = {
      class_name: className,
    };
    if (args?.includeInherited !== undefined) params.include_inherited = args.includeInherited;
    if (args?.include_inherited !== undefined) params.include_inherited = args.include_inherited;

    const { stdout, stderr } = await this.executeOperation('query_class_info', params, projectPath);
    if (stderr && stderr.trim()) {
      return this.createErrorResponse(`Failed to query class info: ${stderr.trim()}`, [
        'Check that the class name exists in the current Godot version',
        'Verify the project path and ClassDB availability',
      ]);
    }

    return {
      content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
    };
  }

  /**
   * Handle the inspect_inheritance tool — ClassDB introspection
   */
  private async handleInspectInheritance(args: any) {
    const projectPath = args?.projectPath || args?.project_path;
    const className = args?.className || args?.class_name;
    if (!projectPath) {
      throw new McpError(ErrorCode.InvalidParams, 'projectPath is required');
    }
    if (!className) {
      throw new McpError(ErrorCode.InvalidParams, 'className is required');
    }
    const { stdout, stderr } = await this.executeOperation('inspect_inheritance', {
      class_name: className,
    }, projectPath);
    if (stderr && stderr.trim()) {
      return this.createErrorResponse(`Failed to inspect inheritance: ${stderr.trim()}`, [
        'Check that the class name exists in the current Godot version',
      ]);
    }
    return {
      content: [{ type: 'text', text: this.extractLastJsonLine(stdout) || stdout.trim() }],
    };
  }

  /**
   * Handle the modify_resource tool
   */
  private async handleModifyResource(args: any) {
    const projectPath = args?.projectPath || args?.project_path;
    const resourcePath = args?.resourcePath || args?.resource_path;
    if (!projectPath) {
      throw new McpError(ErrorCode.InvalidParams, 'projectPath is required');
    }
    if (!resourcePath) {
      throw new McpError(ErrorCode.InvalidParams, 'resourcePath is required');
    }
    const params: Record<string, any> = {
      resource_path: resourcePath,
    };
    if (args?.properties) {
      params.properties = typeof args.properties === 'string' ? JSON.parse(args.properties) : args.properties;
    }
    return await this.executeOperation('modify_resource', params, projectPath);
  }

  private async handleMapProject(args: any) {
    const projectPath = args?.projectPath || args?.project_path;
    if (!projectPath) {
      throw new McpError(ErrorCode.InvalidParams, 'projectPath is required');
    }
    const root = (args?.root as string) || 'res://';
    const includeAddons = (args?.include_addons as boolean) || false;

    const result = mapProject(projectPath, root, includeAddons);
    if (!result.ok || !result.project_map) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: result.error || 'Failed to map project' }) }],
        isError: true,
      };
    }

    setProjectPath(projectPath);
    try {
      const url = await serveVisualization(result.project_map, this.godotBridge);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          url,
          total_scripts: result.project_map.total_scripts,
          total_connections: result.project_map.total_connections,
          message: `Interactive project map opened at ${url} — ${result.project_map.total_scripts} scripts, ${result.project_map.total_connections} connections`,
        }, null, 2) }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Failed to start visualizer: ${errMsg}`, project_map: result.project_map }) }],
      };
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
