---
status: active
task: finish + land the uncommitted TileMapLayer support in set_tilemap_cells (addon WIP)
branch: wsl-windows-compat
---

# Handoff — TileMapLayer support in `set_tilemap_cells` (uncommitted addon WIP)

**For:** verify, test, and land the uncommitted `resource_tools.gd` change. This is the **only** loose end — the rest of the session is merged (see Context).
**Date:** 2026-06-16

## Context (everything else is DONE)
PR **#7 merged** into `fork/main` (merge commit `95da454`, on top of `6767abc`): upstream **v2.3.7** sync + server-side opt-in editor auto-launch (`GOPEAK_AUTO_LAUNCH_EDITOR`) + per-worktree `.mcp.json` generator (`scripts/gen-worktree-mcp.sh`) + test fixes. The ext4 deploy `~/gopeak-wsl/build/` was rebuilt to that state. Two deep review passes cleared it. **Do not re-open any of that.**

## The WIP (what this handoff is about)
Uncommitted in the working tree: `src/addon/godot_mcp_editor/tools/resource_tools.gd` (`+19/-12`, `git status` shows ` M`). It changes `set_tilemap_cells()` (`resource_tools.gd:249`) to support **both** tilemap node kinds, since Godot 4.3+ split `TileMap` into per-layer `TileMapLayer` nodes:
- Resolves the target as a generic `Node`, rejects unless `node is TileMapLayer or node is TileMap` (`:272`).
- Branches on `is_layer := node is TileMapLayer` (`:281`): `TileMapLayer.set_cell(coords, source_id, atlas_coords, alternative)` (no `layer` arg) vs deprecated `TileMap.set_cell(layer, coords, source_id, atlas_coords, alternative)`.

The diff reads clean and complete; the `set_cell` signatures match the Godot 4.6 API. It is **unverified and uncommitted**.

## Dead ends / non-issues
- Signatures are not the worry — they match the docs. The risk is runtime behaviour (node resolution for nested `node_path`, and that edits actually persist via `_save_scene_root`).

## Current uncertainty
- Has it been exercised against a **real** scene? No. Needs both a `TileMapLayer`-rooted/-child scene and a legacy `TileMap` scene.
- Should it carry a regression test? Probably — there is none for `set_tilemap_cells` today.

## Where to start
- Read: `src/addon/godot_mcp_editor/tools/resource_tools.gd:249-300` (the changed function). Diff: `git diff src/addon/godot_mcp_editor/tools/resource_tools.gd`.
- Base off the merged tip, not the stale local `main`: `git fetch fork && git switch -c fix/tilemaplayer-set-cells fork/main` (`fork/main` = `95da454`). The uncommitted edit is in the shared working tree, so it carries over to the new branch.
- Verify (addon must be synced into a live editor): call the MCP `set_tilemap_cells` tool against (a) a scene with a `TileMapLayer` node and (b) one with a legacy `TileMap`; reopen the saved `.tscn` and confirm the cells landed. `~/gopeak-wsl/build/addon` and consumer projects won't have this change until it's committed AND the addon re-synced (`install-addon.sh`).
- Next likely step: add a GUT/regression case, then commit + PR into `fork/main`.

## Next session prompt
```
Finish + land the TileMapLayer WIP in the gopeak-godot-mcp addon.
Read first: docs/handoffs/2026-06-16-tilemaplayer-set-cells-wip.md
State: src/addon/godot_mcp_editor/tools/resource_tools.gd has an UNCOMMITTED change to set_tilemap_cells() (line 249) adding Godot-4.3+ TileMapLayer support alongside deprecated TileMap. Clean-looking but unverified. Everything else this session is merged (PR #7 → fork/main = 95da454); do not touch it.
Next: branch off the merged tip — `git fetch fork && git switch -c fix/tilemaplayer-set-cells fork/main` (the uncommitted edit carries over). Verify set_tilemap_cells via the MCP tool against BOTH a TileMapLayer scene and a legacy TileMap scene (addon must be synced to a live editor); confirm cells persist after reopening the .tscn. Add a regression test if practical.
Verify: `git diff --stat src/addon/godot_mcp_editor/tools/resource_tools.gd` (expect: 1 file, +19/-12). Build sanity: `npm run ci` (expect: green).
Close-out: commit on the fix branch + open a PR into fork/main; flip this handoff to status: done and git mv it to docs/handoffs/archive/. Refresh THIS prompt before stopping.
```

## Suggested skills
- `godot-scene-ops` / `mcp-smoke` — drive + runtime-verify the `set_tilemap_cells` tool against real scenes.
- `gut-tracer-tdd` — add the missing regression test for both node kinds.
- `verify-before-done` + `finish-feature-branch` — gate the claim and run the close-out (commit, PR, handoff archive).
