/**
 * WSL ↔ Windows interop helpers.
 *
 * Pure functions that translate paths and resolve runtime details when the
 * MCP server runs under WSL and drives a Windows Godot executable. Extracted
 * from `src/index.ts` so they can be unit-tested in isolation and reused by
 * the LSP/DAP clients.
 */

import { existsSync, readFileSync } from 'fs';
import { normalize } from 'path';
import { release } from 'os';
import { execSync } from 'child_process';

import type { WSLInteropDetails } from './server-types.js';

export function isWSLRuntime(): boolean {
  return process.platform === 'linux' && release().toLowerCase().includes('microsoft');
}

export function getWSLInteropDetails(godotPath: string | null | undefined): WSLInteropDetails {
  const isWSL = isWSLRuntime();
  const normalizedPath = godotPath ? normalize(godotPath).replace(/\\/g, '/').toLowerCase() : '';
  const windowsTarget = normalizedPath.endsWith('.exe') || /^[a-z]:\//.test(normalizedPath);

  return {
    isWSL,
    windowsTarget,
    mode: !isWSL ? 'native' : (windowsTarget ? 'wsl_windows' : 'wsl_linux'),
  };
}

export function convertMountedPathToWindows(path: string): string | null {
  const normalizedPath = normalize(path).replace(/\\/g, '/');
  const match = normalizedPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) {
    return null;
  }

  const [, drive, remainder] = match;
  return `${drive.toUpperCase()}:\\${remainder.replace(/\//g, '\\')}`;
}

export function convertWindowsPathToMounted(path: string): string | null {
  const trimmed = path.replace(/^file:\/\/\/?/, '');
  const match = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!match) {
    return null;
  }

  const [, drive, remainder] = match;
  return `/mnt/${drive.toLowerCase()}/${remainder.replace(/\\/g, '/')}`;
}

export function ensureWSLWindowsProjectPath(projectPath: string): void {
  if (!convertMountedPathToWindows(projectPath)) {
    throw new Error(
      `Windows Godot from WSL requires the project to live on /mnt/<drive>/... . Received: ${projectPath}`
    );
  }
}

export function translatePathForGodot(path: string, details: WSLInteropDetails, label: string): string {
  if (details.mode !== 'wsl_windows') {
    return path;
  }

  const translatedPath = convertMountedPathToWindows(path);
  if (!translatedPath) {
    throw new Error(
      `${label} must be on a Windows-mounted path under /mnt/<drive>/ when using Windows Godot from WSL. Received: ${path}`
    );
  }

  return translatedPath;
}

/**
 * Resolve a Windows-visible temp directory accessible from both WSL and
 * Windows Godot. Used for writing `@file:` parameter payloads that a Windows
 * process must be able to read back.
 *
 * Resolution order:
 *   1. GOPEAK_WSL_TEMP_DIR env override (must exist)
 *   2. /mnt/c/Windows/Temp (world-writable on Windows, always present)
 *
 * Returns `null` when not running under WSL→Windows (callers should fall
 * back to the OS tmpdir in that case).
 */
export function resolveWSLWindowsTempDir(details: WSLInteropDetails): string | null {
  if (details.mode !== 'wsl_windows') {
    return null;
  }

  const envOverride = process.env.GOPEAK_WSL_TEMP_DIR;
  if (envOverride && existsSync(envOverride)) {
    return envOverride;
  }

  const systemTemp = '/mnt/c/Windows/Temp';
  if (existsSync(systemTemp)) {
    return systemTemp;
  }

  return null;
}

let cachedWindowsHostIp: string | null | undefined;

/**
 * Resolve the Windows host IP reachable from WSL2. Used to connect to
 * Windows-side services (LSP 6005, DAP 6006, runtime 7777) that bind to
 * the Windows loopback or the `vEthernet (WSL)` adapter.
 *
 * Resolution order:
 *   1. `WSL_HOST_IP` env (explicit override)
 *   2. Default gateway from `ip route show default` — the Windows-side
 *      vEthernet (WSL) adapter IP. Works in modern WSL2 NAT mode where
 *      `/etc/resolv.conf` lists a DNS-only forwarder (e.g.
 *      `10.255.255.254`) that is NOT a TCP route to the host.
 *   3. `nameserver` entry in `/etc/resolv.conf` (legacy WSL2 default
 *      where the DNS forwarder happens to equal the host IP).
 *
 * Result cached for process lifetime. Returns `null` when nothing resolved.
 */
export function resolveWindowsHostIp(): string | null {
  if (cachedWindowsHostIp !== undefined) {
    return cachedWindowsHostIp;
  }

  const envOverride = process.env.WSL_HOST_IP;
  if (envOverride) {
    cachedWindowsHostIp = envOverride;
    return envOverride;
  }

  try {
    const routeOutput = execSync('ip route show default', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 500,
    });
    const match = routeOutput.match(/^default\s+via\s+(\S+)/m);
    if (match) {
      cachedWindowsHostIp = match[1];
      return match[1];
    }
  } catch {
    // fall through to resolv.conf
  }

  try {
    const resolvConf = readFileSync('/etc/resolv.conf', 'utf8');
    const match = resolvConf.match(/^\s*nameserver\s+(\S+)\s*$/m);
    if (match) {
      cachedWindowsHostIp = match[1];
      return match[1];
    }
  } catch {
    // fall through
  }

  cachedWindowsHostIp = null;
  return null;
}

// Exported for tests that want to reset the memoized host IP.
export function __resetWindowsHostIpCacheForTests(): void {
  cachedWindowsHostIp = undefined;
}

/**
 * Resolve the host the MCP server should use when connecting to the Godot
 * runtime autoload TCP server (default port 7777). Mirrors the
 * LSP/DAP pattern: explicit env override → WSL→Windows auto-detect →
 * `127.0.0.1`.
 */
export function resolveDefaultRuntimeHost(): string {
  const envOverride =
    process.env.GOPEAK_RUNTIME_HOST ||
    process.env.GODOT_RUNTIME_HOST ||
    process.env.MCP_RUNTIME_HOST;
  if (envOverride) {
    return envOverride;
  }

  const interop = getWSLInteropDetails(process.env.GODOT_PATH ?? null);
  if (interop.mode === 'wsl_windows') {
    const winHost = resolveWindowsHostIp();
    if (winHost) {
      return winHost;
    }
  }

  return '127.0.0.1';
}

/**
 * Resolve the address the Godot runtime autoload (inside the running game)
 * should bind its control TCP server to. Communicated to the game via the
 * `GOPEAK_RUNTIME_BIND_HOST` env var (and mirrored into the discovery file).
 *
 * Defaults to loopback (`127.0.0.1`) for security — the runtime control socket
 * accepts method calls and property writes, so it must not be world-reachable.
 * In WSL→Windows mode it binds `0.0.0.0` instead, because the game runs on
 * Windows while gopeak runs in WSL and reaches it via the Windows host IP
 * (`resolveDefaultRuntimeHost`), which loopback would block.
 *
 * This is a deliberate WSL-aware superset of upstream's hardcoded `127.0.0.1`
 * bind (issue-38): same security default, without breaking WSL reachability.
 *
 * Resolution order:
 *   1. `GOPEAK_RUNTIME_BIND_HOST` env override (power users / CI).
 *   2. `0.0.0.0` when mode is `wsl_windows`.
 *   3. `127.0.0.1` otherwise.
 */
export function resolveDefaultRuntimeBindHost(details: WSLInteropDetails): string {
  const envOverride = process.env.GOPEAK_RUNTIME_BIND_HOST;
  if (envOverride && envOverride.trim().length > 0) {
    return envOverride.trim();
  }
  if (details.mode === 'wsl_windows') {
    return '0.0.0.0';
  }
  return '127.0.0.1';
}

/**
 * Resolve the TCP port the MCP server should use when connecting to the
 * Godot DAP server. Engine binds `127.0.0.1:6006` hardcoded; the editor
 * addon's `McpDapRelay` exposes it on `0.0.0.0:<relay_port>` (default
 * 6016) so WSL clients can reach it without a `netsh portproxy` rule.
 *
 * Resolution order:
 *   1. `GOPEAK_DAP_PORT` / `GODOT_DAP_PORT` / `MCP_DAP_PORT` env override
 *   2. `6006` default (upstream engine port; used when the relay is
 *      disabled or running on the same host).
 *
 * Returning a relay port here assumes the user has flipped
 * `mcp/editor/dap_relay_enabled` in Project Settings and restarted the
 * Godot editor. This helper does not read `project.godot` itself —
 * keeping it pure so it unit-tests with the rest of `wsl_interop.ts`.
 */
export function resolveDefaultDAPPort(): number {
  const envValue =
    process.env.GOPEAK_DAP_PORT ||
    process.env.GODOT_DAP_PORT ||
    process.env.MCP_DAP_PORT;
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return 6006;
}

const RUNTIME_PORT_ENV_KEYS = ['GOPEAK_RUNTIME_PORT', 'GODOT_RUNTIME_PORT', 'MCP_RUNTIME_PORT'] as const;
const RUNTIME_PORT_DEFAULT = 7777;

/**
 * Resolve the TCP port the MCP server should use when connecting to the
 * Godot runtime autoload (`addons/godot_mcp_runtime/`). Mirrors the
 * bridge/DAP env-override pattern so port 7777 is escapable when something
 * else holds the port on the Windows side.
 *
 * Resolution order:
 *   1. `GOPEAK_RUNTIME_PORT` / `GODOT_RUNTIME_PORT` / `MCP_RUNTIME_PORT`
 *      env override (first valid wins).
 *   2. `7777` default (hardcoded constant on the autoload side; agreement
 *      enforced by `testRuntimePortAddonEnvOverride` in
 *      `test-regressions.mjs`).
 *
 * Invalid values (non-integer, ≤0, ≥65536) emit a warning to stderr and
 * fall through to the next key, matching `resolveDefaultBridgePort()`.
 */
export function resolveDefaultRuntimePort(): number {
  for (const key of RUNTIME_PORT_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw || raw.trim().length === 0) {
      continue;
    }

    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }

    console.error(`[wsl_interop] Ignoring invalid ${key}="${raw}". Expected an integer between 1 and 65535.`);
  }

  return RUNTIME_PORT_DEFAULT;
}

/**
 * Normalize a path for cross-platform equality comparison. Handles the
 * WSL↔Windows case where Godot LSP responses arrive as `file:///C:/...` but
 * local filesystem resolution produces `/mnt/c/...`.
 */
export function normalizePathForCrossPlatformComparison(pathValue: string): string {
  const mounted = convertWindowsPathToMounted(pathValue);
  const canonical = mounted ?? pathValue;
  return canonical.replace(/\\/g, '/').toLowerCase();
}
