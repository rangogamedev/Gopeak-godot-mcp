@tool
extends EditorPlugin

const MCPEditorClientScript = preload("mcp_client.gd")
const MCPToolExecutorScript = preload("tool_executor.gd")

const SETTING_BRIDGE_HOST := "mcp/editor/bridge_host"
const SETTING_BRIDGE_PORT := "mcp/editor/bridge_port"

var _mcp_client: Node
var _tool_executor: Node
var _status_label: Label


func _enter_tree() -> void:
	_register_project_settings()

	_mcp_client = MCPEditorClientScript.new()
	_mcp_client.name = "MCPEditorClient"
	add_child(_mcp_client)

	_tool_executor = MCPToolExecutorScript.new()
	_tool_executor.name = "MCPToolExecutor"
	add_child(_tool_executor)
	_tool_executor.set_editor_plugin(self)

	_mcp_client.connected.connect(_on_connected)
	_mcp_client.disconnected.connect(_on_disconnected)
	_mcp_client.tool_requested.connect(_on_tool_requested)

	_setup_status_indicator()
	_mcp_client.connect_to_server()


func _exit_tree() -> void:
	if _mcp_client:
		if _mcp_client.connected.is_connected(_on_connected):
			_mcp_client.connected.disconnect(_on_connected)
		if _mcp_client.disconnected.is_connected(_on_disconnected):
			_mcp_client.disconnected.disconnect(_on_disconnected)
		if _mcp_client.tool_requested.is_connected(_on_tool_requested):
			_mcp_client.tool_requested.disconnect(_on_tool_requested)
		_mcp_client.disconnect_from_server()
		_mcp_client.queue_free()
		_mcp_client = null

	if _tool_executor:
		_tool_executor.queue_free()
		_tool_executor = null

	if _status_label:
		remove_control_from_container(CONTAINER_TOOLBAR, _status_label)
		_status_label.queue_free()
		_status_label = null


func _setup_status_indicator() -> void:
	_status_label = Label.new()
	_status_label.text = "MCP: Connecting..."
	_status_label.add_theme_color_override("font_color", Color.YELLOW)
	_status_label.add_theme_font_size_override("font_size", 12)
	add_control_to_container(CONTAINER_TOOLBAR, _status_label)


func _on_connected() -> void:
	if _status_label:
		_status_label.text = "MCP: Connected"
		_status_label.add_theme_color_override("font_color", Color.GREEN)


func _on_disconnected() -> void:
	if _status_label:
		_status_label.text = "MCP: Disconnected"
		_status_label.add_theme_color_override("font_color", Color.RED)


func _register_project_settings() -> void:
	# Surface bridge host/port in Project Settings UI with sensible defaults.
	# Designers can override per-project (e.g. point at the WSL host IP when
	# Godot runs on Windows and the bridge binds on a WSL interface).
	if not ProjectSettings.has_setting(SETTING_BRIDGE_HOST):
		ProjectSettings.set_setting(SETTING_BRIDGE_HOST, "localhost")
	ProjectSettings.set_initial_value(SETTING_BRIDGE_HOST, "localhost")
	ProjectSettings.add_property_info({
		"name": SETTING_BRIDGE_HOST,
		"type": TYPE_STRING,
		"hint": PROPERTY_HINT_NONE,
		"hint_string": "Host the MCP editor bridge should connect to (default: localhost).",
	})

	if not ProjectSettings.has_setting(SETTING_BRIDGE_PORT):
		ProjectSettings.set_setting(SETTING_BRIDGE_PORT, 6505)
	ProjectSettings.set_initial_value(SETTING_BRIDGE_PORT, 6505)
	ProjectSettings.add_property_info({
		"name": SETTING_BRIDGE_PORT,
		"type": TYPE_INT,
		"hint": PROPERTY_HINT_RANGE,
		"hint_string": "1,65535,1",
	})


func _on_tool_requested(request_id: String, tool_name: String, args: Dictionary) -> void:
	if _tool_executor == null or _mcp_client == null:
		return

	var result: Dictionary = _tool_executor.execute_tool(tool_name, args)
	var success: bool = result.get("ok", false)

	if success:
		var payload := result.duplicate(true)
		payload.erase("ok")
		_mcp_client.send_tool_result(request_id, true, payload, "")
	else:
		_mcp_client.send_tool_result(request_id, false, null, str(result.get("error", "Unknown error")))
