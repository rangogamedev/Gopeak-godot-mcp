@tool
extends Node
class_name MCPToolExecutor

var _editor_plugin: EditorPlugin = null

var _scene_tools: Node = null
var _resource_tools: Node = null
var _animation_tools: Node = null

var _tool_map: Dictionary = {}
var _initialized := false


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin
	_init_tools()

	if _scene_tools and _scene_tools.has_method("set_editor_plugin"):
		_scene_tools.set_editor_plugin(plugin)
	if _resource_tools and _resource_tools.has_method("set_editor_plugin"):
		_resource_tools.set_editor_plugin(plugin)
	if _animation_tools and _animation_tools.has_method("set_editor_plugin"):
		_animation_tools.set_editor_plugin(plugin)


func _init_tools() -> void:
	if _initialized:
		return
	_initialized = true

	var base_path: String = get_script().resource_path.get_base_dir()
	var scene_tools_path := "%s/tools/scene_tools.gd" % base_path
	var resource_tools_path := "%s/tools/resource_tools.gd" % base_path
	var animation_tools_path := "%s/tools/animation_tools.gd" % base_path

	if ResourceLoader.exists(scene_tools_path):
		var scene_script: Script = load(scene_tools_path)
		if scene_script:
			_scene_tools = scene_script.new()
			_scene_tools.name = "SceneTools"
			add_child(_scene_tools)

	if ResourceLoader.exists(resource_tools_path):
		var resource_script: Script = load(resource_tools_path)
		if resource_script:
			_resource_tools = resource_script.new()
			_resource_tools.name = "ResourceTools"
			add_child(_resource_tools)

	if ResourceLoader.exists(animation_tools_path):
		var animation_script: Script = load(animation_tools_path)
		if animation_script:
			_animation_tools = animation_script.new()
			_animation_tools.name = "AnimationTools"
			add_child(_animation_tools)

	_tool_map = {
		# Scene tools
		"create_scene": [_scene_tools, "create_scene"],
		"list_scene_nodes": [_scene_tools, "list_scene_nodes"],
		"add_node": [_scene_tools, "add_node"],
		"delete_node": [_scene_tools, "delete_node"],
		"duplicate_node": [_scene_tools, "duplicate_node"],
		"reparent_node": [_scene_tools, "reparent_node"],
		"set_node_properties": [_scene_tools, "set_node_properties"],
		"get_node_properties": [_scene_tools, "get_node_properties"],
		"load_sprite": [_scene_tools, "load_sprite"],
		"save_scene": [_scene_tools, "save_scene"],
		"connect_signal": [_scene_tools, "connect_signal"],
		"disconnect_signal": [_scene_tools, "disconnect_signal"],
		"list_connections": [_scene_tools, "list_connections"],

		# Resource tools
		"create_resource": [_resource_tools, "create_resource"],
		"modify_resource": [_resource_tools, "modify_resource"],
		"create_material": [_resource_tools, "create_material"],
		"create_shader": [_resource_tools, "create_shader"],
		"create_tileset": [_resource_tools, "create_tileset"],
		"set_tilemap_cells": [_resource_tools, "set_tilemap_cells"],
		"set_theme_color": [_resource_tools, "set_theme_color"],
		"set_theme_font_size": [_resource_tools, "set_theme_font_size"],
		"apply_theme_shader": [_resource_tools, "apply_theme_shader"],

		# Animation tools
		"create_animation": [_animation_tools, "create_animation"],
		"add_animation_track": [_animation_tools, "add_animation_track"],
		"create_animation_tree": [_animation_tools, "create_animation_tree"],
		"add_animation_state": [_animation_tools, "add_animation_state"],
		"connect_animation_states": [_animation_tools, "connect_animation_states"],
		"create_navigation_region": [_animation_tools, "create_navigation_region"],
		"create_navigation_agent": [_animation_tools, "create_navigation_agent"],

		# Lifecycle tools
		"close_editor": [self, "_close_editor"],
		"get_fs_scanning_status": [self, "_get_fs_scanning_status"],

		# Debug-game (editor Play button) tools
		"get_play_state": [self, "_get_play_state"],
		"play_scene": [self, "_play_scene"],
		"stop_playing_scene": [self, "_stop_playing_scene"]
	}


## Report whether the editor is currently running a scene via the Play button.
## Returns { ok, is_playing, played_scene }. played_scene is "" when not
## playing or when the engine build predates EditorInterface.get_playing_scene
## (Godot 4.3+). This is the in-editor debug session — NOT a run_project child.
func _get_play_state(_args: Dictionary) -> Dictionary:
	var is_playing: bool = EditorInterface.is_playing_scene()
	var played := ""
	if is_playing and EditorInterface.has_method("get_playing_scene"):
		played = EditorInterface.get_playing_scene()
	return { "ok": true, "is_playing": is_playing, "played_scene": played }


## Start a scene in the editor (equivalent to the Play button).
## Args (optional):
##   scene_path (String): res:// path to play. Empty → play_main_scene();
##     otherwise → play_custom_scene(scene_path) (runs exactly that scene).
func _play_scene(args: Dictionary) -> Dictionary:
	var scene_path: String = str(args.get("scene_path", "")).strip_edges()
	if scene_path.is_empty():
		EditorInterface.play_main_scene()
		return { "ok": true, "play_mode": "main_scene" }
	# Always run the explicitly-named scene from disk via play_custom_scene so
	# the launched scene is exactly the one requested. play_current_scene() plays
	# the currently-edited tab, which may differ from scene_path and would
	# silently launch the wrong stage during multi-worktree testing.
	EditorInterface.play_custom_scene(scene_path)
	return { "ok": true, "play_mode": "custom_scene", "scene": scene_path }


## Stop the currently playing in-editor scene (equivalent to the Stop button).
## No-op when nothing is playing. Distinct from stop_project, which kills a
## run_project-spawned child process tracked by the MCP server.
func _stop_playing_scene(_args: Dictionary) -> Dictionary:
	if not EditorInterface.is_playing_scene():
		return { "ok": true, "was_playing": false, "note": "no scene was playing" }
	EditorInterface.stop_playing_scene()
	return { "ok": true, "was_playing": true }


## Probe the resource filesystem scanning state without side effects.
## Used by editor-status to report is_scanning to callers polling before
## a close_editor retry (after an fs_scanning refusal).
func _get_fs_scanning_status(_args: Dictionary) -> Dictionary:
	var fs := EditorInterface.get_resource_filesystem()
	if fs == null:
		return { "ok": true, "is_scanning": false, "note": "resource filesystem unavailable" }
	return { "ok": true, "is_scanning": fs.is_scanning() }


## Close the Godot Editor.
##
## Args (all optional):
##   force (bool):       Bypass ALL safety guards (fs_scanning, modal_open,
##                       writability pre-check) AND skip the auto-save-before-
##                       quit. WARNING: LOSES UNSAVED CHANGES. Default false.
##   save_first (bool):  Force the auto-save even when force=true.
##                       When force=false, save is the default — this flag is
##                       a no-op. When force=true + save_first=true, scenes
##                       ARE saved before quit (still skips other guards).
##                       Default false.
##
## Behavior (force=false / default — safe):
##   1. If resource filesystem is scanning/importing → refuse `fs_scanning`.
##      Quitting mid-scan can corrupt `.godot/`.
##   2. If a visible AcceptDialog/ConfirmationDialog is open → refuse
##      `modal_open`. The dialog likely needs user input we can't supply.
##   3. Walk EditorInterface.get_open_scenes(); check each path's writability
##      via FileAccess.open(path, READ_WRITE). If any are read-only → refuse
##      `save_blocked` with the blocked paths. Auto-save would silently fail
##      on these files and lose the work.
##   4. Call EditorInterface.save_all_scenes(). No-op on clean scenes; saves
##      dirty ones. Prevents silent data loss.
##   5. Reply ok:true, call_deferred the quit so the response flushes first.
##
## force=true bypasses 1+2+3 and the save. force=true + save_first=true still
## runs the save (mitigation; not a guard).
func _close_editor(args: Dictionary) -> Dictionary:
	var force: bool = bool(args.get("force", false))
	var save_first: bool = bool(args.get("save_first", false))

	var bypassed_guards: Array = []
	var actions_taken: Array = []

	# Guard 1: filesystem scanning / reimport in progress.
	var fs := EditorInterface.get_resource_filesystem()
	if fs != null and fs.is_scanning():
		if not force:
			return {
				"ok": false,
				"reason": "fs_scanning",
				"remediation": "wait for import to complete — poll mcp__godot__get-fs-scanning-status until is_scanning:false, then retry close_editor. OR retry with force=true (may corrupt .godot/ cache)"
			}
		bypassed_guards.append("fs_scanning")

	# Guard 2: visible modal dialog (AcceptDialog / ConfirmationDialog with visible=true).
	# Heuristic — Godot 4.6 exposes no direct "is modal active" API. We walk the editor's
	# base Control children for any visible AcceptDialog. Subset of true modals but covers
	# the common Save-As / quit-confirm / project-settings cases.
	var modal_paths: Array = []
	var base_control: Control = EditorInterface.get_base_control()
	if base_control != null:
		_collect_visible_modals(base_control, modal_paths, 3)
	if not modal_paths.is_empty():
		if not force:
			return {
				"ok": false,
				"reason": "modal_open",
				"modal_paths": modal_paths,
				"remediation": "dismiss the modal in the editor (Esc or click a button), OR retry with force=true to bypass"
			}
		bypassed_guards.append("modal_open")

	# Guard 3: writability pre-check on each open scene path. Catches the dominant
	# real-world save-failure case (read-only file on disk, file lock). Godot's
	# EditorInterface.save_all_scenes() returns void and swallows per-scene errors,
	# so we have to detect read-only state BEFORE the save.
	var open_scenes: PackedStringArray = EditorInterface.get_open_scenes()
	var save_blocked: Array = []
	for scene_path in open_scenes:
		var abs_path: String = ProjectSettings.globalize_path(scene_path)
		if not FileAccess.file_exists(abs_path):
			# New scene that hasn't been saved-to-disk yet; save_all_scenes will
			# either save it or prompt — we can't pre-check. Skip; covered by save_blocked
			# semantics when force=false (we won't quit until we know it's safe).
			save_blocked.append({ "path": scene_path, "reason": "new_scene_not_on_disk" })
			continue
		var probe := FileAccess.open(abs_path, FileAccess.READ_WRITE)
		if probe == null:
			save_blocked.append({ "path": scene_path, "reason": "not_writable", "error": str(FileAccess.get_open_error()) })
		else:
			probe.close()
	if not save_blocked.is_empty():
		if not force:
			return {
				"ok": false,
				"reason": "save_blocked",
				"paths": save_blocked,
				"remediation": "remove read-only attribute / file lock / save the new scene manually first, OR retry with force=true (WARNING: blocked scenes will NOT be saved before quit)"
			}
		bypassed_guards.append("save_blocked")

	# Auto-save (default ON; force=true skips unless save_first=true overrides).
	if not force or save_first:
		EditorInterface.save_all_scenes()
		actions_taken.append("save_all_scenes")
	else:
		bypassed_guards.append("save_all_scenes")

	# Defer the quit so this response can flush over the bridge first.
	call_deferred("_perform_editor_quit")

	var response: Dictionary = {
		"ok": true,
		"actions": actions_taken,
		"deferred_quit": true,
		"quit_stalled_hint": "poll editor-status.connected for up to 10s; escalate with force_kill if still connected"
	}
	if not bypassed_guards.is_empty():
		response["bypassed_guards"] = bypassed_guards
		response["warning"] = "guards bypassed via force=true; unsaved/blocked scenes were not protected"
	return response


## Recursively collect visible AcceptDialog descendants of `node` up to `max_depth`.
func _collect_visible_modals(node: Node, out: Array, max_depth: int) -> void:
	if max_depth <= 0:
		return
	for child in node.get_children():
		if child is AcceptDialog and child.visible:
			out.append(child.get_path())
		if child is Node:
			_collect_visible_modals(child, out, max_depth - 1)


func _perform_editor_quit() -> void:
	# get_tree().quit() in editor-plugin context terminates the editor process
	# after the current frame. Plugin tear-down runs normally; no save prompt.
	get_tree().quit()


func execute_tool(tool_name: String, args: Dictionary) -> Dictionary:
	if not _tool_map.has(tool_name):
		return {"ok": false, "error": "Unknown tool: " + tool_name}

	var handler: Array = _tool_map[tool_name]
	var node: Node = handler[0]
	var method: String = handler[1]

	if node == null:
		return {"ok": false, "error": "Tool handler unavailable: " + tool_name}

	if not node.has_method(method):
		return {"ok": false, "error": "Tool method not found: %s.%s" % [node.name, method]}

	var result = node.call(method, args)
	if result is Dictionary:
		return result

	return {"ok": false, "error": "Invalid tool result from: " + tool_name}
