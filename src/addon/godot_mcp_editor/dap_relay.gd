@tool
class_name McpDapRelay
extends Node

# TCP relay that exposes the Godot editor DAP server on an external
# interface. The engine binds DAP to `127.0.0.1:6006` in C++ and does
# not expose a `remote_host` setting, so WSL2 (NAT'd behind the
# vEthernet adapter) cannot reach it. This node accepts connections
# on `0.0.0.0:<listen_port>` inside the Godot editor process and
# pipes each one bidirectionally to `127.0.0.1:6006` on the same host
# where the editor runs. No admin prompt, no `netsh portproxy`.

const DEFAULT_LISTEN_PORT := 6016
const TARGET_HOST := "127.0.0.1"
const TARGET_PORT := 6006
const MAX_CHUNK_BYTES := 65536

var _listen_port: int
var _server: TCPServer
var _pairs: Array[Dictionary] = []


func _init(listen_port: int = DEFAULT_LISTEN_PORT) -> void:
	_listen_port = listen_port


func _ready() -> void:
	_server = TCPServer.new()
	var err: int = _server.listen(_listen_port, "0.0.0.0")
	if err != OK:
		push_error("[dap_relay] failed to listen on 0.0.0.0:%d (error %d)" % [_listen_port, err])
		_server = null
		return
	print("[dap_relay] listening on 0.0.0.0:%d → %s:%d" % [_listen_port, TARGET_HOST, TARGET_PORT])


func _exit_tree() -> void:
	if _server != null:
		_server.stop()
		_server = null
	for pair: Dictionary in _pairs:
		_close_pair(pair)
	_pairs.clear()


func _process(_delta: float) -> void:
	if _server != null and _server.is_connection_available():
		_accept_new_connection()

	if _pairs.is_empty():
		return

	var still_alive: Array[Dictionary] = []
	for pair: Dictionary in _pairs:
		if _tick_pair(pair):
			still_alive.append(pair)
		else:
			_close_pair(pair)
	_pairs = still_alive


func _accept_new_connection() -> void:
	var client: StreamPeerTCP = _server.take_connection()
	if client == null:
		return
	var upstream: StreamPeerTCP = StreamPeerTCP.new()
	var err: int = upstream.connect_to_host(TARGET_HOST, TARGET_PORT)
	if err != OK:
		push_warning("[dap_relay] upstream connect_to_host failed (error %d) — dropping client" % err)
		client.disconnect_from_host()
		return
	_pairs.append({ "client": client, "upstream": upstream })
	print_verbose("[dap_relay] new connection paired (total=%d)" % _pairs.size())


func _tick_pair(pair: Dictionary) -> bool:
	var client: StreamPeerTCP = pair["client"]
	var upstream: StreamPeerTCP = pair["upstream"]
	client.poll()
	upstream.poll()

	var client_status: int = client.get_status()
	var upstream_status: int = upstream.get_status()

	if client_status != StreamPeerTCP.STATUS_CONNECTED:
		return false
	if upstream_status != StreamPeerTCP.STATUS_CONNECTED and upstream_status != StreamPeerTCP.STATUS_CONNECTING:
		return false

	if upstream_status == StreamPeerTCP.STATUS_CONNECTED:
		_pump(client, upstream)
		_pump(upstream, client)
	return true


func _pump(src: StreamPeerTCP, dst: StreamPeerTCP) -> void:
	var available: int = src.get_available_bytes()
	if available <= 0:
		return
	var to_read: int = min(available, MAX_CHUNK_BYTES)
	var result: Array = src.get_partial_data(to_read)
	if result[0] != OK:
		return
	var bytes: PackedByteArray = result[1]
	if bytes.size() == 0:
		return
	var put_err: int = dst.put_data(bytes)
	if put_err != OK:
		push_warning("[dap_relay] put_data failed (error %d)" % put_err)


func _close_pair(pair: Dictionary) -> void:
	var client: StreamPeerTCP = pair.get("client")
	var upstream: StreamPeerTCP = pair.get("upstream")
	if client != null:
		client.disconnect_from_host()
	if upstream != null:
		upstream.disconnect_from_host()
