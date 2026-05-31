@tool
extends Node
class_name MCPEditorClient

signal connected
signal disconnected
signal tool_requested(request_id: String, tool_name: String, args: Dictionary)

const DEFAULT_URL := "ws://127.0.0.1:6505/godot"
const DEFAULT_HOST := "127.0.0.1"
const DEFAULT_PORT := 6505
const SETTING_BRIDGE_HOST := "mcp/editor/bridge_host"
const SETTING_BRIDGE_PORT := "mcp/editor/bridge_port"
const RECONNECT_DELAY := 3.0
const MAX_RECONNECT_DELAY := 30.0
const LOG_PATH := "user://mcp_editor_client.log"

var socket: WebSocketPeer = WebSocketPeer.new()
var server_url: String = DEFAULT_URL
var _is_connected := false
# True between a successful `connect_to_url` and either STATE_OPEN (success) or
# STATE_CLOSED (the attempt failed before opening). Lets `_process` tell a failed
# *attempt* apart from an idle socket so it can re-arm the reconnect backoff.
var _connecting := false
var _reconnect_timer: Timer
var _current_reconnect_delay := RECONNECT_DELAY
var _should_reconnect := true
var _project_path: String
var _initialized := false


func _ready() -> void:
	_project_path = ProjectSettings.globalize_path("res://")

	_reconnect_timer = Timer.new()
	_reconnect_timer.one_shot = true
	_reconnect_timer.timeout.connect(_on_reconnect_timer)
	add_child(_reconnect_timer)

	set_process(true)
	_initialized = true
	_log("INFO", "ready", "project_path=%s" % _project_path)


# File logging — writes a single line per state change to
# `user://mcp_editor_client.log`. Under WSL, `user://` resolves to
# `%APPDATA%\Godot\app_userdata\<project>\` which is tailable from
# the Linux side via `/mnt/c/Users/.../app_userdata/.../`.
# Godot editor does not produce its own log file (only child project
# runs do) so this is the only reliable way to observe plugin state
# when the editor is running on Windows and Claude Code on WSL.
#
# File writes are gated behind the `GOPEAK_PLUGIN_LOG=1` env var so
# normal-dev users don't get a mystery log file. `print()` always
# fires so the Editor Output panel still shows state.
static func _log(level: String, kind: String, detail: String = "") -> void:
	var line := "[%s] level=%s source=mcp_client kind=%s %s" % [
		Time.get_datetime_string_from_system(true),
		level,
		kind,
		detail,
	]
	print(line)
	if OS.get_environment("GOPEAK_PLUGIN_LOG") != "1":
		return
	var f := FileAccess.open(LOG_PATH, FileAccess.READ_WRITE)
	if f == null:
		f = FileAccess.open(LOG_PATH, FileAccess.WRITE)
	if f == null:
		return
	f.seek_end()
	f.store_line(line)
	f.close()


func _process(_delta: float) -> void:
	if not _initialized:
		return

	if socket.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		_handle_closed_state()
		return

	socket.poll()

	match socket.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if not _is_connected:
				_handle_connect()

			while socket.get_available_packet_count() > 0:
				var packet := socket.get_packet()
				_handle_message(packet.get_string_from_utf8())

		WebSocketPeer.STATE_CLOSING:
			pass

		WebSocketPeer.STATE_CLOSED:
			_handle_closed_state()


# Centralised STATE_CLOSED handling. A socket reaches CLOSED either because an
# established connection dropped (`_is_connected`) or because a connection
# *attempt* failed before STATE_OPEN was ever reached (`_connecting`). The latter
# was previously a dead-end: `connect_to_url` returns OK, the socket goes
# CONNECTING -> CLOSED on a refused/dropped handshake (e.g. during a bridge
# ownership gap), and nothing rescheduled a reconnect — so the client went
# permanently silent until the editor was restarted. Both paths now re-arm the
# backoff timer; the `is_stopped()` guard preserves an already-running backoff
# and prevents rescheduling every frame.
func _handle_closed_state() -> void:
	if _is_connected:
		_handle_disconnect()
	elif _connecting and _should_reconnect:
		_connecting = false
		_log("WARN", "connect_failed", "url=%s socket closed before open" % server_url)
		if _reconnect_timer.is_stopped():
			_schedule_reconnect()


func connect_to_server(url: String = "") -> void:
	server_url = _resolve_server_url(url)
	_should_reconnect = true
	_current_reconnect_delay = RECONNECT_DELAY
	_attempt_connection()


func _resolve_server_url(explicit_url: String) -> String:
	if explicit_url != "":
		return explicit_url

	# Resolution order: ProjectSettings override → env override → default.
	# ProjectSettings is the designer-facing knob visible in Project Settings UI;
	# env vars remain as a non-editor override layer (CI, headless, ad-hoc).
	var host := DEFAULT_HOST
	if ProjectSettings.has_setting(SETTING_BRIDGE_HOST):
		var setting_host := str(ProjectSettings.get_setting(SETTING_BRIDGE_HOST)).strip_edges()
		if setting_host != "":
			host = setting_host

	var host_keys := ["GODOT_BRIDGE_HOST", "MCP_BRIDGE_HOST", "GOPEAK_BRIDGE_HOST"]
	for key in host_keys:
		var raw_host := OS.get_environment(key)
		if raw_host.strip_edges() != "":
			host = raw_host.strip_edges()
			break

	var port := DEFAULT_PORT
	if ProjectSettings.has_setting(SETTING_BRIDGE_PORT):
		var setting_port := int(ProjectSettings.get_setting(SETTING_BRIDGE_PORT))
		if setting_port >= 1 and setting_port <= 65535:
			port = setting_port

	var port_keys := ["GODOT_BRIDGE_PORT", "MCP_BRIDGE_PORT", "GOPEAK_BRIDGE_PORT"]
	for key in port_keys:
		var raw_port := OS.get_environment(key)
		if raw_port == "":
			continue
		if raw_port.is_valid_int():
			var parsed_port := int(raw_port)
			if parsed_port >= 1 and parsed_port <= 65535:
				port = parsed_port
				break

	return "ws://%s:%d/godot" % [host, port]


func disconnect_from_server() -> void:
	_should_reconnect = false
	_connecting = false
	if _reconnect_timer:
		_reconnect_timer.stop()
	if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		socket.close()
	_is_connected = false


func _attempt_connection() -> void:
	_log("INFO", "attempt", "url=%s" % server_url)
	if socket.get_ready_state() != WebSocketPeer.STATE_CLOSED:
		socket.close()

	var err := socket.connect_to_url(server_url)
	if err != OK:
		_connecting = false
		_log("ERROR", "connect_to_url_failed", "url=%s err=%d" % [server_url, err])
		push_error("[MCP Editor] Failed to connect: %s" % err)
		_schedule_reconnect()
	else:
		_connecting = true


func _handle_connect() -> void:
	_connecting = false
	_is_connected = true
	_current_reconnect_delay = RECONNECT_DELAY

	_send_message({
		"type": "godot_ready",
		"project_path": _project_path
	})

	_log("INFO", "connect", "url=%s" % server_url)
	connected.emit()


func _handle_disconnect() -> void:
	_is_connected = false
	var close_code := socket.get_close_code()
	var close_reason := socket.get_close_reason()
	_log("INFO", "disconnect", "code=%d reason=%s" % [close_code, close_reason])
	disconnected.emit()

	if _should_reconnect:
		_schedule_reconnect()


func _schedule_reconnect() -> void:
	if _reconnect_timer == null:
		_log("ERROR", "reconnect_timer_null", "cannot schedule reconnect")
		return
	_log("INFO", "backoff", "delay=%.1f next=%.1f" % [_current_reconnect_delay, min(_current_reconnect_delay * 2.0, MAX_RECONNECT_DELAY)])
	_reconnect_timer.start(_current_reconnect_delay)
	_current_reconnect_delay = min(_current_reconnect_delay * 2.0, MAX_RECONNECT_DELAY)


func _on_reconnect_timer() -> void:
	_log("INFO", "reconnect_timer_fired", "")
	_attempt_connection()


func _handle_message(json_string: String) -> void:
	var message = JSON.parse_string(json_string)
	if message == null:
		push_error("[MCP Editor] Failed to parse message: %s" % json_string)
		return

	match message.get("type", ""):
		"ping":
			_send_message({"type": "pong"})

		"tool_invoke":
			var request_id: String = message.get("id", "")
			var tool_name: String = message.get("tool", "")
			var args: Dictionary = message.get("args", {})
			tool_requested.emit(request_id, tool_name, args)

		_:
			pass


func send_tool_result(request_id: String, success: bool, result = null, error: String = "") -> void:
	var response := {
		"type": "tool_result",
		"id": request_id,
		"success": success
	}

	if success:
		response["result"] = result
	else:
		response["error"] = error

	_send_message(response)


func _send_message(message: Dictionary) -> void:
	if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		socket.send_text(JSON.stringify(message))


func is_connected_to_server() -> bool:
	return _is_connected
