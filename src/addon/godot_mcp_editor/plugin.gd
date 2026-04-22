@tool
extends EditorPlugin

const MCPEditorClientScript = preload("mcp_client.gd")
const MCPToolExecutorScript = preload("tool_executor.gd")
const McpDapRelayScript = preload("dap_relay.gd")

const SETTING_BRIDGE_HOST := "mcp/editor/bridge_host"
const SETTING_BRIDGE_PORT := "mcp/editor/bridge_port"
const SETTING_DAP_RELAY_ENABLED := "mcp/editor/dap_relay_enabled"
const SETTING_DAP_RELAY_PORT := "mcp/editor/dap_relay_port"
const DAP_RELAY_DEFAULT_PORT := 6016

var _mcp_client: Node
var _tool_executor: Node
var _dap_relay: Node
var _status_label: Label


func _enter_tree() -> void:
	_plugin_log("enter_tree_start")
	_register_project_settings()
	_plugin_log("project_settings_registered")

	_mcp_client = MCPEditorClientScript.new()
	_mcp_client.name = "MCPEditorClient"
	add_child(_mcp_client)

	_tool_executor = MCPToolExecutorScript.new()
	_tool_executor.name = "MCPToolExecutor"
	add_child(_tool_executor)
	_tool_executor.set_editor_plugin(self)

	_spawn_dap_relay_if_enabled()

	_mcp_client.connected.connect(_on_connected)
	_mcp_client.disconnected.connect(_on_disconnected)
	_mcp_client.tool_requested.connect(_on_tool_requested)

	_setup_status_indicator()
	_plugin_log("about_to_connect")
	_mcp_client.connect_to_server()
	_plugin_log("enter_tree_end")


func _plugin_log(kind: String) -> void:
	var line := "[%s] level=INFO source=plugin kind=%s" % [
		Time.get_datetime_string_from_system(true),
		kind,
	]
	print(line)
	var f := FileAccess.open("user://mcp_editor_client.log", FileAccess.READ_WRITE)
	if f == null:
		f = FileAccess.open("user://mcp_editor_client.log", FileAccess.WRITE)
	if f == null:
		return
	f.seek_end()
	f.store_line(line)
	f.close()


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

	if _dap_relay:
		_dap_relay.queue_free()
		_dap_relay = null

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

	# DAP relay — bridges the engine's hardcoded `127.0.0.1:6006` to
	# `0.0.0.0:<dap_relay_port>` so WSL clients can reach it without
	# a `netsh portproxy` rule. Opt-in per project.
	if not ProjectSettings.has_setting(SETTING_DAP_RELAY_ENABLED):
		ProjectSettings.set_setting(SETTING_DAP_RELAY_ENABLED, false)
	ProjectSettings.set_initial_value(SETTING_DAP_RELAY_ENABLED, false)
	ProjectSettings.add_property_info({
		"name": SETTING_DAP_RELAY_ENABLED,
		"type": TYPE_BOOL,
		"hint": PROPERTY_HINT_NONE,
		"hint_string": "Expose the Godot DAP server on 0.0.0.0:<dap_relay_port> via an in-editor TCP relay (WSL→Windows Godot workaround).",
	})

	if not ProjectSettings.has_setting(SETTING_DAP_RELAY_PORT):
		ProjectSettings.set_setting(SETTING_DAP_RELAY_PORT, DAP_RELAY_DEFAULT_PORT)
	ProjectSettings.set_initial_value(SETTING_DAP_RELAY_PORT, DAP_RELAY_DEFAULT_PORT)
	ProjectSettings.add_property_info({
		"name": SETTING_DAP_RELAY_PORT,
		"type": TYPE_INT,
		"hint": PROPERTY_HINT_RANGE,
		"hint_string": "1024,65535,1",
	})


func _spawn_dap_relay_if_enabled() -> void:
	var enabled: bool = ProjectSettings.get_setting(SETTING_DAP_RELAY_ENABLED, false)
	if not enabled:
		return
	var port: int = int(ProjectSettings.get_setting(SETTING_DAP_RELAY_PORT, DAP_RELAY_DEFAULT_PORT))
	_dap_relay = McpDapRelayScript.new(port)
	_dap_relay.name = "MCPDapRelay"
	add_child(_dap_relay)


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
