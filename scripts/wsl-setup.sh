#!/usr/bin/env bash
# wsl-setup.sh — build GoPeak on the native Linux filesystem and print the
# `claude mcp add -s user` command to register it.
#
# WHY: Under WSL, launching `node build/index.js` from a /mnt/c (9p) path makes
# Node load node_modules in ~20-40s (Windows Defender scans every file open),
# which exceeds Claude Code's hard 30s MCP `initialize` timeout. The server is
# then marked failed and must be reconnected with `/mcp` every fresh session.
# Running the SAME build from a native Linux (ext4) path drops cold start to <1s.
#
# Usage:
#   bash scripts/wsl-setup.sh                 # build here + print register command
#   GODOT_PATH=/mnt/c/.../Godot.exe bash scripts/wsl-setup.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ENTRY="$REPO_ROOT/build/index.js"
FSTYPE="$(stat -f -c '%T' "$REPO_ROOT" 2>/dev/null || echo unknown)"

echo "GoPeak WSL setup"
echo "  repo:    $REPO_ROOT"
echo "  fs type: $FSTYPE"

# 1) Refuse to "fix" things while running from the slow Windows mount.
case "$FSTYPE" in
  9p|drvfs|v9fs|cifs)
    cat >&2 <<EOF

✗ This checkout is on a Windows mount ($FSTYPE), which is the cause of the
  cold-start timeout. Create a copy on the native Linux filesystem and run
  this script from there, e.g.:

      git worktree add "\$HOME/gopeak-wsl" -b wsl-runtime wsl-windows-compat
      cd "\$HOME/gopeak-wsl"
      bash scripts/wsl-setup.sh

EOF
    exit 1 ;;
esac

# 2) Build on the native filesystem.
cd "$REPO_ROOT"
# Reinstall when modules are missing OR package-lock.json is newer (e.g. after a
# git merge that changed deps); npm install is idempotent when the lock is current.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "→ npm install"
  npm install --no-audit --no-fund
fi
echo "→ npm run build"
npm run build

[ -f "$BUILD_ENTRY" ] || { echo "✗ build did not produce $BUILD_ENTRY" >&2; exit 1; }

# 3) Print the registration command (user scope → all projects/worktrees inherit it).
GODOT_PATH="${GODOT_PATH:-/mnt/c/path/to/Godot_<ver>_win64.exe}"
echo
echo "✓ Built at: $BUILD_ENTRY"
echo
echo "Register with Claude Code at user scope (edit GODOT_PATH if needed):"
echo
cat <<EOF
claude mcp add godot -s user \\
  -e GODOT_PATH="$GODOT_PATH" \\
  -e GOPEAK_TOOL_PROFILE=compact \\
  -e GOPEAK_STARTUP_ACTIVE_GROUPS=dap,lsp,runtime \\
  -- node "$BUILD_ENTRY"
EOF
echo
echo "(If a stale entry points at /mnt/c, remove it first:  claude mcp remove godot  — run from that project's dir; the CLI removes it from whichever scope it lives in.)"
