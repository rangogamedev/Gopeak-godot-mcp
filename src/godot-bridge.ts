import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createConnection as createNetConnection } from 'node:net';
import { release, tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { execSync } from 'node:child_process';
import type { RawData } from 'ws';
import { WebSocket, WebSocketServer } from 'ws';
import { normalizePathForCrossPlatformComparison } from './wsl_interop.js';

const DEFAULT_PORT = 6505;
const DEFAULT_HOST = process.platform === 'linux' && release().toLowerCase().includes('microsoft') ? '0.0.0.0' : '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 10_000;
// Evict a Godot socket after this many consecutive keepalive intervals with no
// pong. At the default 10s interval that's ~30s of silence. The counter is only
// advanced while no tool is in flight (see startKeepalive), so a long
// synchronous editor tool that blocks Godot's main thread can't trip it.
const PONG_MISS_LIMIT = 3;
// WebSocket close code used when a connecting editor's project_path does not
// match the project this bridge instance is bound to (multi-session isolation).
// 4001 is in the application-private range (4000-4999); 4000 was the legacy
// "already connected" reject code, retired by last-writer-wins takeover.
const PROJECT_MISMATCH_CLOSE_CODE = 4001;
// A probationary (gated) socket that never sends godot_ready is closed after
// this long so its listeners can't accumulate (e.g. port scans, mis-wired
// clients). The real editor sends godot_ready immediately on open.
const PROBATION_TIMEOUT_MS = 15_000;
const BRIDGE_PORT_ENV_KEYS = ['GODOT_BRIDGE_PORT', 'MCP_BRIDGE_PORT', 'GOPEAK_BRIDGE_PORT'] as const;
const BRIDGE_HOST_ENV_KEYS = ['GODOT_BRIDGE_HOST', 'MCP_BRIDGE_HOST', 'GOPEAK_BRIDGE_HOST'] as const;
const BRIDGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function resolveDefaultBridgePort(): number {
  for (const key of BRIDGE_PORT_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw || raw.trim().length === 0) {
      continue;
    }

    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }

    console.error(`[GodotBridge] Ignoring invalid ${key}="${raw}". Expected an integer between 1 and 65535.`);
  }

  return DEFAULT_PORT;
}

function resolveDefaultBridgeHost(): string {
  for (const key of BRIDGE_HOST_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw) {
      continue;
    }

    const host = raw.trim();
    if (host.length > 0) {
      return host;
    }
  }

  return DEFAULT_HOST;
}

// ============================================
// Bridge reliability helpers (orphan reclaim, PID lockfile, self-test, port-holder lookup)
// See plan: docs/plans/2026-05-20-mcp-bridge-reliability.md and feedback memory
// feedback_mcp_bridge_reliability — the bridge must work every session.
// ============================================

export interface BridgePidLockData {
  pid: number;
  ppid: number;
  startedAt: string;
  port: number;
  host: string;
  version: string;
}

export interface BridgeSelfTest {
  pass: boolean;
  durationMs: number;
  error?: string;
}

export interface BridgeStartupErrorInfo {
  code: 'EADDRINUSE' | 'SELF_TEST_FAILED' | 'OTHER';
  message: string;
  holderPid: number | null;
  holderCommand: string | null;
  reclaimedPids: number[];
}

export class BridgeStartupError extends Error {
  public readonly info: BridgeStartupErrorInfo;
  constructor(info: BridgeStartupErrorInfo) {
    super(info.message);
    this.name = 'BridgeStartupError';
    this.info = info;
  }
}

function bridgePidFilePath(port: number): string {
  return joinPath(tmpdir(), `gopeak-bridge-${port}.pid`);
}

function readBridgePidFile(port: number): BridgePidLockData | null {
  const file = bridgePidFilePath(port);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const raw = readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Partial<BridgePidLockData>;
    if (typeof data.pid !== 'number' || typeof data.ppid !== 'number' || typeof data.port !== 'number') {
      return null;
    }
    return data as BridgePidLockData;
  } catch {
    return null;
  }
}

function writeBridgePidFile(port: number, data: BridgePidLockData): void {
  try {
    writeFileSync(bridgePidFilePath(port), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[GodotBridge] Failed to write PID lockfile: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function tryUnlinkBridgePidFile(port: number, ownerPid: number): void {
  const file = bridgePidFilePath(port);
  try {
    if (!existsSync(file)) {
      return;
    }
    const data = readBridgePidFile(port);
    if (data && data.pid !== ownerPid) {
      // Don't remove another instance's lockfile.
      return;
    }
    unlinkSync(file);
  } catch {
    // best-effort cleanup
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPpidFromProc(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^PPid:\s+(\d+)/m);
    if (!match) {
      return null;
    }
    return Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

function readCmdlineFromProc(pid: number): string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const parts = raw.toString('utf8').split('\0').filter((s) => s.length > 0);
    return parts.length > 0 ? parts : null;
  } catch {
    return null;
  }
}

function isGopeakProcess(cmdline: string[] | null): boolean {
  if (!cmdline || cmdline.length === 0) {
    return false;
  }
  return cmdline.some((arg) => arg.endsWith('build/index.js') || arg.endsWith('/gopeak') || arg.endsWith('godot-mcp'));
}

function readCommFromProc(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Scan /proc for sibling gopeak node processes whose parent (PPid) is dead
 * or PID 1 (orphan adopted by init). Returns candidates safe to reclaim.
 * On non-Linux platforms returns []. Skips the current process.
 *
 * Optimized two-pass scan: filter by /proc/PID/comm (1-byte read, just the
 * process name) before paying the cost of /proc/PID/cmdline + /proc/PID/status.
 * On busy systems with 500+ PIDs, this drops scan time from ~2s to ~50ms.
 */
function findOrphanGopeakPids(): Array<{ pid: number; ppid: number; cmdline: string[] }> {
  if (process.platform !== 'linux') {
    return [];
  }
  const selfPid = process.pid;
  const orphans: Array<{ pid: number; ppid: number; cmdline: string[] }> = [];

  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    if (pid === selfPid) {
      continue;
    }
    // Fast filter: only consider node processes (comm == "node").
    // Skips ~99% of /proc entries with a single small file read.
    const comm = readCommFromProc(pid);
    if (comm !== 'node') {
      continue;
    }
    const cmdline = readCmdlineFromProc(pid);
    if (!isGopeakProcess(cmdline)) {
      continue;
    }
    const ppid = readPpidFromProc(pid);
    if (ppid === null) {
      continue;
    }
    // Orphan if ppid is 1 (init) or the parent process is gone.
    if (ppid === 1 || !isProcessAlive(ppid)) {
      orphans.push({ pid, ppid, cmdline: cmdline! });
    }
  }
  return orphans;
}

/**
 * Poll the OS until the given host:port is bindable. Used after reclaiming
 * a process holding the port to close the narrow window where the process
 * is gone but the kernel still has the socket in close-wait / TIME_WAIT.
 * Resolves true when the port is free, false when the timeout elapses.
 */
async function waitForPortFree(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isFree = await new Promise<boolean>((resolve) => {
      const socket = createNetConnection({ host: probeHost, port }, () => {
        // Connection succeeded means SOMETHING is listening — port not free.
        socket.destroy();
        resolve(false);
      });
      socket.once('error', (err) => {
        socket.destroy();
        // ECONNREFUSED = nothing listening = port free.
        resolve((err as NodeJS.ErrnoException).code === 'ECONNREFUSED');
      });
    });
    if (isFree) {
      return true;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

/**
 * Find the first bindable TCP port at or above `base`, probing up to
 * `maxAttempts` consecutive ports. Used for per-session auto-allocation so two
 * gopeak instances (e.g. two git worktrees) don't fight over the default port.
 *
 * Each candidate is verified with an actual `server.listen()` (the only
 * race-free "is it free" check in Node) and released immediately. There is a
 * sub-millisecond window between release and the caller's real bind where a
 * sibling could grab the same port — callers that bind must still handle
 * EADDRINUSE and retry with `base = chosen + 1`.
 *
 * `0.0.0.0`/`::` are probed on `127.0.0.1` (a successful loopback bind implies
 * the wildcard bind will also succeed), mirroring `waitForPortFree`.
 */
export async function findFreePortFrom(base: number, host: string, maxAttempts = 20): Promise<number> {
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = base + offset;
    if (candidate > 65535) {
      break;
    }
    const free = await new Promise<boolean>((resolve) => {
      const probe = http.createServer();
      probe.once('error', () => {
        resolve(false);
      });
      probe.listen(candidate, probeHost, () => {
        probe.close(() => resolve(true));
      });
    });
    if (free) {
      return candidate;
    }
  }
  throw new Error(`No free port found in range ${base}-${base + maxAttempts - 1} on ${host}`);
}

/**
 * Send SIGTERM, wait up to `timeoutMs` for the process to exit, then SIGKILL.
 * Resolves to true if the process is gone by the end, false otherwise.
 */
async function reclaimProcess(pid: number, timeoutMs = 2000): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }

  const pollIntervalMs = 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }

  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }
  return !isProcessAlive(pid);
}

/**
 * Identify the process holding a TCP listen port. Tries `lsof` first, falls
 * back to `ss`. Returns null fields if neither tool is available or both fail.
 */
function findPortHolder(port: number): { pid: number | null; command: string | null } {
  // lsof -nP -iTCP:PORT -sTCP:LISTEN -F pc (-F pc selects PID + command;
  // dropped L (login) since we don't parse it)
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -F pc`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 500,
    });
    let pid: number | null = null;
    let command: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) {
        const parsed = Number.parseInt(line.slice(1), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          pid = parsed;
        }
      } else if (line.startsWith('c')) {
        command = line.slice(1).trim() || null;
      }
    }
    if (pid !== null) {
      return { pid, command };
    }
  } catch {
    // lsof not present or no match — fall through
  }

  // ss -tlnp '( sport = :PORT )'
  try {
    const out = execSync(`ss -tlnp '( sport = :${port} )'`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 500,
    });
    // ss output ex: users:(("node",pid=12345,fd=20))
    const pidMatch = out.match(/pid=(\d+)/);
    const cmdMatch = out.match(/users:\(\("([^"]+)"/);
    if (pidMatch) {
      return {
        pid: Number.parseInt(pidMatch[1], 10),
        command: cmdMatch ? cmdMatch[1] : null,
      };
    }
  } catch {
    // ss not present or no match
  }

  return { pid: null, command: null };
}

/**
 * Post-bind self-test: open a TCP socket to the bridge host:port and send a
 * HEAD-equivalent probe. Resolves the result regardless of HTTP status —
 * any TCP-level success is treated as bind-reachable. Times out at 500ms.
 */
async function runBridgeSelfTest(host: string, port: number, timeoutMs = 500): Promise<BridgeSelfTest> {
  const started = Date.now();
  return new Promise<BridgeSelfTest>((resolve) => {
    let settled = false;
    const finish = (result: BridgeSelfTest) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const socket = createNetConnection({ host: probeHost, port }, () => {
      try {
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      } catch {
        // swallow — just trying to elicit a response
      }
    });

    const timer = setTimeout(() => {
      socket.destroy();
      finish({ pass: false, durationMs: Date.now() - started, error: `self-test timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    socket.once('data', () => {
      clearTimeout(timer);
      socket.destroy();
      finish({ pass: true, durationMs: Date.now() - started });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      finish({ pass: false, durationMs: Date.now() - started, error: err.message });
    });
    socket.once('close', () => {
      if (!settled) {
        clearTimeout(timer);
        finish({ pass: false, durationMs: Date.now() - started, error: 'socket closed before response' });
      }
    });
  });
}

export interface ToolInvokeMessage {
  type: 'tool_invoke';
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

export interface GodotReadyMessage {
  type: 'godot_ready';
  project_path: string;
}

type IncomingMessage = ToolResultMessage | PongMessage | GodotReadyMessage;
type OutgoingMessage = ToolInvokeMessage | PingMessage;

type BridgeEventMap = {
  tool_start: { tool: string; id: string; args: Record<string, unknown> };
  tool_end: { tool: string; id: string; success: boolean; duration: number };
  godot_connected: { projectPath?: string };
  godot_disconnected: Record<string, never>;
};

interface PendingRequest {
  toolName: string;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  startedAt: number;
  resourceKey?: string;
}

interface GodotConnectionInfo {
  projectPath?: string;
  connectedAt: Date;
  lastPongAt?: Date;
}

interface BridgeStatus {
  host: string;
  port: number;
  connected: boolean;
  projectPath?: string;
  connectedAt?: Date;
  lastPongAt?: Date;
  pendingRequests: number;
  queuedResources: number;
  /**
   * Result of the TCP reachability probe run immediately after the bridge
   * binds. `null` until `start()` resolves. Surfaces WSL/Windows network
   * anomalies that bind cleanly but route nowhere.
   */
  bridgeSelfTest: BridgeSelfTest | null;
  /**
   * Structured info about the holder when the bridge failed to bind with
   * EADDRINUSE. `null` when start succeeded. PIDs of orphans reclaimed at
   * startup (if any) accumulate here so `editor-status` can surface them
   * for one-step diagnosis without `ps`.
   */
  startupErrorInfo: BridgeStartupErrorInfo | null;
}

export class GodotBridge extends EventEmitter {
  private httpServer: http.Server | null = null;
  private godotWss: WebSocketServer | null = null;
  private vizWss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private connectionInfo: GodotConnectionInfo | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private resourceQueues = new Map<string, Promise<void>>();
  private visualizerHtml = this.getDefaultVisualizerHtml();
  private selfTestResult: BridgeSelfTest | null = null;
  private startupErrorInfo: BridgeStartupErrorInfo | null = null;
  private reclaimedPidsAtStartup: number[] = [];
  private pidFileOwned = false;
  // When set, this bridge only accepts a Godot editor whose `godot_ready`
  // project_path matches (multi-session isolation). Null = accept any editor
  // (legacy / single-session behaviour). See setExpectedProjectPath.
  private expectedProjectPath: string | null = null;

  public constructor(
    private readonly port: number = DEFAULT_PORT,
    private readonly host: string = DEFAULT_HOST,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    // Overridable so tests can drive the keepalive/pong-timeout loop fast.
    private readonly keepaliveIntervalMs: number = KEEPALIVE_INTERVAL_MS,
    // Overridable so tests can drive the gated-socket probation timeout fast.
    private readonly probationTimeoutMs: number = PROBATION_TIMEOUT_MS,
  ) {
    super();
    this.registerProcessExitHandlers();
  }

  /**
   * Register cleanup-on-exit handlers for the PID lockfile. Without these,
   * a crashing gopeak would leave a stale lockfile that confuses the next
   * instance's healthy-handoff check.
   */
  private registerProcessExitHandlers(): void {
    const cleanup = () => {
      if (this.pidFileOwned) {
        tryUnlinkBridgePidFile(this.port, process.pid);
        this.pidFileOwned = false;
      }
    };
    process.once('exit', cleanup);
  }

  public async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    // Reset per-start state.
    this.selfTestResult = null;
    this.startupErrorInfo = null;
    this.reclaimedPidsAtStartup = [];

    // ============================================
    // Preflight: PID lockfile + orphan reclamation
    // ============================================
    // The bridge must work every session per feedback_mcp_bridge_reliability.
    // Recurring incidents: orphan gopeaks from prior Claude Code sessions
    // hold :6505 or have left their child Godot editors paired with a dead
    // bridge. Three preflight steps eliminate this class of failure:
    //   (1) If the lockfile names a healthy peer (PID + PPid both alive),
    //       this instance exits cleanly — coexistence is incoherent.
    //   (2) If the lockfile names a process whose parent is dead or PID 1,
    //       reclaim it (SIGTERM → SIGKILL).
    //   (3) Defensive sweep for orphan gopeak siblings anywhere on /proc
    //       even if no lockfile exists (covers older builds that didn't
    //       write one).
    const lock = readBridgePidFile(this.port);
    if (lock && lock.pid !== process.pid && isProcessAlive(lock.pid)) {
      const ppidAlive = lock.ppid > 1 && isProcessAlive(lock.ppid);
      if (ppidAlive) {
        const info: BridgeStartupErrorInfo = {
          code: 'OTHER',
          message: `Another gopeak instance is healthy (PID ${lock.pid}, parent ${lock.ppid}, started ${lock.startedAt}). This MCP server will not bind ${this.host}:${this.port}; use the existing instance.`,
          holderPid: lock.pid,
          holderCommand: 'gopeak',
          reclaimedPids: [],
        };
        this.startupErrorInfo = info;
        throw new BridgeStartupError(info);
      }
      // Orphan: parent dead, gopeak still alive holding the lockfile slot.
      this.log('info', `Reclaiming orphan gopeak from lockfile (PID ${lock.pid}, ppid ${lock.ppid})`);
      const reclaimed = await reclaimProcess(lock.pid, 2000);
      if (reclaimed) {
        this.reclaimedPidsAtStartup.push(lock.pid);
        // Close the narrow race between process exit and the kernel
        // releasing the socket. Node sets SO_REUSEADDR by default on Linux
        // so this is usually a no-op, but on heavily loaded systems the
        // socket can stay in close-wait briefly. Cheap insurance.
        await waitForPortFree(this.host, this.port, 1500);
      }
      tryUnlinkBridgePidFile(this.port, lock.pid);
    } else if (lock) {
      // Stale lockfile (PID dead or self) — clear it.
      tryUnlinkBridgePidFile(this.port, lock.pid);
    }

    // ============================================
    // Bind the HTTP + WebSocket server
    // ============================================
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });
      const godotWss = new WebSocketServer({ noServer: true });
      const vizWss = new WebSocketServer({ noServer: true });
      let settled = false;

      server.on('upgrade', (request, socket, head) => {
        const pathname = this.getRequestPathname(request.url);
        const target = pathname === '/godot' ? godotWss : vizWss;

        target.handleUpgrade(request, socket, head, (ws) => {
          target.emit('connection', ws, request);
        });
      });

      godotWss.on('connection', (socket) => {
        this.handleConnection(socket);
      });

      server.once('listening', () => {
        settled = true;
        this.httpServer = server;
        this.godotWss = godotWss;
        this.vizWss = vizWss;
        this.log('info', `Unified HTTP+WS bridge listening on ${this.host}:${this.port}`);
        resolve();
      });

      server.once('error', (error) => {
        if (!settled) {
          settled = true;
          const errCode = (error as NodeJS.ErrnoException).code;
          if (errCode === 'EADDRINUSE') {
            const holder = findPortHolder(this.port);
            const killHint = holder.pid !== null ? ` Run \`kill ${holder.pid}\` to free the port.` : '';
            const info: BridgeStartupErrorInfo = {
              code: 'EADDRINUSE',
              message: `EADDRINUSE on ${this.host}:${this.port}. Holder PID=${holder.pid ?? 'unknown'} (${holder.command ?? 'unknown process'}).${killHint}`,
              holderPid: holder.pid,
              holderCommand: holder.command,
              reclaimedPids: [...this.reclaimedPidsAtStartup],
            };
            this.startupErrorInfo = info;
            reject(new BridgeStartupError(info));
            return;
          }
          reject(error);
          return;
        }

        this.log('error', `HTTP server error: ${error.message}`);
      });

      godotWss.on('error', (error) => {
        this.log('error', `Godot WebSocket server error: ${error.message}`);
      });

      vizWss.on('error', (error) => {
        this.log('error', `Visualizer WebSocket server error: ${error.message}`);
      });

      server.listen(this.port, this.host);
    });

    // ============================================
    // Post-bind: write PID lockfile + self-test
    // ============================================
    writeBridgePidFile(this.port, {
      pid: process.pid,
      ppid: typeof process.ppid === 'number' ? process.ppid : -1,
      startedAt: new Date().toISOString(),
      port: this.port,
      host: this.host,
      version: BRIDGE_VERSION,
    });
    this.pidFileOwned = true;

    this.selfTestResult = await runBridgeSelfTest(this.host, this.port, 500);
    if (!this.selfTestResult.pass) {
      this.log('warn', `Post-bind self-test failed (${this.selfTestResult.durationMs}ms): ${this.selfTestResult.error ?? 'unknown error'}`);
    } else {
      this.log('info', `Post-bind self-test passed in ${this.selfTestResult.durationMs}ms`);
    }
    if (this.reclaimedPidsAtStartup.length > 0) {
      this.log('info', `Reclaimed ${this.reclaimedPidsAtStartup.length} orphan gopeak PID(s) at startup: ${this.reclaimedPidsAtStartup.join(', ')}`);
    }

    // Defensive sibling sweep — runs in the background AFTER bind so it
    // doesn't block startup latency. Catches stale gopeaks holding ports
    // OTHER than our own (won't affect this instance's port — that's
    // already taken care of by the lockfile preflight). Logs each reclaim
    // for observability; the startup phase is already complete by the time
    // this fires, so reclaimedPidsAtStartup is NOT mutated (that field
    // captures only the synchronous preflight reclaims that affected the
    // bind decision for this port).
    this.runBackgroundOrphanSweep();
  }

  private runBackgroundOrphanSweep(): void {
    setImmediate(async () => {
      try {
        const orphans = findOrphanGopeakPids();
        if (orphans.length === 0) {
          return;
        }
        await Promise.all(orphans.map(async (orphan) => {
          this.log('info', `Background orphan sweep: reclaiming gopeak PID ${orphan.pid} (ppid ${orphan.ppid} dead/init)`);
          const reclaimed = await reclaimProcess(orphan.pid, 2000);
          if (!reclaimed) {
            this.log('warn', `Background orphan sweep: PID ${orphan.pid} survived SIGTERM+SIGKILL`);
          }
        }));
      } catch (err) {
        this.log('warn', `Background orphan sweep error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  public async stop(): Promise<void> {
    this.stopKeepalive();
    this.rejectAllPending(new Error('GodotBridge stopped'));
    this.resourceQueues.clear();
    const closeTasks: Array<Promise<void>> = [];

    if (this.socket) {
      try {
        this.socket.close();
      } catch {
      }
      this.socket = null;
    }

    if (this.godotWss) {
      const godotWss = this.godotWss;
      for (const client of godotWss.clients) {
        try {
          client.close();
        } catch {
        }
      }
      closeTasks.push(this.closeWebSocketServer(godotWss));
      this.godotWss = null;
    }

    if (this.vizWss) {
      const vizWss = this.vizWss;
      for (const client of vizWss.clients) {
        try {
          client.close();
        } catch {
        }
      }
      closeTasks.push(this.closeWebSocketServer(vizWss));
      this.vizWss = null;
    }

    if (this.httpServer) {
      const httpServer = this.httpServer;
      closeTasks.push(this.closeHttpServer(httpServer));
      this.httpServer = null;
    }

    await Promise.all(closeTasks);

    this.connectionInfo = null;
    this.visualizerHtml = this.getDefaultVisualizerHtml();

    if (this.pidFileOwned) {
      tryUnlinkBridgePidFile(this.port, process.pid);
      this.pidFileOwned = false;
    }
    this.selfTestResult = null;
    // Clear startupErrorInfo too so getStatus() between stop() and the next
    // start() doesn't surface a stale EADDRINUSE from a previous attempt.
    this.startupErrorInfo = null;
    this.reclaimedPidsAtStartup = [];

    this.log('info', 'WebSocket bridge stopped');
  }

  public isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Bind this bridge to a specific Godot project (multi-session isolation).
   * Once set, an inbound editor must announce a matching `project_path` in its
   * `godot_ready` handshake before it can take over the active socket; a
   * mismatched editor (e.g. one that fell back to the default port before its
   * discovery file existed) is rejected instead of hijacking this session.
   * Passing `null` restores the legacy accept-any behaviour.
   */
  public setExpectedProjectPath(projectPath: string | null): void {
    this.expectedProjectPath = projectPath && projectPath.trim().length > 0 ? projectPath : null;
  }

  public getExpectedProjectPath(): string | null {
    return this.expectedProjectPath;
  }

  /**
   * Compare an incoming editor project_path against this bridge's expected
   * project, tolerant of WSL↔Windows path-form differences (the editor reports
   * `C:/...` while gopeak holds `/mnt/c/...`) and trailing slashes.
   */
  private projectPathMatches(incoming: string): boolean {
    if (this.expectedProjectPath === null) {
      return true;
    }
    const norm = (p: string) => normalizePathForCrossPlatformComparison(p).replace(/\/+$/, '');
    return norm(incoming) === norm(this.expectedProjectPath);
  }

  public getStatus(): BridgeStatus {
    return {
      host: this.host,
      port: this.port,
      connected: this.isConnected(),
      projectPath: this.connectionInfo?.projectPath,
      connectedAt: this.connectionInfo?.connectedAt,
      lastPongAt: this.connectionInfo?.lastPongAt,
      pendingRequests: this.pendingRequests.size,
      queuedResources: this.resourceQueues.size,
      bridgeSelfTest: this.selfTestResult,
      startupErrorInfo: this.startupErrorInfo,
    };
  }

  public invokeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const resourceKey = this.getResourceKey(args);
    if (!resourceKey) {
      return this.invokeToolDirect(toolName, args);
    }

    return this.enqueueResourceRequest(resourceKey, () => this.invokeToolDirect(toolName, args, resourceKey));
  }

  public getVisualizerWss(): WebSocketServer | null {
    return this.vizWss;
  }

  public broadcastToVisualizer(message: object): void {
    if (!this.vizWss) {
      return;
    }

    const payload = JSON.stringify(message);
    this.vizWss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  public setVisualizerHtml(html: string): void {
    this.visualizerHtml = html;
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && (this.getRequestPathname(req.url) === '/' || this.getRequestPathname(req.url) === '/mcp')) {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { method?: unknown; id?: unknown; params?: { protocolVersion?: unknown } };
          if (parsed.method === 'initialize') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: typeof parsed.id === 'number' || typeof parsed.id === 'string' ? parsed.id : 1,
              result: {
                protocolVersion: typeof parsed.params?.protocolVersion === 'string' ? parsed.params.protocolVersion : '2025-06-18',
                capabilities: {},
                serverInfo: { name: 'gopeak', version: BRIDGE_VERSION },
              },
            }));
            return;
          }

          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Unsupported method' }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const pathname = this.getRequestPathname(req.url);
    if (pathname === '/health') {
      const payload = {
        status: 'ok',
        serverName: 'gopeak',
        version: BRIDGE_VERSION,
        bridge: this.getStatus(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(payload));
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(this.visualizerHtml);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private getRequestPathname(url: string | undefined): string {
    try {
      return new URL(url ?? '/', `http://${this.host}:${this.port}`).pathname;
    } catch {
      return '/';
    }
  }

  private closeWebSocketServer(server: WebSocketServer): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        server.close(() => {
          finish();
        });
      } catch {
        finish();
      }
    });
  }

  private closeHttpServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        server.close(() => {
          finish();
        });
      } catch {
        finish();
      }
    });
  }

  private handleConnection(nextSocket: WebSocket): void {
    // Multi-session isolation: when this bridge is bound to a project, hold the
    // new socket in probation until its godot_ready proves it belongs to this
    // project. This MUST happen before any takeover so a stray editor cannot
    // evict the legitimate one via last-writer-wins. Unset → legacy accept-any.
    if (this.expectedProjectPath !== null) {
      this.handleGatedConnection(nextSocket);
      return;
    }
    this.adoptConnection(nextSocket);
  }

  /**
   * Probationary handshake for an isolated bridge. The connecting editor sends
   * `godot_ready { project_path }` first (mcp_client.gd does this immediately on
   * open). We adopt it only if the project matches; otherwise we close it with
   * PROJECT_MISMATCH_CLOSE_CODE and leave the current socket untouched. If
   * godot_ready never arrives the socket sits idle and is cleaned up on close —
   * the active socket (if any) is never disturbed.
   */
  private handleGatedConnection(nextSocket: WebSocket): void {
    let probationTimer: NodeJS.Timeout | null = null;
    const endProbation = () => {
      if (probationTimer) {
        clearTimeout(probationTimer);
        probationTimer = null;
      }
      nextSocket.off('message', onProbeMessage);
      nextSocket.off('close', onProbeClose);
    };

    const onProbeMessage = (data: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        return;
      }
      const message = parsed as Record<string, unknown>;
      if (message.type !== 'godot_ready' || typeof message.project_path !== 'string') {
        // Editor always sends godot_ready first; ignore anything else during
        // probation rather than guessing.
        return;
      }

      endProbation();

      const projectPath = message.project_path;
      if (this.projectPathMatches(projectPath)) {
        this.log('info', `Accepting Godot connection for matching project: ${projectPath}`);
        // Adopt with the known project path so connectionInfo.projectPath is set
        // and a single godot_connected carries it (no re-dispatch / double emit).
        this.adoptConnection(nextSocket, projectPath);
      } else {
        this.log(
          'warn',
          `Rejecting Godot connection: project '${projectPath}' does not match this session's project '${this.expectedProjectPath}'`,
        );
        try {
          nextSocket.close(PROJECT_MISMATCH_CLOSE_CODE, 'project mismatch');
        } catch {
          // best effort
        }
      }
    };

    const onProbeClose = () => {
      endProbation();
    };

    nextSocket.on('message', onProbeMessage);
    nextSocket.once('close', onProbeClose);
    // Don't let a socket that never identifies itself hold listeners forever.
    probationTimer = setTimeout(() => {
      this.log('warn', 'Closing probationary Godot socket: no godot_ready within probation window');
      endProbation();
      try {
        nextSocket.close(PROJECT_MISMATCH_CLOSE_CODE, 'no godot_ready');
      } catch {
        // best effort
      }
    }, this.probationTimeoutMs);
    probationTimer.unref?.();
  }

  private adoptConnection(nextSocket: WebSocket, knownProjectPath?: string): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      // Last-writer-wins. The editor client is a singleton, so a fresh inbound
      // connection is authoritative — the existing socket is either being
      // replaced after a clean editor reconnect or is a half-open zombie (the
      // relay/editor dropped without a TCP FIN). Previously we rejected the new
      // connection with code 4000, which locked a legitimately reconnecting
      // editor out until the dead TCP eventually timed out (minutes). Tear the
      // old one down and take over. handleDisconnect is passed the OLD socket,
      // so when its late `close` fires the stale-socket guard makes it a no-op.
      this.log('warn', 'Taking over Godot connection from a previous/stale socket (last-writer-wins)');
      const previousSocket = this.socket;
      this.handleDisconnect(previousSocket, new Error('Replaced by a new Godot connection'));
      previousSocket.terminate();
    }

    this.socket = nextSocket;
    this.connectionInfo = {
      connectedAt: new Date(),
      // Seed the pong clock so the first keepalive interval can't false-evict a
      // brand-new connection before it has had a chance to reply.
      lastPongAt: new Date(),
      // On the gated (isolated) path the project is already known from the
      // probationary godot_ready, so seed it and emit godot_connected once with
      // the path. On the legacy path it's undefined until the godot_ready
      // message arrives (handleMessage sets it then).
      projectPath: knownProjectPath,
    };
    this.missedPongs = 0;

    this.startKeepalive();
    this.log('info', knownProjectPath ? `Godot editor connected (project: ${knownProjectPath})` : 'Godot editor connected');
    this.emitBridgeEvent('godot_connected', { projectPath: knownProjectPath });

    nextSocket.on('message', (data) => {
      this.handleRawMessage(data);
    });

    nextSocket.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer.toString();
      this.log('warn', `Godot disconnected (code=${code}, reason=${reason || 'none'})`);
      this.handleDisconnect(nextSocket, new Error('Godot disconnected during request'));
    });

    nextSocket.on('error', (error) => {
      this.log('error', `WebSocket error: ${error.message}`);
      if (nextSocket.readyState === WebSocket.CLOSED || nextSocket.readyState === WebSocket.CLOSING) {
        this.handleDisconnect(nextSocket, error);
      }
    });
  }

  private handleRawMessage(data: RawData): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(data.toString());
    } catch (error) {
      this.log('error', `Invalid JSON from Godot: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (!this.isIncomingMessage(parsed)) {
      this.log('warn', 'Ignoring unknown Godot message payload');
      return;
    }

    this.handleMessage(parsed);
  }

  private handleMessage(message: IncomingMessage): void {
    switch (message.type) {
      case 'tool_result': {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
          this.log('warn', `Received tool_result for unknown id=${message.id}`);
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);
        const duration = Date.now() - pending.startedAt;
        this.log('debug', `Tool ${pending.toolName} finished in ${duration}ms`);
        this.emitBridgeEvent('tool_end', {
          tool: pending.toolName,
          id: message.id,
          success: message.success,
          duration,
        });

        if (message.success) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error ?? `Tool ${pending.toolName} failed`));
        }
        return;
      }

      case 'godot_ready':
        if (this.connectionInfo) {
          this.connectionInfo.projectPath = message.project_path;
          this.log('info', `Godot ready: ${message.project_path}`);
          this.emitBridgeEvent('godot_connected', { projectPath: message.project_path });
        }
        return;

      case 'pong':
        if (this.connectionInfo) {
          this.connectionInfo.lastPongAt = new Date();
        }
        this.missedPongs = 0;
        return;
    }
  }

  private invokeToolDirect(
    toolName: string,
    args: Record<string, unknown>,
    resourceKey?: string,
  ): Promise<unknown> {
    if (!this.isConnected()) {
      return Promise.reject(new Error('Godot is not connected'));
    }

    const requestId = randomUUID();
    const message: ToolInvokeMessage = {
      type: 'tool_invoke',
      id: requestId,
      tool: toolName,
      args,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Tool ${toolName} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, {
        toolName,
        timeout,
        resolve,
        reject,
        startedAt: Date.now(),
        resourceKey,
      });

      this.emitBridgeEvent('tool_start', {
        tool: toolName,
        id: requestId,
        args,
      });

      try {
        this.sendMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  private sendMessage(message: OutgoingMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Godot is not connected');
    }

    this.socket.send(JSON.stringify(message));
  }

  private startKeepalive(): void {
    this.stopKeepalive();

    this.pingInterval = setInterval(() => {
      if (!this.isConnected()) {
        return;
      }

      // Pong-timeout / half-open detection. Only advance the missed-pong
      // counter while NO tool is in flight: a synchronous editor tool blocks
      // Godot's main thread (and therefore its pong replies) for up to the tool
      // timeout, so counting misses during that window would false-evict a
      // healthy-but-busy editor. When the queue is empty, an unanswered socket
      // is torn down after PONG_MISS_LIMIT intervals (~30s at the default),
      // clearing the false `connected:true` and unblocking the next reconnect.
      if (this.pendingRequests.size === 0) {
        this.missedPongs += 1;
        if (this.missedPongs >= PONG_MISS_LIMIT) {
          this.log('warn', `Evicting Godot socket after ${this.missedPongs} missed pongs (half-open connection)`);
          const deadSocket = this.socket;
          this.handleDisconnect(deadSocket, new Error('Pong timeout — half-open Godot connection'));
          deadSocket?.terminate();
          return;
        }
      }

      try {
        const ping: PingMessage = { type: 'ping' };
        this.sendMessage(ping);
      } catch (error) {
        this.log('warn', `Failed to send ping: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, this.keepaliveIntervalMs);
  }

  private stopKeepalive(): void {
    if (!this.pingInterval) {
      return;
    }

    clearInterval(this.pingInterval);
    this.pingInterval = null;
  }

  private handleDisconnect(disconnectedSocket: WebSocket | null, reason: Error): void {
    // Ignore disconnect events that don't refer to the current socket. Covers
    // two cases: (1) a stale socket whose `close` fires after it was already
    // replaced by a newer connection (last-writer-wins takeover), and (2) a
    // socket we already tore down — a forced `terminate()` emits a late `close`
    // after we nulled `this.socket`, which would otherwise emit a second
    // spurious `godot_disconnected`.
    if (disconnectedSocket && disconnectedSocket !== this.socket) {
      this.log('debug', 'Ignoring stale Godot socket disconnect event');
      return;
    }

    this.stopKeepalive();
    this.missedPongs = 0;

    this.socket = null;
    this.connectionInfo = null;
    this.emitBridgeEvent('godot_disconnected', {});

    this.rejectAllPending(reason);
    this.resourceQueues.clear();
  }

  private emitBridgeEvent<K extends keyof BridgeEventMap>(eventName: K, payload: BridgeEventMap[K]): void {
    this.emit(eventName, payload);
  }

  private getDefaultVisualizerHtml(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Godot MCP Visualizer</title>
  </head>
  <body>
    <h1>Godot MCP Visualizer</h1>
    <p>Run the map_project tool to load visualization data.</p>
  </body>
</html>`;
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  private enqueueResourceRequest<T>(resourceKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.resourceQueues.get(resourceKey) ?? Promise.resolve();

    const taskPromise = previous.catch(() => undefined).then(task);

    const tail = taskPromise.then(() => undefined, () => undefined);
    this.resourceQueues.set(resourceKey, tail);

    return taskPromise.finally(() => {
      if (this.resourceQueues.get(resourceKey) === tail) {
        this.resourceQueues.delete(resourceKey);
      }
    });
  }

  private getResourceKey(args: Record<string, unknown>): string | undefined {
    const scenePath = this.getStringArg(args, 'scenePath') ?? this.getStringArg(args, 'scene_path');
    if (scenePath) {
      return `scene:${scenePath}`;
    }

    const resourcePath = this.getStringArg(args, 'resourcePath') ?? this.getStringArg(args, 'resource_path');
    if (resourcePath) {
      return `resource:${resourcePath}`;
    }

    return undefined;
  }

  private getStringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private isIncomingMessage(value: unknown): value is IncomingMessage {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const message = value as Record<string, unknown>;
    const type = message.type;
    if (type !== 'tool_result' && type !== 'pong' && type !== 'godot_ready') {
      return false;
    }

    if (type === 'pong') {
      return true;
    }

    if (type === 'godot_ready') {
      return typeof message.project_path === 'string';
    }

    return (
      typeof message.id === 'string' &&
      typeof message.success === 'boolean' &&
      (message.error === undefined || typeof message.error === 'string')
    );
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    console.error(`[${new Date().toISOString()}] [GodotBridge:${level.toUpperCase()}] ${message}`);
  }
}

let defaultBridge: GodotBridge | null = null;

export function getDefaultBridge(): GodotBridge {
  if (!defaultBridge) {
    defaultBridge = new GodotBridge(resolveDefaultBridgePort(), resolveDefaultBridgeHost());
  }

  return defaultBridge;
}

export function createBridge(port?: number, timeoutMs?: number, host?: string, keepaliveIntervalMs?: number, probationTimeoutMs?: number): GodotBridge {
  return new GodotBridge(port, host, timeoutMs, keepaliveIntervalMs, probationTimeoutMs);
}
