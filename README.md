# GoPeak

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white 'Node.js')](https://nodejs.org/en/download/)
[![](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)
[![npm](https://img.shields.io/npm/v/gopeak?style=flat&logo=npm&logoColor=white 'npm')](https://www.npmjs.com/package/gopeak)
[![](https://img.shields.io/github/last-commit/HaD0Yun/Gopeak-godot-mcp 'Last Commit')](https://github.com/HaD0Yun/Gopeak-godot-mcp/commits/main)
[![](https://img.shields.io/github/stars/HaD0Yun/Gopeak-godot-mcp 'Stars')](https://github.com/HaD0Yun/Gopeak-godot-mcp/stargazers)
[![](https://img.shields.io/github/forks/HaD0Yun/Gopeak-godot-mcp 'Forks')](https://github.com/HaD0Yun/Gopeak-godot-mcp/network/members)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)

🌐 **Languages**: **English** | [한국어](README-ko.md) | [日本語](README-ja.md) | [Deutsch](README-de.md) | [Português](README-pt_BR.md) | [简体中文](README-zh.md)

![GoPeak Hero](assets/gopeak-hero-v2.png)

**GoPeak is an MCP server for Godot that lets AI assistants run, inspect, modify, and debug real projects end-to-end.**

> English is the canonical source of truth. Localized READMEs are concise overviews and may lag behind `README.md`.

> Discord community chat is temporarily unavailable while the invite link is refreshed. Please use GitHub Discussions in the meantime: https://github.com/HaD0Yun/Gopeak-godot-mcp/discussions

---

## Quick Start (3 Minutes)

### Requirements

- Godot 4.x
- Node.js 18+
- MCP-compatible client (Claude Desktop, Cursor, Cline, OpenCode, etc.)

### 1) Run GoPeak

```bash
npx -y gopeak
```

or install globally:

```bash
npm install -g gopeak
gopeak
```

Optional shell hooks for update notifications are now **opt-in**:

```bash
gopeak setup
```

> `gopeak setup` only modifies supported bash/zsh rc files when you run it explicitly. `npm install` no longer installs shell hooks automatically.

### 2) Add MCP client config

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "gopeak"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "GOPEAK_TOOL_PROFILE": "compact"
      }
    }
  }
}
```

> `GOPEAK_TOOL_PROFILE=compact` is the default. It exposes 33 core tools with 22 dynamic tool groups (78 additional tools) that activate on demand — keeping token usage low while preserving full capability.

### 3) First prompts to try

- "List Godot projects in `/your/projects` and show project info."
- "Create `scenes/Player.tscn` with `CharacterBody2D` root and add a movement script."
- "Run project, get debug output, then fix top error."

---

## Why GoPeak

- **Real project feedback loop**: run the game, inspect logs, and fix in-context.
- **110+ tools available** across scene/script/resource/runtime/LSP/DAP/input/assets.
- **Token-efficient by default**: compact tool surface (33 tools) + dynamic tool groups. Only activate what you need — no more 110-tool context bombs.
- **Dynamic tool groups**: search with `tool.catalog` and matching groups auto-activate. Or manually activate with `tool.groups`.
- **Deep Godot integration**: ClassDB queries, runtime inspection, debugger hooks, bridge-based scene/resource edits.

### Best For

- Solo/indie developers moving quickly with AI assistance
- Teams that need AI grounded in actual project/runtime state
- Debug-heavy workflows (breakpoints, stack traces, live runtime checks)

---

## Tool Surface Model (Important)

GoPeak supports three exposure profiles:

- `compact` (default): 33 core tools + **22 dynamic tool groups** (78 additional tools activated on demand)
- `full`: exposes full legacy tool list (110+)
- `legacy`: same exposed behavior as `full`

Configure with either:

- `GOPEAK_TOOL_PROFILE`
- `MCP_TOOL_PROFILE` (fallback alias)

### Dynamic Tool Groups (compact mode)

In `compact` mode, 78 additional tools are organized into **22 groups** that activate automatically when needed:

| Group | Tools | Description |
|---|---|---|
| `scene_advanced` | 3 | Duplicate, reparent nodes, load sprites |
| `uid` | 2 | UID management for resources |
| `import_export` | 5 | Import pipeline, reimport, validate project |
| `autoload` | 4 | Autoload singletons, main scene |
| `signal` | 2 | Disconnect signals, list connections |
| `runtime` | 4 | Live scene inspection, runtime properties, metrics |
| `resource` | 4 | Create/modify materials, shaders, resources |
| `animation` | 5 | Animations, tracks, animation tree, state machine |
| `plugin` | 3 | Enable/disable/list editor plugins |
| `input` | 1 | Input action mapping |
| `tilemap` | 2 | TileSet and TileMap/TileMapLayer cell painting |
| `audio` | 4 | Audio buses, effects, volume |
| `navigation` | 2 | Navigation regions and agents |
| `theme_ui` | 3 | Theme colors, font sizes, shaders |
| `asset_store` | 3 | Search/download CC0 assets |
| `testing` | 6 | Screenshots, viewport capture, input injection |
| `dx_tools` | 4 | Error log, project health, find usages, scaffold |
| `intent_tracking` | 9 | Intent capture, decision logs, handoff briefs |
| `class_advanced` | 1 | Class inheritance inspection |
| `lsp` | 3 | GDScript completions, hover, symbols |
| `dap` | 6 | Breakpoints, stepping, stack traces |
| `version_gate` | 2 | Version validation, patch verification |

**How it works:**

1. **Auto-activation via catalog**: Search with `tool.catalog` and matching groups activate automatically.
   > "Use `tool.catalog` with query `animation` and show relevant tools."

2. **Manual activation**: Directly activate a group with `tool.groups`.
   > "Use `tool.groups` to activate the `dap` group for debugging."

3. **Deactivation**: Remove groups when done to reduce context.
   > "Use `tool.groups` to reset all active groups."

The server sends `notifications/tools/list_changed` so MCP clients (Claude Code, Claude Desktop) automatically refresh the tool list.
If your MCP client caches tools aggressively and does not refresh after activation, reconnect the client or call the newly activated tool directly once to force a fresh `tools/list` round-trip.

### Typed property values for scene tools

Bridge-backed scene tools (`add_node`, `set_node_properties`) now coerce common vector payloads such as `{ "x": 100, "y": 200 }` and `[100, 200]` for typed properties like `position` and `scale`. Tagged values are still the safest cross-tool form:

```json
{
  "position": { "type": "Vector2", "x": 100, "y": 200 },
  "scale": { "type": "Vector2", "x": 2, "y": 2 }
}
```

The internal headless serializer uses `_type`, but MCP callers should prefer `type` when they need an explicit cross-tool Godot value tag.

### Don't worry about tokens

GoPeak uses **cursor-based pagination** for `tools/list` — even in `full` profile, tools are delivered in pages (default 33) instead of dumping all 110+ definitions at once. Your AI client fetches the next page only when it needs more.

Set page size with `GOPEAK_TOOLS_PAGE_SIZE`:

```json
{
  "env": {
    "GOPEAK_TOOLS_PAGE_SIZE": "25"
  }
}
```

---

## Installation Options

### A) Recommended: npx

```bash
npx -y gopeak
```

### B) Global install

```bash
npm install -g gopeak
gopeak
```

Optional shell hooks for update notifications remain available via:

```bash
gopeak setup
```

### C) From source

```bash
git clone https://github.com/HaD0Yun/Gopeak-godot-mcp.git
cd godot-mcp
npm install
npm run build
node build/index.js
```

GoPeak also exposes two CLI bin names:

- `gopeak`
- `godot-mcp`

### D) WSL (Windows Subsystem for Linux) — run from the native Linux filesystem

**Do not run the server from a `/mnt/c` Windows path under WSL.** Loading `node_modules` from
the `/mnt/c` 9p mount (made worse by Windows Defender scanning each file open) takes ~20–40s,
which exceeds Claude Code's hard **30s MCP `initialize` timeout**. The server is then marked
failed and must be reconnected with `/mcp` on every fresh session. Running the *same* build from
a native Linux (ext4) path drops cold start to well under 1s and removes the reconnect entirely.

Keep the runnable copy under `$HOME` (ext4) — a git worktree is convenient — then register it at
**user scope** so every project/worktree inherits it:

```bash
# from your /mnt/c checkout (or clone fresh under $HOME):
git worktree add ~/gopeak-wsl -b wsl-runtime wsl-windows-compat
cd ~/gopeak-wsl
npm install && npm run build

# point Claude Code at the ext4 build (set GODOT_PATH to your Windows Godot .exe):
claude mcp add godot -s user \
  -e GODOT_PATH="/mnt/c/path/to/Godot_<ver>_win64.exe" \
  -e GOPEAK_TOOL_PROFILE=compact \
  -e GOPEAK_STARTUP_ACTIVE_GROUPS=dap,lsp,runtime \
  -- node "$HOME/gopeak-wsl/build/index.js"
```

After updating, rebuild in place: `cd ~/gopeak-wsl && git merge wsl-windows-compat && npm install && npm run build`. The worktree branch has no upstream, so `git pull` won't work — first refresh your base branch (e.g. `git pull` in your `/mnt/c` checkout, or `git fetch` for a standalone clone), then merge or rebase it in.
WSL→Windows connectivity (editor bridge on `0.0.0.0:6505`, LSP/DAP/runtime host resolution) is
unaffected by the filesystem location. Or run `bash scripts/wsl-setup.sh`, which builds and prints the `claude mcp add` command for you to paste (it does not register anything itself).

---

## Documentation

- [Documentation Map](docs/README.md)
- [Architecture](docs/architecture.md)
- [Platform Roadmap](docs/platform-roadmap.md)
- [Unity-MCP Benchmark Plan](docs/unity-mcp-benchmark-plan.md)
- [Release Process](docs/release-process.md)

## CI

GitHub Actions runs on push/PR and executes:

1. `npm run build`
2. `npx tsc --noEmit`
3. `npm run smoke`

Run the same checks locally before opening a PR:

```bash
npm run ci
npm run test:dynamic-groups
npm run test:integration
```

---

## Versioning & Release

Use the built-in bump script to keep `package.json` and `server.json` in sync:

```bash
node scripts/bump-version.mjs patch
node scripts/bump-version.mjs minor --dry-run
```

Full release checklist: [`docs/release-process.md`](docs/release-process.md).

---

## Addons (Recommended)

### Auto Reload + Editor Bridge + Runtime Addon installer

Install in your Godot project folder:

```bash
curl -sL https://raw.githubusercontent.com/HaD0Yun/Gopeak-godot-mcp/main/install-addon.sh | bash
```

PowerShell:

```powershell
iwr https://raw.githubusercontent.com/HaD0Yun/Gopeak-godot-mcp/main/install-addon.ps1 -UseBasicParsing | iex
```

Then enable plugins in **Project Settings → Plugins** (especially `godot_mcp_editor` for bridge-backed scene/resource tools).

---

## Core Capabilities

- **Project control**: launch editor, run/stop project, capture debug output
- **Scene editing**: create scenes, add/delete/reparent nodes, edit properties
- **Script workflows**: create/modify scripts, inspect script structure
- **Resources**: create/modify resources, materials, shaders, tilesets
- **Signals/animation**: connect signals, build animations/tracks/state machines
- **Runtime tools**: inspect live tree, set properties, call methods, metrics
- **LSP + DAP**: diagnostics/completion/hover + breakpoints/step/stack trace
- **Input + screenshots**: keyboard/mouse/action injection and viewport capture
- **Asset library**: search/fetch CC0 assets (Poly Haven, AmbientCG, Kenney)

### Tool families (examples)

| Area | Examples |
|---|---|
| Project | `project.list`, `project.info`, `editor.run` |
| Scene/Node | `scene.create`, `scene.node.add`, `set_node_properties` |
| Script | `script.create`, `script.modify`, `script.info` |
| Runtime | `runtime.status`, `inspect_runtime_tree`, `call_runtime_method` |
| LSP/DAP | `lsp.diagnostics`, `lsp_get_hover`, `dap_set_breakpoint`, `dap.output` |
| Input/Visual | `inject_key`, `inject_mouse_click`, `capture_screenshot` |

---

## Project Visualizer

Visualize your entire project architecture with `visualizer.map` (`map_project` legacy). Scripts are grouped by folder structure into color-coded categories.

![Project Visualizer — AI-generated architecture map](assets/visualizer-category-map.png)

---

## Quick Prompt Examples

### Build
- "Create a Player scene with CharacterBody2D, Sprite2D, CollisionShape2D, and a basic movement script."
- "Add an enemy spawner scene and wire spawn signals to GameManager."

### Debug
- "Run the project, collect errors, and fix the top 3 issues automatically."
- "Set a breakpoint at `scripts/player.gd:42`, continue execution, and show stack trace when hit."

### Runtime testing
- "Press `ui_accept`, move mouse to (400, 300), click, then capture a screenshot."
- "Inspect live scene tree and report nodes with missing scripts or invalid references."

### Discovery & dynamic groups
- "Use `tool.catalog` with query `tilemap` and list the most relevant tools."
- "Activate the `dap` tool group for breakpoint debugging with `tool.groups`."
- "Find import pipeline tools with `tool.catalog` query `import` and run the best one for texture settings."
- "Reset all active tool groups with `tool.groups` to reduce context."

---

## Technical Reference

### Environment variables

| Name | Purpose | Default |
|---|---|---|
| `GOPEAK_TOOL_PROFILE` | Tool exposure profile: `compact`, `full`, `legacy` | `compact` |
| `MCP_TOOL_PROFILE` | Fallback profile env alias | `compact` |
| `GODOT_PATH` | Explicit Godot executable path | auto-detect |
| `GODOT_BRIDGE_PORT` | Bridge/Visualizer HTTP+WS port override (aliases: `MCP_BRIDGE_PORT`, `GOPEAK_BRIDGE_PORT`) | `6505` |
| `DEBUG` | Enable server debug logs (`true`/`false`) | `false` |
| `LOG_MODE` | Recording mode: `lite` or `full` | `lite` |
| `GOPEAK_TOOLS_PAGE_SIZE` | Number of tools per `tools/list` page (pagination) | `33` |
| `GOPEAK_BRIDGE_PORT` | Base bridge/visualizer port. Treated as a *base hint*: if busy, the server auto-allocates the next free port (multi-session) | `6505` |
| `GOPEAK_BRIDGE_HOST` | Bind host for bridge/visualizer server | `127.0.0.1` |
| `GOPEAK_PROJECT_PATH` | Pin the project this session serves (path-gating + discovery file). Auto-detected from cwd / launch args when unset | auto-detect |
| `GOPEAK_RUNTIME_PORT` | Base runtime-addon command-socket port (derives per session from the bridge offset) | `7777` |
| `GOPEAK_RUNTIME_BIND_HOST` | Bind host for the in-game runtime control socket. Loopback by default; `0.0.0.0` auto-selected in WSL→Windows mode so a WSL server can reach a Windows game | `127.0.0.1` |
| `GOPEAK_AUTO_LAUNCH_EDITOR` | Opt-in: when `1`, a bridge tool called with no editor connected auto-launches the editor for this session's bound project (requires `GOPEAK_PROJECT_PATH`/cwd). Off by default so headless/CI runs never spawn a GUI editor | `0` |
| `GOPEAK_AUTO_LAUNCH_TIMEOUT_MS` | How long auto-launch waits for the editor's MCP addon to connect before returning an error | `45000` |

### Ports

| Port | Service |
|---|---|
| `6505` (base) | Unified Godot Bridge + Visualizer server (+ `/health`, `/mcp`). Auto-allocated upward when busy |
| `6005` | Godot LSP (global editor setting — see multi-session note) |
| `6006` | Godot DAP (global editor setting — see multi-session note) |
| `7777` (base) | Runtime addon command socket (only needed for runtime tools). Per-session, derived from the bridge offset |

### Minimal port profiles

- **Core editing only**: bridge port (`GODOT_BRIDGE_PORT`, default `6505`)
- **Core + runtime actions (screenshots/input/runtime inspect)**: bridge port + `7777`
- **Full debugging + diagnostics**: bridge port + `6005` + `6006` + `7777`

### Multi-session / parallel worktrees

Multiple Claude/agent sessions can each drive their own Godot editor at the same time (e.g. testing
different game stages across git worktrees). Each gopeak instance:

- **Auto-allocates free ports** on startup — `GOPEAK_BRIDGE_PORT`/`GOPEAK_RUNTIME_PORT` are *base
  hints*; if the base is busy the next free port is chosen. The runtime + DAP-relay ports derive
  from the bridge offset, so a single session with free defaults still uses `6505`/`7777`/`6016`.
- **Writes a discovery file** `<project>/.gopeak/bridge.json` that the editor and runtime addons read
  to find this session's ports — zero manual config. **Add `.gopeak/` to your project's
  `.gitignore`** (it is per-machine/per-session). Resolution precedence in the addon:
  discovery file → env (`GOPEAK_BRIDGE_PORT`) → Project Settings → default. The discovery file
  outranks env because the env value is shared across all sessions.
- **Gates the bridge on the project path** — an editor whose `godot_ready` project doesn't match the
  one this session owns is rejected, so a stray editor can never hijack another session's connection.

**One-command per-worktree binding.** A shared *user-scope* `godot` server starts project-agnostic, so
it never writes a discovery file or gates its bridge — worktrees then collide on the default port. Run
`bash scripts/gen-worktree-mcp.sh` from a worktree root to write a project-scoped `.mcp.json` that pins
`GOPEAK_PROJECT_PATH` to that worktree and sets `GOPEAK_AUTO_LAUNCH_EDITOR=1` (overriding the user-scope
server there). Each worktree's agent then binds its own project + bridge port automatically, and a bridge
tool issued with **no editor open auto-launches one for that worktree** (waiting up to
`GOPEAK_AUTO_LAUNCH_TIMEOUT_MS`). Keep the generated `.mcp.json` out of git — it holds machine-specific
absolute paths.

**LSP (`6005`) and raw DAP (`6006`) are global Godot editor settings** with no per-instance override,
so when several editors run at once only the first to bind owns them; gopeak reports them as
unavailable rather than hanging. The DAP *relay* port (`6016` base, per-project) is isolated per
session. The core path — scene editing, run/stop/play/close game, runtime introspection, debug
output — is fully isolated per worktree.

---

## Troubleshooting

- **Godot not found** → set `GODOT_PATH`
- **No MCP tools visible** → restart your MCP client
- **Project path invalid** → confirm `project.godot` exists
- **Runtime tools not working** → install/enable runtime addon plugin
- **Need a tool that is not visible** → run `tool.catalog` to search and auto-activate matching groups, or use `tool.groups` to activate a specific group
- **`get_editor_status` says disconnected while the Godot editor shows connected** → the editor is connected to a *different* session's bridge. `get_editor_status` reports this session's `port` and `session_project_path`; confirm the editor's project matches and that `<project>/.gopeak/bridge.json` exists (multiple instances each auto-allocate their own port, so the editor must read the discovery file to find the right one). Reopen/reload the editor plugin to re-resolve.
- **Running a debug game and want to stop it / know if one is running** → `get_play_state` reports the in-editor Play-button game; `stop_playing_scene` stops it; `play_scene` starts it. `get_editor_status.editor_play_state` surfaces a game a human started. (These are distinct from `run_project`/`stop_project`, which manage a separate gopeak-spawned process.)
- **Auto-launch isn't opening an editor** → confirm `GOPEAK_AUTO_LAUNCH_EDITOR=1` *and* a project is bound (set `GOPEAK_PROJECT_PATH`, run `scripts/gen-worktree-mcp.sh`, or start the server from the project root). The error response's `autoLaunch` field tells you which: `disabled`, `enabled-but-no-bound-project`, `spawn-failed`, or `connect-timeout`. On `connect-timeout`, enable the "Godot MCP Editor" plugin in the project so the launched editor connects back, then retry.
- **(WSL) MCP server times out / needs `/mcp` reconnect on almost every fresh session** → you are launching the server from a `/mnt/c` (9p) path, whose slow `node_modules` load exceeds Claude Code's 30s `initialize` timeout. Run it from the native Linux filesystem instead — see [Installation → D) WSL](#d-wsl-windows-subsystem-for-linux--run-from-the-native-linux-filesystem)

---

## Docs & Project Links

- [Architecture (MCP Platform Direction)](docs/architecture.md)
- [Platform Roadmap (P1/P2/P3)](docs/platform-roadmap.md)
- [CHANGELOG](CHANGELOG.md)
- [ROADMAP](ROADMAP.md)
- [CONTRIBUTING](CONTRIBUTING.md)

---

## License

MIT — see [LICENSE](LICENSE).

## Credits

- Original MCP server by [Coding-Solo](https://github.com/Coding-Solo/godot-mcp)
- GoPeak enhancements by [HaD0Yun](https://github.com/HaD0Yun)
- Project visualizer inspired by [tomyud1/godot-mcp](https://github.com/tomyud1/godot-mcp)
