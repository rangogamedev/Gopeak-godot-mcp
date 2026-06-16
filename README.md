# GoPeak

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white 'Node.js')](https://nodejs.org/en/download/)
[![npm](https://img.shields.io/npm/v/gopeak?style=flat&logo=npm&logoColor=white 'npm')](https://www.npmjs.com/package/gopeak)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)

🌐 **Languages**: **English** | [한국어](README-ko.md) | [日本語](README-ja.md) | [Deutsch](README-de.md) | [Português](README-pt_BR.md) | [简体中文](README-zh.md)

![GoPeak Hero](assets/gopeak-hero-v2.png)

**GoPeak is an MCP server for Godot 4 that gives AI assistants a real edit → run → inspect → fix loop.**

It is designed for trusted Godot 4 workflows: small default tool surface, setup-gated advanced capabilities, and explicit compatibility rules for older/legacy tool names.

> English is the canonical source of truth. Localized READMEs are concise overviews and may lag behind `README.md`.
>
> Discord is temporarily unavailable while the invite link is refreshed. Use [GitHub Discussions](https://github.com/HaD0Yun/Gopeak-godot-mcp/discussions) for now.

---

## Quick Start

### Requirements

- Godot 4.x
- Node.js 18+
- MCP-compatible client such as Claude Desktop, Cursor, Cline, or OpenCode

### 1) Run GoPeak

```bash
npx -y gopeak
```

or install globally:

```bash
npm install -g gopeak
gopeak
```

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

`compact` is the default profile. It keeps the initial MCP context small and exposes additional setup-gated groups only when requested.

### 3) Try these prompts

- "List Godot projects in `/your/projects` and show project info."
- "Create `scenes/Player.tscn` with a `CharacterBody2D` root and a movement script."
- "Run the project, read the debug output, and fix the top error."
- "Use `tool.catalog` to find animation tools, then activate the right group."

---

## What You Get

| Workflow | What GoPeak can do |
|---|---|
| Project control | Find projects, launch the editor, run/stop the game, collect debug output. |
| Scene + script editing | Create scenes, add nodes, edit typed properties, create/modify GDScript. |
| Resource workflows | Work with resources, materials, shaders, imports, and export-related checks. |
| Debugging | Use logs, Godot LSP diagnostics, DAP breakpoints/stack traces, and runtime inspection when configured. |
| Runtime testing | Capture screenshots, inspect live trees, inject input, and call runtime methods through the addon. |
| Tool discovery | Keep the default surface compact, then activate capability groups with `tool.catalog` or `tool.groups`. |

### Setup gates

Some capabilities require extra Godot-side services. GoPeak labels these instead of pretending everything is always available:

| Capability | Requires |
|---|---|
| Editor bridge scene/resource edits | `godot_mcp_editor` plugin enabled in the Godot project. |
| Runtime inspection, screenshots, input injection | Runtime addon/socket, default port `7777`. |
| GDScript LSP tools | Godot LSP enabled on port `6005`. |
| DAP debugging tools | Godot DAP enabled on port `6006`. |
| Asset store/provider tools | Network access and provider availability. |

---

## Add the Godot Plugins

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
| `tilemap` | 2 | TileSet and TileMap cell painting |
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

Then enable plugins in **Project Settings → Plugins**:

- `godot_mcp_editor` for bridge-backed scene/resource tools
- `godot_mcp_runtime` for runtime inspection, screenshots, and input workflows

Optional shell hooks for update notifications are opt-in:

```bash
gopeak setup
```

`gopeak setup` only modifies supported bash/zsh rc files when you run it explicitly. `npm install` does not install shell hooks automatically.

---

## Tool Profiles

GoPeak supports three exposure profiles:

| Profile | Use when |
|---|---|
| `compact` | Default. Trusted core tools plus dynamic groups activated on demand. |
| `full` | Compatibility/audit mode for the full legacy surface. |
| `legacy` | Older config alias with the same exposed behavior as `full`. |

Set either `GOPEAK_TOOL_PROFILE` or the fallback alias `MCP_TOOL_PROFILE`.

### Dynamic groups

In compact mode, search with `tool.catalog`; matching groups auto-activate. You can also manage groups directly with `tool.groups`.

Common groups:

| Group | Status | Notes |
|---|---|---|
| `runtime` | optional-runtime | Live scene tree, properties, method calls, metrics. Requires runtime addon/socket. |
| `testing` | optional-runtime | Screenshots, viewport capture, input injection. Requires runtime/editor setup. |
| `lsp` | optional-lsp | Diagnostics, completion, hover, symbols. Requires Godot LSP on port `6005`. |
| `dap` | optional-dap | Breakpoints, stepping, stack traces. Requires Godot DAP on port `6006`. |
| `asset_store` | optional-network | External CC0 asset search/download. Network/provider dependent. |
| `class_advanced` | trusted-static | ClassDB/inheritance discovery backed by static engine metadata. |
| `tilemap` | audit-required | Must account for Godot 4.3+ `TileMapLayer` behavior before promotion. |
| mutation groups | audit-required | Scene/resource/script/settings/signal/autoload/import/audio/navigation/theme/animation groups need fixture evidence before being marketed as fully trusted. |
| `intent_tracking` | workflow-layer | Workflow memory/handoff helpers, not a Godot engine primitive. Keep opt-in. |

If your MCP client does not refresh after activation, reconnect the client or call the newly activated tool once to force a fresh `tools/list` round-trip.

GoPeak also uses cursor-based pagination for `tools/list` so large profiles are not dumped into context at once. Tune it with `GOPEAK_TOOLS_PAGE_SIZE` when needed.

---

## Typed Godot Values

Bridge-backed scene tools such as `add_node` and `set_node_properties` accept common vector payloads for typed properties:

```json
{
  "position": { "type": "Vector2", "x": 100, "y": 200 },
  "scale": { "type": "Vector2", "x": 2, "y": 2 }
}
```

Plain `{ "x": 100, "y": 200 }` and `[100, 200]` are also coerced for common `Vector2` fields, but tagged values are safest across tools.

---

## Useful Commands

```bash
# run from npm
npx -y gopeak

# install globally
npm install -g gopeak

# run from source
git clone https://github.com/HaD0Yun/Gopeak-godot-mcp.git
cd Gopeak-godot-mcp
npm install
npm run build
node build/index.js

# local verification
npm run ci
npm run test:dynamic-groups
npm run test:metadata
npm run test:packaging
```

CLI bin names:

- `gopeak`
- `godot-mcp`

---

## Environment & Ports

| Name | Purpose | Default |
|---|---|---|
| `GOPEAK_TOOL_PROFILE` | Tool exposure profile: `compact`, `full`, `legacy` | `compact` |
| `MCP_TOOL_PROFILE` | Fallback profile env alias | `compact` |
| `GODOT_PATH` | Explicit Godot executable path | auto-detect |
| `GODOT_BRIDGE_PORT` | Bridge/Visualizer HTTP+WS port override | `6505` |
| `GOPEAK_BRIDGE_HOST` | Bridge/Visualizer bind host | `127.0.0.1` |
| `GOPEAK_TOOLS_PAGE_SIZE` | Number of tools per `tools/list` page | `33` |
| `GOPEAK_RUNTIME_TIMEOUT_MS` | Runtime addon command timeout in milliseconds | `10000` |
| `DEBUG` | Enable server debug logs | `false` |
| `LOG_MODE` | Recording mode: `lite` or `full` | `lite` |
| `GOPEAK_TOOLS_PAGE_SIZE` | Number of tools per `tools/list` page (pagination) | `33` |
| `GOPEAK_BRIDGE_PORT` | Base bridge/visualizer port. Treated as a *base hint*: if busy, the server auto-allocates the next free port (multi-session) | `6505` |
| `GOPEAK_BRIDGE_HOST` | Bind host for bridge/visualizer server | `127.0.0.1` |
| `GOPEAK_PROJECT_PATH` | Pin the project this session serves (path-gating + discovery file). Auto-detected from cwd / launch args when unset | auto-detect |
| `GOPEAK_RUNTIME_PORT` | Base runtime-addon command-socket port (derives per session from the bridge offset) | `7777` |
| `GOPEAK_RUNTIME_BIND_HOST` | Bind host for the in-game runtime control socket. Loopback by default; `0.0.0.0` auto-selected in WSL→Windows mode so a WSL server can reach a Windows game | `127.0.0.1` |

### Ports

| Port | Service |
|---|---|
| `6505` (base) | Unified Godot Bridge + Visualizer server (+ `/health`, `/mcp`). Auto-allocated upward when busy |
| `6005` | Godot LSP (global editor setting — see multi-session note) |
| `6006` | Godot DAP (global editor setting — see multi-session note) |
| `7777` (base) | Runtime addon command socket (only needed for runtime tools). Per-session, derived from the bridge offset |

Runtime screenshot tools (`capture_screenshot`, `capture_viewport`) use a GoPeak-managed temporary PNG file when the runtime addon supports `output_path`, then return normal MCP image content. Older runtime addons that do not receive an `output_path` continue to return inline base64 screenshots.

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
- **(WSL) MCP server times out / needs `/mcp` reconnect on almost every fresh session** → you are launching the server from a `/mnt/c` (9p) path, whose slow `node_modules` load exceeds Claude Code's 30s `initialize` timeout. Run it from the native Linux filesystem instead — see [Installation → D) WSL](#d-wsl-windows-subsystem-for-linux--run-from-the-native-linux-filesystem)
- **Runtime screenshots time out** → update the runtime addon so screenshot commands support the managed `output_path` flow. For slow runtime responses, raise `GOPEAK_RUNTIME_TIMEOUT_MS`; older addons may still time out on large inline base64 screenshots.
- **Editor bridge disconnected** → stop duplicate `gopeak`/MCP servers that may already own bridge port `6505`; `get_editor_status` reports bridge startup errors such as `EADDRINUSE`.

---

## Migration & Deprecation Policy

GoPeak treats `compact` as the safe default and `full`/`legacy` as compatibility profiles. Future hide, remove, rename, or API-contract changes must include:

1. old → new mapping or an explicit no-replacement note;
2. profile impact (`compact`, `full`, `legacy`, or opt-in group);
3. alias window and planned removal timing;
4. README/docs and release-note updates;
5. verification proving `tools/list` exposure and alias behavior;
6. migration prompt examples for common Godot workflows.

Current stance: legacy tool names and compact aliases remain supported. Optional external groups (`runtime`, `testing`, `lsp`, `dap`, `asset_store`) are setup-gated, not always-available core behavior.

Full policy: [docs/migration-policy.md](docs/migration-policy.md).

---

## More Docs

- [Documentation Map](docs/README.md)
- [Architecture](docs/architecture.md)
- [Migration Policy](docs/migration-policy.md)
- [Release Process](docs/release-process.md)
- [CHANGELOG](CHANGELOG.md)
- [ROADMAP](ROADMAP.md)
- [CONTRIBUTING](CONTRIBUTING.md)

---

## License & Credits

MIT — see [LICENSE](LICENSE).

- Original MCP server by [Coding-Solo](https://github.com/Coding-Solo/godot-mcp)
- GoPeak enhancements by [HaD0Yun](https://github.com/HaD0Yun)
- Project visualizer inspired by [tomyud1/godot-mcp](https://github.com/tomyud1/godot-mcp)
