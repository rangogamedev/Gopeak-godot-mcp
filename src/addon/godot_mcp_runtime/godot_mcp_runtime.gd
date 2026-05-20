@tool
extends EditorPlugin

## Godot MCP Runtime Plugin — EditorPlugin stub.
## Sole job: register the MCPRuntime autoload singleton at plugin load time.
## All runtime behavior (TCP server, scene-tree inspection, property/method
## calls, screenshots, input injection, signal watching) lives in the
## autoload `mcp_runtime_autoload.gd`, not in this file.


func _enter_tree() -> void:
	print("[MCP Runtime] Plugin loaded")
	add_autoload_singleton("MCPRuntime", "res://addons/godot_mcp_runtime/mcp_runtime_autoload.gd")


func _exit_tree() -> void:
	remove_autoload_singleton("MCPRuntime")
	print("[MCP Runtime] Plugin unloaded")
