#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from './build/godot-bridge.js';
import {
  getWSLInteropDetails,
  convertMountedPathToWindows,
  convertWindowsPathToMounted,
  translatePathForGodot,
  ensureWSLWindowsProjectPath,
  resolveWSLWindowsTempDir,
  resolveWindowsHostIp,
  resolveDefaultRuntimeHost,
  resolveDefaultDAPPort,
  normalizePathForCrossPlatformComparison,
  __resetWindowsHostIpCacheForTests,
} from './build/wsl_interop.js';
import { parseStartupActiveGroups } from './build/startup-active-groups.js';

const INDEX_SOURCE = readFileSync(new URL('./src/index.ts', import.meta.url), 'utf8');
const CLI_NOTIFY_SOURCE = readFileSync(new URL('./src/cli/notify.ts', import.meta.url), 'utf8');
const OPERATIONS_SOURCE = readFileSync(new URL('./src/scripts/godot_operations.gd', import.meta.url), 'utf8');
const RUNTIME_SOURCE = readFileSync(new URL('./src/addon/godot_mcp_runtime/mcp_runtime_autoload.gd', import.meta.url), 'utf8');
const TOOL_DEFS_SOURCE = readFileSync(new URL('./src/tool-definitions.ts', import.meta.url), 'utf8');
const TOOL_GROUPS_SOURCE = readFileSync(new URL('./src/tool-groups.ts', import.meta.url), 'utf8');
const TOOL_EXECUTOR_SOURCE = readFileSync(new URL('./src/addon/godot_mcp_editor/tool_executor.gd', import.meta.url), 'utf8');

function makeRequest(method, params, id) {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';
}

async function waitForJsonLine(stream, predicate, timeoutMs = 15000) {
  let buffer = '';
  const start = Date.now();

  return await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (predicate(parsed)) {
            cleanup();
            resolve(parsed);
            return;
          }
        } catch {
          // ignore partial/non-json lines
        }
      }

      if (Date.now() - start > timeoutMs) {
        cleanup();
        reject(new Error('Timed out waiting for JSON-RPC response'));
      }
    };

    const cleanup = () => {
      stream.off('data', onData);
    };

    stream.on('data', onData);
  });
}

async function withOccupiedBridgePort(run) {
  const blocker = createServer();
  const blockerState = await new Promise((resolve, reject) => {
    blocker.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        resolve({ alreadyOccupied: true });
        return;
      }
      reject(error);
    });
    blocker.listen(6505, '127.0.0.1', () => resolve({ alreadyOccupied: false }));
  });

  try {
    return await run();
  } finally {
    if (!blockerState.alreadyOccupied) {
      await new Promise((resolve, reject) => blocker.close((err) => (err ? reject(err) : resolve())));
    }
  }
}

class FakeSocket extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.readyState = 1;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

function resolveGodotPath() {
  const candidates = [
    process.env.GODOT_PATH,
    '/home/yun/.local/bin/godot4',
    '/home/yun/.local/bin/godot',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function testStaleDisconnectRegression() {
  const bridge = createBridge(0, 1000, '127.0.0.1');
  const first = new FakeSocket('first');
  const second = new FakeSocket('second');

  bridge.handleConnection(first);
  assert.equal(bridge.getStatus().connected, true, 'first socket should be connected');

  first.readyState = 3;
  bridge.handleConnection(second);
  assert.equal(bridge.getStatus().connected, true, 'second socket should be connected');

  first.emit('close', 1000, Buffer.from('late close from stale socket'));
  assert.equal(bridge.getStatus().connected, true, 'stale close must not disconnect the replacement socket');

  second.emit('close', 1000, Buffer.from('active socket closed'));
  assert.equal(bridge.getStatus().connected, false, 'active socket close should disconnect bridge');
}

function testSceneToolsVectorRegression() {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    console.log('scene tools vector regression skipped (Godot not found)');
    return;
  }

  const projectDir = mkdtempSync(join(tmpdir(), 'gopeak-regression-'));
  try {
    mkdirSync(join(projectDir, 'addons', 'godot_mcp_editor', 'tools'), { recursive: true });
    mkdirSync(join(projectDir, 'scenes'), { recursive: true });
    cpSync('src/addon/godot_mcp_editor/tools/scene_tools.gd', join(projectDir, 'addons', 'godot_mcp_editor', 'tools', 'scene_tools.gd'));

    writeFileSync(join(projectDir, 'project.godot'), `; Engine configuration file.\n; It's best edited using the editor.\nconfig_version=5\n\n[application]\nconfig/name="GopeakRegression"\n`);

    writeFileSync(join(projectDir, 'runner.gd'), `extends SceneTree\n\nfunc _fail(message: String) -> void:\n\tprinterr(message)\n\tquit(1)\n\nfunc _init() -> void:\n\tvar root := Node2D.new()\n\troot.name = "Root"\n\tvar packed := PackedScene.new()\n\tif packed.pack(root) != OK:\n\t\t_fail("failed to pack root scene")\n\t\treturn\n\tif ResourceSaver.save(packed, "res://scenes/Test.tscn") != OK:\n\t\t_fail("failed to save root scene")\n\t\treturn\n\troot.queue_free()\n\n\tvar scene_tools = load("res://addons/godot_mcp_editor/tools/scene_tools.gd").new()\n\tvar project_path := ProjectSettings.globalize_path("res://")\n\n\tvar add_result: Dictionary = scene_tools.add_node({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodeType": "Node2D",\n\t\t"nodeName": "TestNode",\n\t\t"parentNodePath": ".",\n\t\t"properties": {\n\t\t\t"position": {"x": 100, "y": 200},\n\t\t\t"scale": {"_type": "Vector2", "x": 2, "y": 2}\n\t\t}\n\t})\n\tif not add_result.get("ok", false):\n\t\t_fail("add_node failed: %s" % JSON.stringify(add_result))\n\t\treturn\n\n\tvar set_result: Dictionary = scene_tools.set_node_properties({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodePath": "TestNode",\n\t\t"properties": {\n\t\t\t"position": [300, 400]\n\t\t}\n\t})\n\tif not set_result.get("ok", false):\n\t\t_fail("set_node_properties failed: %s" % JSON.stringify(set_result))\n\t\treturn\n\n\tvar loaded := load("res://scenes/Test.tscn") as PackedScene\n\tif loaded == null:\n\t\t_fail("failed to reload saved scene")\n\t\treturn\n\n\tvar instance := loaded.instantiate()\n\tvar node := instance.get_node_or_null("TestNode") as Node2D\n\tif node == null:\n\t\t_fail("saved node missing")\n\t\treturn\n\n\tif node.position != Vector2(300, 400):\n\t\t_fail("position mismatch: %s" % node.position)\n\t\treturn\n\tif node.scale != Vector2(2, 2):\n\t\t_fail("scale mismatch: %s" % node.scale)\n\t\treturn\n\n\tprint(JSON.stringify({"ok": true, "position": [node.position.x, node.position.y], "scale": [node.scale.x, node.scale.y]}))\n\tinstance.queue_free()\n\tquit(0)\n`);

    const run = spawnSync(godotPath, ['--headless', '--path', projectDir, '--script', join(projectDir, 'runner.gd')], {
      encoding: 'utf8',
      timeout: 120000,
    });

    if (run.status !== 0) {
      throw new Error((run.stderr || run.stdout || `godot exited ${run.status}`).trim());
    }

    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /"ok"\s*:\s*true/, 'runner should report success JSON');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

async function testEditorStatusPortConflict() {
  await withOccupiedBridgePort(async () => {
    const proc = spawn(process.execPath, ['./build/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GOPEAK_TOOL_PROFILE: 'compact',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrChunks = [];
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));

    try {
      await delay(500);
      assert.equal(proc.exitCode, null, 'server should stay alive when the bridge port is occupied');

      proc.stdin.write(makeRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'regression-test', version: '1.0.0' },
      }, 1));
      await waitForJsonLine(proc.stdout, (msg) => msg.id === 1);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

      proc.stdin.write(makeRequest('tools/call', { name: 'get_editor_status', arguments: {} }, 2));
      const response = await waitForJsonLine(proc.stdout, (msg) => msg.id === 2);
      const payload = JSON.parse(response.result.content[0].text);
      assert.equal(payload.bridgeAvailable, false);
      assert.match(payload.startupError ?? '', /EADDRINUSE/i);
      assert.match(payload.note ?? '', /Another gopeak instance may own the editor bridge/i);
    } finally {
      proc.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        delay(2000),
      ]);
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }
  });
}

function testWSLInterop() {
  // convertMountedPathToWindows
  assert.equal(
    convertMountedPathToWindows('/mnt/c/Users/alice/proj'),
    'C:\\Users\\alice\\proj',
    'basic /mnt/c path translation'
  );
  assert.equal(
    convertMountedPathToWindows('/mnt/d/foo bar/baz'),
    'D:\\foo bar\\baz',
    'spaces preserved in path translation'
  );
  assert.equal(
    convertMountedPathToWindows('/mnt/C/WithCaps'),
    'C:\\WithCaps',
    'lowercase drive letter tolerated'
  );
  assert.equal(
    convertMountedPathToWindows('/home/user/proj'),
    null,
    'non-mounted path returns null'
  );
  assert.equal(
    convertMountedPathToWindows('/tmp/x'),
    null,
    '/tmp returns null'
  );

  // convertWindowsPathToMounted (the new inverse)
  assert.equal(
    convertWindowsPathToMounted('C:\\Users\\alice\\proj'),
    '/mnt/c/Users/alice/proj',
    'basic Windows→mounted translation'
  );
  assert.equal(
    convertWindowsPathToMounted('D:/foo/bar'),
    '/mnt/d/foo/bar',
    'forward-slash Windows path accepted'
  );
  assert.equal(
    convertWindowsPathToMounted('file:///C:/Users/alice/proj/foo.gd'),
    '/mnt/c/Users/alice/proj/foo.gd',
    'file:// URI translated'
  );
  assert.equal(
    convertWindowsPathToMounted('/home/user/x'),
    null,
    'non-Windows path returns null'
  );

  // ensureWSLWindowsProjectPath
  assert.throws(
    () => ensureWSLWindowsProjectPath('/home/user/proj'),
    /Windows Godot from WSL requires the project to live on \/mnt\/<drive>\//,
    'non-mounted project path throws with actionable message'
  );
  // mounted path should not throw
  ensureWSLWindowsProjectPath('/mnt/c/Users/alice/proj');

  // translatePathForGodot
  const nativeDetails = { isWSL: false, windowsTarget: false, mode: 'native' };
  assert.equal(
    translatePathForGodot('/home/user/x', nativeDetails, 'test'),
    '/home/user/x',
    'native mode passes path through unchanged'
  );
  const wslWindowsDetails = { isWSL: true, windowsTarget: true, mode: 'wsl_windows' };
  assert.equal(
    translatePathForGodot('/mnt/c/Users/alice/x', wslWindowsDetails, 'test'),
    'C:\\Users\\alice\\x',
    'wsl_windows mode translates mounted path'
  );
  assert.throws(
    () => translatePathForGodot('/home/user/x', wslWindowsDetails, 'script path'),
    /script path must be on a Windows-mounted path/,
    'wsl_windows mode rejects non-mounted path with labeled error'
  );

  // getWSLInteropDetails (surface-level shape check; actual isWSL is environmental)
  const nativeLinuxOnWinExe = getWSLInteropDetails('C:\\Godot\\Godot.exe');
  assert.equal(typeof nativeLinuxOnWinExe.mode, 'string', 'mode is a string');
  assert.equal(nativeLinuxOnWinExe.windowsTarget, true, '.exe path flagged as Windows target');

  const nativeLinuxOnLinuxExe = getWSLInteropDetails('/usr/bin/godot');
  assert.equal(
    nativeLinuxOnLinuxExe.windowsTarget,
    false,
    'Linux path not flagged as Windows target'
  );

  // resolveWSLWindowsTempDir — returns null when not wsl_windows
  assert.equal(
    resolveWSLWindowsTempDir(nativeDetails),
    null,
    'non-wsl_windows mode returns null'
  );

  // resolveWindowsHostIp — env override path
  __resetWindowsHostIpCacheForTests();
  const prevWslHostIp = process.env.WSL_HOST_IP;
  process.env.WSL_HOST_IP = '172.16.240.1';
  try {
    assert.equal(
      resolveWindowsHostIp(),
      '172.16.240.1',
      'WSL_HOST_IP env override honored'
    );
    // second call hits cache
    assert.equal(
      resolveWindowsHostIp(),
      '172.16.240.1',
      'cached value returned on second call'
    );
  } finally {
    if (prevWslHostIp === undefined) {
      delete process.env.WSL_HOST_IP;
    } else {
      process.env.WSL_HOST_IP = prevWslHostIp;
    }
    __resetWindowsHostIpCacheForTests();
  }

  // resolveDefaultRuntimeHost — env override path
  __resetWindowsHostIpCacheForTests();
  const prevRuntimeHost = process.env.GOPEAK_RUNTIME_HOST;
  process.env.GOPEAK_RUNTIME_HOST = '10.0.0.42';
  try {
    assert.equal(
      resolveDefaultRuntimeHost(),
      '10.0.0.42',
      'GOPEAK_RUNTIME_HOST env override honored'
    );
  } finally {
    if (prevRuntimeHost === undefined) {
      delete process.env.GOPEAK_RUNTIME_HOST;
    } else {
      process.env.GOPEAK_RUNTIME_HOST = prevRuntimeHost;
    }
    __resetWindowsHostIpCacheForTests();
  }
  // Without env + Linux godot path (forces wsl_linux / native mode) → loopback.
  __resetWindowsHostIpCacheForTests();
  const prevGodotPath = process.env.GODOT_PATH;
  process.env.GODOT_PATH = '/usr/bin/godot';
  try {
    assert.equal(
      resolveDefaultRuntimeHost(),
      '127.0.0.1',
      'runtime host falls back to 127.0.0.1 when no env + non-Windows target'
    );
  } finally {
    if (prevGodotPath === undefined) {
      delete process.env.GODOT_PATH;
    } else {
      process.env.GODOT_PATH = prevGodotPath;
    }
    __resetWindowsHostIpCacheForTests();
  }

  // resolveDefaultDAPPort — env override + fallback
  const prevDapPortEnvs = {
    GOPEAK_DAP_PORT: process.env.GOPEAK_DAP_PORT,
    GODOT_DAP_PORT: process.env.GODOT_DAP_PORT,
    MCP_DAP_PORT: process.env.MCP_DAP_PORT,
  };
  try {
    for (const key of Object.keys(prevDapPortEnvs)) {
      delete process.env[key];
    }
    assert.equal(resolveDefaultDAPPort(), 6006, 'DAP port defaults to 6006 with no env');

    process.env.GOPEAK_DAP_PORT = '6016';
    assert.equal(resolveDefaultDAPPort(), 6016, 'GOPEAK_DAP_PORT env override honored');
    delete process.env.GOPEAK_DAP_PORT;

    process.env.GODOT_DAP_PORT = '7016';
    assert.equal(resolveDefaultDAPPort(), 7016, 'GODOT_DAP_PORT env override honored');
    delete process.env.GODOT_DAP_PORT;

    process.env.MCP_DAP_PORT = '8016';
    assert.equal(resolveDefaultDAPPort(), 8016, 'MCP_DAP_PORT env override honored');
    delete process.env.MCP_DAP_PORT;

    process.env.GOPEAK_DAP_PORT = 'not-a-number';
    assert.equal(resolveDefaultDAPPort(), 6006, 'invalid DAP port env falls back to 6006');
    delete process.env.GOPEAK_DAP_PORT;

    process.env.GOPEAK_DAP_PORT = '99999';
    assert.equal(resolveDefaultDAPPort(), 6006, 'out-of-range DAP port env falls back to 6006');
    delete process.env.GOPEAK_DAP_PORT;
  } finally {
    for (const [key, value] of Object.entries(prevDapPortEnvs)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  // normalizePathForCrossPlatformComparison
  assert.equal(
    normalizePathForCrossPlatformComparison('C:\\Users\\alice\\proj\\foo.gd'),
    '/mnt/c/users/alice/proj/foo.gd',
    'Windows path normalized to mounted lowercase form'
  );
  assert.equal(
    normalizePathForCrossPlatformComparison('file:///C:/Users/alice/proj/foo.gd'),
    '/mnt/c/users/alice/proj/foo.gd',
    'file:// URI normalized to mounted lowercase form'
  );
  assert.equal(
    normalizePathForCrossPlatformComparison('/mnt/c/Users/Alice/Proj/Foo.gd'),
    '/mnt/c/users/alice/proj/foo.gd',
    'already-mounted path case-folded'
  );
  assert.equal(
    normalizePathForCrossPlatformComparison(
      normalizePathForCrossPlatformComparison('file:///C:/Users/alice/proj/foo.gd')
    ),
    normalizePathForCrossPlatformComparison('/mnt/c/Users/alice/proj/foo.gd'),
    'Windows URI and mounted path compare equal after normalize'
  );
}

function testStartupActiveGroups() {
  const known = ['dap', 'lsp', 'runtime', 'scene_advanced', 'uid'];

  // Unset / empty / whitespace → no-op.
  assert.deepEqual(parseStartupActiveGroups(undefined, known), { activated: [], unknown: [] });
  assert.deepEqual(parseStartupActiveGroups('', known), { activated: [], unknown: [] });
  assert.deepEqual(parseStartupActiveGroups('   ', known), { activated: [], unknown: [] });
  assert.deepEqual(parseStartupActiveGroups(',,,', known), { activated: [], unknown: [] });

  // Single valid group.
  assert.deepEqual(parseStartupActiveGroups('dap', known), { activated: ['dap'], unknown: [] });

  // Multiple valid groups, order preserved.
  assert.deepEqual(parseStartupActiveGroups('dap,lsp,runtime', known), {
    activated: ['dap', 'lsp', 'runtime'],
    unknown: [],
  });

  // Whitespace tolerated around commas + leading/trailing.
  assert.deepEqual(parseStartupActiveGroups('  dap , lsp ,  runtime ', known), {
    activated: ['dap', 'lsp', 'runtime'],
    unknown: [],
  });

  // Case-insensitive match returns canonical casing.
  assert.deepEqual(parseStartupActiveGroups('DAP,Lsp,Scene_Advanced', known), {
    activated: ['dap', 'lsp', 'scene_advanced'],
    unknown: [],
  });

  // Duplicate valid names collapse to one activation.
  assert.deepEqual(parseStartupActiveGroups('dap,dap,DAP', known), {
    activated: ['dap'],
    unknown: [],
  });

  // Unknown names split out, valid names still applied.
  assert.deepEqual(parseStartupActiveGroups('dap,bogus,lsp,alsoBogus', known), {
    activated: ['dap', 'lsp'],
    unknown: ['bogus', 'alsoBogus'],
  });

  // All unknown → empty activated, all captured in unknown.
  assert.deepEqual(parseStartupActiveGroups('foo,bar', known), {
    activated: [],
    unknown: ['foo', 'bar'],
  });

  // Empty items interleaved with valid names.
  assert.deepEqual(parseStartupActiveGroups(',dap,,lsp,', known), {
    activated: ['dap', 'lsp'],
    unknown: [],
  });
}

function testRuntimeBindGraceful() {
  // The env-gate constant is declared so consumers can grep for the canonical name.
  assert.match(
    RUNTIME_SOURCE,
    /const DISABLE_ENV = "GOPEAK_RUNTIME_DISABLED"/,
    'runtime autoload should declare DISABLE_ENV constant for the gate',
  );

  // _start_server short-circuits when env=="1" — explicit equality, no truthy-string semantics.
  assert.match(
    RUNTIME_SOURCE,
    /OS\.has_environment\(DISABLE_ENV\)\s+and\s+OS\.get_environment\(DISABLE_ENV\) == "1"/,
    'runtime autoload should gate _start_server on DISABLE_ENV == "1" (literal, no truthy match)',
  );

  // Passive mode print on the disabled path so users see why the runtime is silent.
  assert.match(
    RUNTIME_SOURCE,
    /Disabled by .* passive mode/,
    'runtime autoload should print a passive-mode notice when DISABLE_ENV is set',
  );

  // Helpful diagnostic so users know not to put the env in shell rc files.
  assert.match(
    RUNTIME_SOURCE,
    /do NOT set it in shell rc files/,
    'runtime autoload should warn against setting DISABLE_ENV in shell rc files',
  );

  // Bind failure is a WARNING, not an ERROR — smoke gates that fail on ERROR: lines stay clean.
  assert.match(
    RUNTIME_SOURCE,
    /push_warning\(\s*"\[MCP Runtime\] Bind failed/,
    'runtime autoload should emit push_warning (not push_error) on bind failure',
  );
  assert.doesNotMatch(
    RUNTIME_SOURCE,
    /push_error\(\s*"\[MCP Runtime\] (Failed to start server|Bind failed)/,
    'runtime autoload must NOT emit push_error on bind failure (would taint smoke gates)',
  );

  // Disabled-path nulls _server so _process early-return on `_server == null` covers it.
  assert.match(
    RUNTIME_SOURCE,
    /_enabled = false\s*\n\s*_server = null/,
    'runtime autoload should null _server alongside _enabled=false on bind failure (already guarded in _process)',
  );
}

function testEditorLifecycleTracking() {
  // editorProcess field declared on the server class.
  assert.match(
    INDEX_SOURCE,
    /private editorProcess: GodotEditorProcess \| null = null/,
    'editorProcess field should be declared (parallel to activeProcess) for editor lifecycle tracking',
  );

  // GodotEditorProcess type exists in shared types.
  // (Asserted by the compile step; double-check the import is wired in index.ts.)
  assert.match(
    INDEX_SOURCE,
    /GodotEditorProcess,/,
    'GodotEditorProcess type should be imported into index.ts',
  );

  // handleLaunchEditor saves the spawn handle.
  assert.match(
    INDEX_SOURCE,
    /this\.editorProcess = \{\s*process: editorChild,/,
    'handleLaunchEditor must save the spawned ChildProcess into this.editorProcess',
  );

  // process exit handler clears the field automatically (user-closed editor case).
  assert.match(
    INDEX_SOURCE,
    /editorChild\.on\('exit', \(\) => \{\s*if \(this\.editorProcess && this\.editorProcess\.process === editorChild\)/,
    'handleLaunchEditor must wire an exit handler that clears editorProcess when the editor dies externally',
  );

  // handleCloseEditor exists and uses both paths.
  assert.match(
    INDEX_SOURCE,
    /private async handleCloseEditor\(args: any\)/,
    'handleCloseEditor handler should exist',
  );
  assert.match(
    INDEX_SOURCE,
    /this\.godotBridge\.invokeTool\('close_editor'/,
    'handleCloseEditor should dispatch close_editor over the bridge (Path A)',
  );
  assert.match(
    INDEX_SOURCE,
    /tracked\.process\.kill\(signal\)/,
    'handleCloseEditor should kill the tracked process on fallback (Path B)',
  );

  // handleRestartEditor exists and polls for bridge state.
  assert.match(
    INDEX_SOURCE,
    /private async handleRestartEditor\(args: any\)/,
    'handleRestartEditor handler should exist',
  );

  // Status payload extended.
  assert.match(
    INDEX_SOURCE,
    /launched_by_mcp: launchedByMcp/,
    'getEditorStatusPayload should report launched_by_mcp',
  );
  assert.match(
    INDEX_SOURCE,
    /editor_pid: editorPid/,
    'getEditorStatusPayload should report editor_pid',
  );
  assert.match(
    INDEX_SOURCE,
    /launched_at: launchedAt/,
    'getEditorStatusPayload should report launched_at',
  );

  // Aliases registered for compact profile.
  assert.match(
    INDEX_SOURCE,
    /'editor\.close': 'close_editor'/,
    'compactAliasToLegacy should map editor.close → close_editor',
  );
  assert.match(
    INDEX_SOURCE,
    /'editor\.restart': 'restart_editor'/,
    'compactAliasToLegacy should map editor.restart → restart_editor',
  );

  // Dispatch switch covers the new tools.
  assert.match(
    INDEX_SOURCE,
    /case 'close_editor':\s*\n\s*return await this\.handleCloseEditor/,
    'tools dispatch switch should route close_editor to handleCloseEditor',
  );
  assert.match(
    INDEX_SOURCE,
    /case 'restart_editor':\s*\n\s*return await this\.handleRestartEditor/,
    'tools dispatch switch should route restart_editor to handleRestartEditor',
  );

  // Tool schemas exist.
  assert.match(
    TOOL_DEFS_SOURCE,
    /name: 'close_editor'/,
    'tool-definitions.ts should register close_editor schema',
  );
  assert.match(
    TOOL_DEFS_SOURCE,
    /name: 'restart_editor'/,
    'tool-definitions.ts should register restart_editor schema',
  );

  // Tool group updated.
  assert.match(
    TOOL_GROUPS_SOURCE,
    /'close_editor',\s*'restart_editor'/,
    'core_editor group should include close_editor + restart_editor',
  );

  // Addon-side handler exists with safety guards.
  assert.match(
    TOOL_EXECUTOR_SOURCE,
    /"close_editor": \[self, "_close_editor"\]/,
    'tool_executor.gd _tool_map should route close_editor → self._close_editor',
  );
  assert.match(
    TOOL_EXECUTOR_SOURCE,
    /func _close_editor\(args: Dictionary\) -> Dictionary/,
    '_close_editor handler should be defined',
  );
  assert.match(
    TOOL_EXECUTOR_SOURCE,
    /is_scanning\(\)/,
    '_close_editor should check the resource filesystem scanning guard',
  );
  assert.match(
    TOOL_EXECUTOR_SOURCE,
    /EditorInterface\.save_all_scenes\(\)/,
    '_close_editor should auto-save before quit unless force=true',
  );
  assert.match(
    TOOL_EXECUTOR_SOURCE,
    /call_deferred\("_perform_editor_quit"\)/,
    '_close_editor should defer the quit so the bridge response flushes first',
  );
  assert.match(
    TOOL_EXECUTOR_SOURCE,
    /func _perform_editor_quit\(\)[\s\S]*?get_tree\(\)\.quit\(\)/,
    '_perform_editor_quit should call get_tree().quit() to terminate the editor',
  );
}

async function main() {
  testStaleDisconnectRegression();
  testWSLInterop();
  testSceneToolsVectorRegression();
  testStartupActiveGroups();
  testRuntimeBindGraceful();
  testEditorLifecycleTracking();
  assert.match(INDEX_SOURCE, /key\.startsWith\('_'\)/, 'index.ts should preserve sentinel keys like _type during parameter normalization');
  assert.match(INDEX_SOURCE, /@file:/, 'index.ts should pass operation params via @file: temp payloads');
  assert.match(
    INDEX_SOURCE,
    /private async handleRunProject[\s\S]*?const cmdArgs = \[[^\]]*'--headless'[^\]]*'-d'[^\]]*'--path'[^\]]*args\.projectPath[^\]]*\]/,
    'run_project should launch Godot with --headless in handleRunProject cmdArgs',
  );
  assert.match(
    CLI_NOTIFY_SOURCE,
    /const wantsStar = await askYesNo\('[^']*Star GoPeak on GitHub\? \(y\/n\): '\);\s*\n\s*if \(wantsStar\) \{\s*\n\s*await handleStar\(\);/m,
    'star prompt should call handleStar only when the user accepts',
  );
  assert.match(OPERATIONS_SOURCE, /params_json\.begins_with\("@file:"\)/, 'godot_operations.gd should load params from @file: payloads');
  assert.match(
    RUNTIME_SOURCE,
    /client\.poll\(\)\s*\n\s*if client\.get_status\(\) != StreamPeerTCP\.STATUS_CONNECTED:\s*\n\s*clients_to_remove\.append\(client\)\s*\n\s*continue\s*\n\s*var available = client\.get_available_bytes\(\)/m,
    'runtime autoload should re-check socket status after poll() before get_available_bytes()',
  );
  assert.match(
    RUNTIME_SOURCE,
    /if params\.has\("x"\) and params\.has\("y"\):\s*\n\s*position = Vector2\(float\(params\["x"\]\), float\(params\["y"\]\)\)/m,
    'runtime input injection should accept flat x/y coordinates from the MCP tool schema',
  );
  assert.match(
    RUNTIME_SOURCE,
    /if params\.has\("relativeX"\) and params\.has\("relativeY"\):\s*\n\s*relative = Vector2\(float\(params\["relativeX"\]\), float\(params\["relativeY"\]\)\)/m,
    'runtime mouse motion should accept flat relativeX/relativeY coordinates from the MCP tool schema',
  );
  assert.match(
    RUNTIME_SOURCE,
    /func _resolve_mouse_button\(raw: Variant\) -> int:/,
    'runtime mouse injection should resolve string button names before assigning button_index',
  );
  assert.match(
    RUNTIME_SOURCE,
    /if keycode_raw is String and not \(keycode_raw as String\)\.is_empty\(\) and key_label\.is_empty\(\):\s*\n\s*key_label = keycode_raw as String/m,
    'runtime key injection should treat string keycode values as key labels',
  );

  await testEditorStatusPortConflict();
  console.log('regression tests passed');
}

await main();
