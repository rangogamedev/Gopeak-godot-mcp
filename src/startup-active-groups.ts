/**
 * Pure helpers for the GOPEAK_STARTUP_ACTIVE_GROUPS env-var pipeline.
 *
 * The server constructor reads a comma-separated list of dynamic tool-group
 * names from the env and seeds `activeGroups` with them before any MCP request
 * handler runs, so the initial `tools/list` response already includes those
 * groups' tools. This is the escape hatch for MCP clients whose tool cache
 * does not refresh on `notifications/tools/list_changed` (e.g. Claude Code).
 *
 * Split into its own module so the parse logic is unit-testable without
 * spawning the MCP server. Pure functions, no I/O, no globals.
 */

export interface StartupActiveGroupsResult {
  /** Canonical group names the caller should activate (duplicates removed). */
  activated: string[];
  /** Names from the env input that did not match any known group. */
  unknown: string[];
}

/**
 * Split the raw env value on commas, trim whitespace, drop empties, and match
 * each token case-insensitively against `knownGroups`. Returns canonical
 * names in `activated` (first occurrence preserved) and unrecognised tokens
 * in `unknown`.
 *
 * Matching is case-insensitive; the canonical casing from `knownGroups` is
 * what ends up in `activated`. Whitespace around commas is tolerated; empty
 * items (e.g. from trailing commas) are dropped.
 *
 * Pure: no side effects, no env reads, no logging.
 */
export function parseStartupActiveGroups(
  raw: string | undefined,
  knownGroups: readonly string[],
): StartupActiveGroupsResult {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') {
    return { activated: [], unknown: [] };
  }

  const canonicalByLower = new Map<string, string>();
  for (const key of knownGroups) {
    canonicalByLower.set(key.toLowerCase(), key);
  }

  const seen = new Set<string>();
  const activated: string[] = [];
  const unknown: string[] = [];

  for (const token of trimmed.split(',')) {
    const name = token.trim();
    if (name === '') {
      continue;
    }
    const canonical = canonicalByLower.get(name.toLowerCase());
    if (canonical === undefined) {
      unknown.push(name);
      continue;
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    activated.push(canonical);
  }

  return { activated, unknown };
}

/**
 * Read the startup env (primary `GOPEAK_STARTUP_ACTIVE_GROUPS`, fallback
 * `MCP_STARTUP_ACTIVE_GROUPS`). Pure getter — kept separate from `parseStartupActiveGroups`
 * so tests can drive the parser with explicit input without touching `process.env`.
 */
export function readStartupActiveGroupsEnv(): string {
  return process.env.GOPEAK_STARTUP_ACTIVE_GROUPS ?? process.env.MCP_STARTUP_ACTIVE_GROUPS ?? '';
}
