extends Node

## MCP Runtime Autoload
## This singleton runs in the game and provides runtime inspection capabilities.
## It starts a TCP server that the MCP server can connect to.

const DEFAULT_PORT = 7777
const DEFAULT_BIND_HOST = "127.0.0.1"
const PROTOCOL_VERSION = "1.0"
const DISABLE_ENV = "GOPEAK_RUNTIME_DISABLED"
const PORT_ENV_KEYS: Array[String] = ["GOPEAK_RUNTIME_PORT", "GODOT_RUNTIME_PORT", "MCP_RUNTIME_PORT"]
const BIND_HOST_ENV_KEY = "GOPEAK_RUNTIME_BIND_HOST"
# Per-session discovery file written by the gopeak MCP server into the project.
# Lets a manually-launched game pick up this session's allocated runtime port
# and bind host without any env var (multi-worktree support).
const DISCOVERY_FILE = "res://.gopeak/bridge.json"

var _server: TCPServer
var _clients: Array[StreamPeerTCP] = []
var _port: int = DEFAULT_PORT
var _enabled: bool = true
var _watched_signals: Dictionary = {}  # { "node_path:signal_name": callable }

signal client_connected
signal client_disconnected
signal command_received(command: String, params: Dictionary)


func _ready() -> void:
	name = "MCPRuntime"
	_port = _resolve_port()
	_start_server()


## Resolve the runtime listen port. Resolution order:
##   0. Discovery file `res://.gopeak/bridge.json` (per-session, written by the
##      gopeak MCP server). Top precedence — a game launched via the editor
##      Play button inherits env from a manually-opened editor that does NOT
##      carry GOPEAK_RUNTIME_PORT, so the file is the reliable channel there.
##   1. Env keys (GOPEAK_RUNTIME_PORT/...); first valid integer wins (matches
##      resolveDefaultRuntimePort() in src/wsl_interop.ts).
##   2. DEFAULT_PORT (single-session / no discovery file).
## Invalid values emit a warning and fall through.
func _resolve_port() -> int:
	var discovery_port := _read_discovery_int("runtime_port")
	if discovery_port > 0:
		return discovery_port
	for key in PORT_ENV_KEYS:
		if not OS.has_environment(key):
			continue
		var raw := OS.get_environment(key).strip_edges()
		if raw.is_empty():
			continue
		if not raw.is_valid_int():
			push_warning("[MCP Runtime] Ignoring invalid %s=\"%s\" — expected integer 1-65535" % [key, raw])
			continue
		var parsed := int(raw)
		if parsed >= 1 and parsed <= 65535:
			return parsed
		push_warning("[MCP Runtime] Ignoring out-of-range %s=%d — expected integer 1-65535" % [key, parsed])
	return DEFAULT_PORT


## Resolve the address to bind the control socket to. Defaults to loopback for
## security (the socket accepts method calls + property writes). Resolution:
##   1. GOPEAK_RUNTIME_BIND_HOST env (set by gopeak to 0.0.0.0 in WSL→Windows
##      mode so a WSL gopeak can reach the Windows game via the host IP).
##   2. Discovery file `runtime_bind_host`.
##   3. 127.0.0.1 (loopback-only — superset of upstream's hardcoded fix,
##      WSL-safe because gopeak flips it to 0.0.0.0 only when needed).
func _resolve_bind_host() -> String:
	if OS.has_environment(BIND_HOST_ENV_KEY):
		var raw := OS.get_environment(BIND_HOST_ENV_KEY).strip_edges()
		if not raw.is_empty():
			return raw
	var discovery_host := _read_discovery_string("runtime_bind_host")
	if not discovery_host.is_empty():
		return discovery_host
	return DEFAULT_BIND_HOST


## Read the per-session discovery file (if present) as a Dictionary, else {}.
func _read_discovery_data() -> Dictionary:
	if not FileAccess.file_exists(DISCOVERY_FILE):
		return {}
	var f := FileAccess.open(DISCOVERY_FILE, FileAccess.READ)
	if f == null:
		return {}
	var raw := f.get_as_text()
	f.close()
	var parsed = JSON.parse_string(raw)
	if parsed is Dictionary:
		return parsed
	return {}


func _read_discovery_int(key: String) -> int:
	var data := _read_discovery_data()
	if not data.has(key):
		return 0
	var value := int(data[key])
	if value >= 1 and value <= 65535:
		return value
	return 0


func _read_discovery_string(key: String) -> String:
	var data := _read_discovery_data()
	if not data.has(key):
		return ""
	return str(data[key]).strip_edges()


func _process(_delta: float) -> void:
	if not _enabled or _server == null:
		return
	
	# Accept new connections
	if _server.is_connection_available():
		var client = _server.take_connection()
		if client:
			_clients.append(client)
			print("[MCP Runtime] Client connected")
			client_connected.emit()
			_send_welcome(client)
	
	# Process client messages
	var clients_to_remove: Array[StreamPeerTCP] = []
	for client in _clients:
		if client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			clients_to_remove.append(client)
			continue
		
		client.poll()
		if client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			clients_to_remove.append(client)
			continue
		var available = client.get_available_bytes()
		if available > 0:
			var data = client.get_utf8_string(available)
			_handle_message(client, data)
	
	# Remove disconnected clients
	for client in clients_to_remove:
		_clients.erase(client)
		print("[MCP Runtime] Client disconnected")
		client_disconnected.emit()


func _start_server() -> void:
	if OS.has_environment(DISABLE_ENV) and OS.get_environment(DISABLE_ENV) == "1":
		_enabled = false
		print("[MCP Runtime] Disabled by %s — passive mode (no port bind, no runtime calls)" % DISABLE_ENV)
		print("[MCP Runtime] To re-enable, unset %s (do NOT set it in shell rc files; restrict to hooks/CI scripts)" % DISABLE_ENV)
		return
	_server = TCPServer.new()
	var bind_host := _resolve_bind_host()
	var error = _server.listen(_port, bind_host)
	if error != OK:
		push_warning("[MCP Runtime] Bind failed on %s:%d (error %d) — passive mode (probably second Godot instance holding the port)" % [bind_host, _port, error])
		_enabled = false
		_server = null
	else:
		print("[MCP Runtime] Server listening on %s:%d" % [bind_host, _port])


func _send_welcome(client: StreamPeerTCP) -> void:
	var welcome = {
		"type": "welcome",
		"protocol_version": PROTOCOL_VERSION,
		"godot_version": Engine.get_version_info(),
		"project_name": ProjectSettings.get_setting("application/config/name", "Unknown")
	}
	_send_response(client, welcome)


func _handle_message(client: StreamPeerTCP, data: String) -> void:
	var json = JSON.new()
	var error = json.parse(data)
	if error != OK:
		_send_error(client, "Invalid JSON: " + json.get_error_message())
		return
	
	var message = json.get_data()
	if not message is Dictionary:
		_send_error(client, "Message must be an object")
		return
	
	var command = message.get("command", "")
	var params = message.get("params", {})
	var request_id = message.get("id", null)
	
	command_received.emit(command, params)
	
	var result = _execute_command(command, params)
	if request_id != null:
		result["id"] = request_id
	
	_send_response(client, result)


func _execute_command(command: String, params: Dictionary) -> Dictionary:
	match command:
		"ping":
			return {"type": "pong", "timestamp": Time.get_unix_time_from_system()}
		
		"get_tree":
			return _cmd_get_tree(params)
		
		"get_node":
			return _cmd_get_node(params)
		
		"set_property":
			return _cmd_set_property(params)
		
		"call_method":
			return _cmd_call_method(params)
		
		"get_metrics":
			return _cmd_get_metrics(params)
		
		"capture_screenshot":
			return _cmd_capture_screenshot(params)
		
		"capture_viewport":
			return _cmd_capture_viewport(params)
		
		"inject_action":
			return _cmd_inject_action(params)
		
		"inject_key":
			return _cmd_inject_key(params)
		
		"inject_mouse_click":
			return _cmd_inject_mouse_click(params)
		
		"inject_mouse_motion":
			return _cmd_inject_mouse_motion(params)
		
		"watch_signal":
			return _cmd_watch_signal(params)
		
		"unwatch_signal":
			return _cmd_unwatch_signal(params)
		
		_:
			return {"type": "error", "message": "Unknown command: " + command}


func _cmd_get_tree(params: Dictionary) -> Dictionary:
	var root_path = params.get("root", "/root")
	var max_depth = params.get("depth", 3)
	var include_properties = params.get("include_properties", false)
	
	var root = get_tree().root.get_node_or_null(root_path)
	if root == null:
		return {"type": "error", "message": "Node not found: " + root_path}
	
	return {
		"type": "tree",
		"root": _serialize_node_tree(root, 0, max_depth, include_properties)
	}


func _cmd_get_node(params: Dictionary) -> Dictionary:
	var node_path = params.get("path", "")
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}
	
	var node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}
	
	return {
		"type": "node",
		"data": _serialize_node(node, true)
	}


func _cmd_set_property(params: Dictionary) -> Dictionary:
	var node_path = params.get("path", "")
	var property = params.get("property", "")
	var value = params.get("value")
	
	if node_path.is_empty() or property.is_empty():
		return {"type": "error", "message": "Node path and property required"}
	
	var node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}
	
	var old_value = node.get(property)
	node.set(property, _deserialize_value(value))
	
	return {
		"type": "property_set",
		"path": node_path,
		"property": property,
		"old_value": _serialize_value(old_value),
		"new_value": _serialize_value(node.get(property))
	}


func _cmd_call_method(params: Dictionary) -> Dictionary:
	var node_path = params.get("path", "")
	var method = params.get("method", "")
	var args = params.get("args", [])
	
	if node_path.is_empty() or method.is_empty():
		return {"type": "error", "message": "Node path and method required"}
	
	var node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}
	
	if not node.has_method(method):
		return {"type": "error", "message": "Method not found: " + method}
	
	var deserialized_args = []
	for arg in args:
		deserialized_args.append(_deserialize_value(arg))
	
	var result = node.callv(method, deserialized_args)
	
	return {
		"type": "method_result",
		"path": node_path,
		"method": method,
		"result": _serialize_value(result)
	}


func _cmd_get_metrics(params: Dictionary) -> Dictionary:
	var metrics = params.get("metrics", [])
	var result = {
		"type": "metrics",
		"data": {}
	}
	
	# Always include basic metrics
	result["data"]["fps"] = Engine.get_frames_per_second()
	result["data"]["frame_time"] = Performance.get_monitor(Performance.TIME_PROCESS)
	result["data"]["physics_time"] = Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS)
	
	# Memory metrics
	result["data"]["memory_static"] = Performance.get_monitor(Performance.MEMORY_STATIC)
	result["data"]["memory_static_max"] = Performance.get_monitor(Performance.MEMORY_STATIC_MAX)
	
	# Object counts
	result["data"]["object_count"] = Performance.get_monitor(Performance.OBJECT_COUNT)
	result["data"]["object_resource_count"] = Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT)
	result["data"]["object_node_count"] = Performance.get_monitor(Performance.OBJECT_NODE_COUNT)
	result["data"]["object_orphan_node_count"] = Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT)
	
	# Render metrics
	result["data"]["render_total_objects"] = Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)
	result["data"]["render_total_primitives"] = Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)
	result["data"]["render_total_draw_calls"] = Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
	
	return result


func _cmd_capture_screenshot(params: Dictionary) -> Dictionary:
	var viewport = get_viewport()
	if viewport == null:
		return {"type": "error", "message": "No viewport available"}
	
	var viewport_texture = viewport.get_texture()
	if viewport_texture == null:
		return {"type": "error", "message": "No viewport texture available"}
	
	var image = viewport_texture.get_image()
	if image == null:
		return {"type": "error", "message": "Failed to capture viewport image"}
	
	var width = int(params.get("width", 0))
	var height = int(params.get("height", 0))
	if width > 0 and height > 0:
		image.resize(width, height)
	
	var png_bytes = image.save_png_to_buffer()
	if png_bytes.is_empty():
		return {"type": "error", "message": "Failed to encode screenshot as PNG"}
	
	var base64_str = Marshalls.raw_to_base64(png_bytes)
	
	return {
		"type": "screenshot",
		"format": "png",
		"encoding": "base64",
		"width": image.get_width(),
		"height": image.get_height(),
		"data": base64_str
	}


func _cmd_capture_viewport(params: Dictionary) -> Dictionary:
	return _cmd_capture_screenshot(params)


func _cmd_inject_action(params: Dictionary) -> Dictionary:
	var action = String(params.get("action", ""))
	var pressed = bool(params.get("pressed", true))
	var strength = float(params.get("strength", 1.0))
	
	if action.is_empty():
		return {"type": "error", "message": "Action name required"}
	
	if not InputMap.has_action(action):
		return {"type": "error", "message": "Action not found: " + action}
	
	var event = InputEventAction.new()
	event.action = action
	event.pressed = pressed
	event.strength = strength
	Input.parse_input_event(event)
	
	return {
		"type": "input_injected",
		"input_type": "action",
		"action": action,
		"pressed": pressed
	}


func _cmd_inject_key(params: Dictionary) -> Dictionary:
	var keycode = int(params.get("keycode", 0))
	var pressed = bool(params.get("pressed", true))
	var key_label = String(params.get("key_label", ""))
	
	var event = InputEventKey.new()
	event.pressed = pressed
	
	if not key_label.is_empty():
		event.keycode = OS.find_keycode_from_string(key_label)
		if event.keycode == KEY_NONE:
			return {"type": "error", "message": "Invalid key_label: " + key_label}
	elif keycode > 0:
		event.keycode = keycode
	else:
		return {"type": "error", "message": "keycode or key_label required"}
	
	Input.parse_input_event(event)
	
	return {
		"type": "input_injected",
		"input_type": "key",
		"keycode": event.keycode,
		"pressed": pressed
	}


func _cmd_inject_mouse_click(params: Dictionary) -> Dictionary:
	var position = params.get("position", Vector2.ZERO)
	var button = int(params.get("button", MOUSE_BUTTON_LEFT))
	var pressed = bool(params.get("pressed", true))
	
	if position is Array:
		if position.size() < 2:
			return {"type": "error", "message": "position array must contain [x, y]"}
		position = Vector2(float(position[0]), float(position[1]))
	elif position is Vector2:
		position = position
	else:
		return {"type": "error", "message": "position must be Vector2 or [x, y]"}
	
	var event = InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button
	event.pressed = pressed
	Input.parse_input_event(event)
	
	return {
		"type": "input_injected",
		"input_type": "mouse_click",
		"position": [position.x, position.y],
		"button": button,
		"pressed": pressed
	}


func _cmd_inject_mouse_motion(params: Dictionary) -> Dictionary:
	var position = params.get("position", Vector2.ZERO)
	var relative = params.get("relative", Vector2.ZERO)
	
	if position is Array:
		if position.size() < 2:
			return {"type": "error", "message": "position array must contain [x, y]"}
		position = Vector2(float(position[0]), float(position[1]))
	elif position is Vector2:
		position = position
	else:
		return {"type": "error", "message": "position must be Vector2 or [x, y]"}
	
	if relative is Array:
		if relative.size() < 2:
			return {"type": "error", "message": "relative array must contain [x, y]"}
		relative = Vector2(float(relative[0]), float(relative[1]))
	elif relative is Vector2:
		relative = relative
	else:
		return {"type": "error", "message": "relative must be Vector2 or [x, y]"}
	
	var event = InputEventMouseMotion.new()
	event.position = position
	event.global_position = position
	event.relative = relative
	Input.parse_input_event(event)
	
	return {
		"type": "input_injected",
		"input_type": "mouse_motion",
		"position": [position.x, position.y],
		"relative": [relative.x, relative.y]
	}


func _cmd_watch_signal(params: Dictionary) -> Dictionary:
	var node_path = params.get("path", "")
	var signal_name = params.get("signal", "")
	
	if node_path.is_empty() or signal_name.is_empty():
		return {"type": "error", "message": "Node path and signal name required"}
	
	var node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}
	
	if not node.has_signal(signal_name):
		return {"type": "error", "message": "Signal not found: " + signal_name}
	
	var key = node_path + ":" + signal_name
	if _watched_signals.has(key):
		return {"type": "error", "message": "Signal already being watched"}
	
	var callable = func(args = []):
		_broadcast_signal_event(node_path, signal_name, args)
	
	node.connect(signal_name, callable)
	_watched_signals[key] = callable
	
	return {
		"type": "signal_watched",
		"path": node_path,
		"signal": signal_name
	}


func _cmd_unwatch_signal(params: Dictionary) -> Dictionary:
	var node_path = params.get("path", "")
	var signal_name = params.get("signal", "")
	
	var key = node_path + ":" + signal_name
	if not _watched_signals.has(key):
		return {"type": "error", "message": "Signal not being watched"}
	
	var node = get_tree().root.get_node_or_null(node_path)
	if node != null:
		node.disconnect(signal_name, _watched_signals[key])
	
	_watched_signals.erase(key)
	
	return {
		"type": "signal_unwatched",
		"path": node_path,
		"signal": signal_name
	}


func _broadcast_signal_event(node_path: String, signal_name: String, args: Array) -> void:
	var event = {
		"type": "signal_event",
		"path": node_path,
		"signal": signal_name,
		"args": []
	}
	for arg in args:
		event["args"].append(_serialize_value(arg))
	
	for client in _clients:
		if client.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			_send_response(client, event)


func _serialize_node_tree(node: Node, depth: int, max_depth: int, include_properties: bool) -> Dictionary:
	var result = _serialize_node(node, include_properties)
	
	if depth < max_depth:
		var children = []
		for child in node.get_children():
			children.append(_serialize_node_tree(child, depth + 1, max_depth, include_properties))
		result["children"] = children
	
	return result


func _serialize_node(node: Node, include_properties: bool) -> Dictionary:
	var result = {
		"name": node.name,
		"type": node.get_class(),
		"path": str(node.get_path())
	}
	
	if node.get_script():
		result["script"] = node.get_script().resource_path
	
	if include_properties:
		result["properties"] = {}
		for prop in node.get_property_list():
			if prop["usage"] & PROPERTY_USAGE_STORAGE:
				var name = prop["name"]
				if not name.begins_with("_"):
					result["properties"][name] = _serialize_value(node.get(name))
	
	return result


func _serialize_value(value) -> Variant:
	if value == null:
		return null
	elif value is Vector2:
		return {"_type": "Vector2", "x": value.x, "y": value.y}
	elif value is Vector3:
		return {"_type": "Vector3", "x": value.x, "y": value.y, "z": value.z}
	elif value is Vector2i:
		return {"_type": "Vector2i", "x": value.x, "y": value.y}
	elif value is Vector3i:
		return {"_type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}
	elif value is Color:
		return {"_type": "Color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}
	elif value is Rect2:
		return {"_type": "Rect2", "position": _serialize_value(value.position), "size": _serialize_value(value.size)}
	elif value is Transform2D:
		return {"_type": "Transform2D", "origin": _serialize_value(value.origin), "x": _serialize_value(value.x), "y": _serialize_value(value.y)}
	elif value is NodePath:
		return {"_type": "NodePath", "path": str(value)}
	elif value is Resource:
		return {"_type": "Resource", "path": value.resource_path, "class": value.get_class()}
	elif value is Array:
		var arr = []
		for item in value:
			arr.append(_serialize_value(item))
		return arr
	elif value is Dictionary:
		var dict = {}
		for key in value:
			dict[str(key)] = _serialize_value(value[key])
		return dict
	elif value is Object:
		return {"_type": "Object", "class": value.get_class()}
	else:
		return value


func _deserialize_value(value) -> Variant:
	if value == null:
		return null
	elif value is Dictionary:
		if value.has("_type"):
			match value["_type"]:
				"Vector2":
					return Vector2(value.get("x", 0), value.get("y", 0))
				"Vector3":
					return Vector3(value.get("x", 0), value.get("y", 0), value.get("z", 0))
				"Vector2i":
					return Vector2i(value.get("x", 0), value.get("y", 0))
				"Vector3i":
					return Vector3i(value.get("x", 0), value.get("y", 0), value.get("z", 0))
				"Color":
					return Color(value.get("r", 0), value.get("g", 0), value.get("b", 0), value.get("a", 1))
				"NodePath":
					return NodePath(value.get("path", ""))
				_:
					return value
		else:
			var dict = {}
			for key in value:
				dict[key] = _deserialize_value(value[key])
			return dict
	elif value is Array:
		var arr = []
		for item in value:
			arr.append(_deserialize_value(item))
		return arr
	else:
		return value


func _send_response(client: StreamPeerTCP, data: Dictionary) -> void:
	var json_str = JSON.stringify(data) + "\n"
	client.put_utf8_string(json_str)


func _send_error(client: StreamPeerTCP, message: String) -> void:
	_send_response(client, {"type": "error", "message": message})


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_cleanup()


func _cleanup() -> void:
	for client in _clients:
		client.disconnect_from_host()
	_clients.clear()
	
	if _server:
		_server.stop()
		_server = null
	
	print("[MCP Runtime] Cleanup complete")
