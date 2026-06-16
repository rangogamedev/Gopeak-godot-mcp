#!/usr/bin/env bash
# gen-worktree-mcp.sh — write a per-worktree .mcp.json that binds THIS Godot
# project to its own gopeak MCP server (GOPEAK_PROJECT_PATH) and enables
# on-demand editor auto-launch (GOPEAK_AUTO_LAUNCH_EDITOR), overriding the
# shared user-scope `godot` server for this directory.
#
# WHY: a shared user-scope server starts project-agnostic — no GOPEAK_PROJECT_PATH
# and a cwd that is often not a Godot project root — so it never writes the
# per-project discovery file (<project>/.gopeak/bridge.json) and never gates its
# bridge on a project. Concurrent worktrees then fall back to the shared default
# bridge port and collide. Pinning the project per worktree makes multi-session
# isolation + auto-launch actually engage: each agent gets its own bridge port,
# its own discovery file, and (with no editor open) auto-spawns one for ITS
# worktree.
#
# Usage:
#   bash scripts/gen-worktree-mcp.sh                  # bind $PWD
#   bash scripts/gen-worktree-mcp.sh /path/to/worktree
#   GODOT_PATH=/mnt/c/.../Godot.exe \
#   GOPEAK_BUILD_ENTRY="$HOME/gopeak-wsl/build/index.js" \
#     bash scripts/gen-worktree-mcp.sh
set -euo pipefail

WORKTREE="${1:-$PWD}"
WORKTREE="$(cd "$WORKTREE" && pwd)"   # absolutize (and fail fast if missing)

if [ ! -f "$WORKTREE/project.godot" ]; then
  echo "✗ $WORKTREE has no project.godot — point this at a Godot project root." >&2
  exit 1
fi

# Resolve the build entry. Default to the native-ext4 deploy (fast cold start
# under WSL); override with GOPEAK_BUILD_ENTRY. Warn but don't fail if absent —
# the file is still useful once the build exists.
BUILD_ENTRY="${GOPEAK_BUILD_ENTRY:-$HOME/gopeak-wsl/build/index.js}"
if [ ! -f "$BUILD_ENTRY" ]; then
  echo "⚠ build entry not found: $BUILD_ENTRY" >&2
  echo "  Build it first (bash scripts/wsl-setup.sh) or pass GOPEAK_BUILD_ENTRY=..." >&2
fi

# Resolve GODOT_PATH: explicit env > existing user-scope `godot` server in
# ~/.claude.json > placeholder.
GODOT_PATH_RESOLVED="${GODOT_PATH:-}"
if [ -z "$GODOT_PATH_RESOLVED" ] && [ -f "$HOME/.claude.json" ]; then
  GODOT_PATH_RESOLVED="$(node -e '
    try {
      const c = require(process.env.HOME + "/.claude.json");
      const pick = (o) => o && o.mcpServers && o.mcpServers.godot
        && o.mcpServers.godot.env && o.mcpServers.godot.env.GODOT_PATH;
      let p = pick(c);
      if (!p && c.projects) for (const k of Object.keys(c.projects)) { p = pick(c.projects[k]); if (p) break; }
      process.stdout.write(p || "");
    } catch (_) { process.stdout.write(""); }
  ' 2>/dev/null || true)"
fi
GODOT_PATH_RESOLVED="${GODOT_PATH_RESOLVED:-/mnt/c/path/to/Godot_win64.exe}"

OUT="$WORKTREE/.mcp.json"
# Back up an existing file we did not generate (no GOPEAK_PROJECT_PATH marker).
if [ -f "$OUT" ] && ! grep -q '"GOPEAK_PROJECT_PATH"' "$OUT" 2>/dev/null; then
  BAK="$OUT.bak.$(date +%s 2>/dev/null || echo prev)"
  cp "$OUT" "$BAK"
  echo "• backed up existing $OUT → $BAK"
fi

# Tool profile + pre-activated groups are env-overridable (same pattern as
# GODOT_PATH / GOPEAK_BUILD_ENTRY) with the established defaults.
TOOL_PROFILE="${GOPEAK_TOOL_PROFILE:-compact}"
STARTUP_GROUPS="${GOPEAK_STARTUP_ACTIVE_GROUPS:-dap,lsp,runtime}"
AUTO_LAUNCH="${GOPEAK_AUTO_LAUNCH_EDITOR:-1}"

# Emit JSON via node so paths with spaces/backslashes are escaped correctly.
WORKTREE="$WORKTREE" BUILD_ENTRY="$BUILD_ENTRY" \
GODOT_PATH_RESOLVED="$GODOT_PATH_RESOLVED" OUT="$OUT" \
TOOL_PROFILE="$TOOL_PROFILE" STARTUP_GROUPS="$STARTUP_GROUPS" AUTO_LAUNCH="$AUTO_LAUNCH" \
node -e '
  const fs = require("fs");
  const cfg = { mcpServers: { godot: {
    command: "node",
    args: [process.env.BUILD_ENTRY],
    env: {
      GODOT_PATH: process.env.GODOT_PATH_RESOLVED,
      GOPEAK_PROJECT_PATH: process.env.WORKTREE,
      GOPEAK_AUTO_LAUNCH_EDITOR: process.env.AUTO_LAUNCH,
      GOPEAK_TOOL_PROFILE: process.env.TOOL_PROFILE,
      GOPEAK_STARTUP_ACTIVE_GROUPS: process.env.STARTUP_GROUPS,
    },
  } } };
  fs.writeFileSync(process.env.OUT, JSON.stringify(cfg, null, 2) + "\n");
'

EXCLUDE_PATH="$(git -C "$WORKTREE" rev-parse --git-path info/exclude 2>/dev/null || echo "$WORKTREE/.gitignore")"

echo "✓ wrote $OUT"
echo
echo "  project : $WORKTREE"
echo "  server  : node $BUILD_ENTRY"
echo "  godot   : $GODOT_PATH_RESOLVED"
echo
echo "Next:"
echo "  • Keep this file local (it has machine-specific absolute paths). Add"
echo "    '.mcp.json' to the project .gitignore, or exclude it just for this worktree:"
echo "        echo '.mcp.json' >> \"$EXCLUDE_PATH\""
echo "  • Start \`claude\` from $WORKTREE. On first use, approve the project-scoped"
echo "    'godot' server when prompted — it overrides the user-scope one here."
echo "  • Enable the 'Godot MCP Editor' plugin in this project (Project > Project"
echo "    Settings > Plugins) so the auto-launched editor can connect back."
echo "  • To disable auto-launch for this worktree, set GOPEAK_AUTO_LAUNCH_EDITOR=0"
echo "    in $OUT."
