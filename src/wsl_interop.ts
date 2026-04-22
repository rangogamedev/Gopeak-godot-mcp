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
 * Normalize a path for cross-platform equality comparison. Handles the
 * WSL↔Windows case where Godot LSP responses arrive as `file:///C:/...` but
 * local filesystem resolution produces `/mnt/c/...`.
 */
export function normalizePathForCrossPlatformComparison(pathValue: string): string {
  const mounted = convertWindowsPathToMounted(pathValue);
  const canonical = mounted ?? pathValue;
  return canonical.replace(/\\/g, '/').toLowerCase();
}
