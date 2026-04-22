#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { WebSocket } from 'ws';
import { findJsonRpcResponse } from '../test-support/json-rpc.mjs';

const OPENAI_COMPATIBLE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve a TCP port.')));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function connectWebSocket(url) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout connecting to ${url}`));
    }, 3000);

    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const host = process.env.GOPEAK_BRIDGE_HOST || '127.0.0.1';
  const configuredPort = Number.parseInt(process.env.GOPEAK_BRIDGE_PORT || '', 10);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : await reservePort();

  const server = spawn(process.execPath, ['build/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GODOT_PATH: process.env.GODOT_PATH || process.execPath,
      GOPEAK_BRIDGE_PORT: String(port),
      GOPEAK_BRIDGE_HOST: host,
      GOPEAK_TOOL_PROFILE: 'compact',
    },
  });

  let stdout = '';
  let stderr = '';
  server.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const cleanup = async () => {
    if (server.exitCode === null) {
      server.stdin.end();
      server.kill('SIGTERM');
      await delay(250);
    }
  };

  const send = (payload) => {
    server.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const PROMPTS_LIST_ID = 2;
  const TOOLS_LIST_ID = 3;

  // Cold-start budget — see scripts/smoke-test.mjs comment block below.
  // On WSL targeting a Windows Godot exe, the first JSON-RPC response
  // can take 10-12s because libuv holds child stderr until stdin
  // activity and Windows binfmt_misc + Defender scanning stretch the
  // initial `execFileAsync(godot, --version)`. On native-Linux CI it
  // clears in well under a second. A 20s per-response cap covers both.
  const RESPONSE_TIMEOUT_MS = Number.parseInt(process.env.GOPEAK_SMOKE_RESPONSE_TIMEOUT_MS ?? '', 10) || 20000;
  const POLL_INTERVAL_MS = 100;

  const waitForResponse = async (id, label) => {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) {
        throw new Error(`server exited early while waiting for ${label}: ${stderr || '(no stderr)'}`);
      }
      const found = findJsonRpcResponse(stdout, id);
      if (found) return found;
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(`missing ${label} response (waited ${RESPONSE_TIMEOUT_MS}ms)`);
  };

  try {
    await delay(500);
    if (server.exitCode !== null) {
      throw new Error(`server exited early: ${stderr || '(no stderr)'}`);
    }

    stdout = '';
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ci-smoke', version: '1.0.0' },
      },
    });

    const init = await waitForResponse(1, 'initialize');
    if (!init.result?.capabilities?.prompts) {
      throw new Error('missing prompts capability');
    }

    stdout = '';
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: PROMPTS_LIST_ID, method: 'prompts/list', params: {} });

    const prompts = await waitForResponse(PROMPTS_LIST_ID, 'prompts/list');
    if (!prompts.result.prompts || prompts.result.prompts.length < 2) {
      throw new Error('missing prompts/list response');
    }

    stdout = '';
    send({ jsonrpc: '2.0', id: TOOLS_LIST_ID, method: 'tools/list', params: {} });

    const tools = await waitForResponse(TOOLS_LIST_ID, 'tools/list');
    if (!tools.result.tools || tools.result.tools.length === 0) {
      throw new Error('missing tools/list response');
    }
    const invalidToolNames = tools.result.tools
      .map((tool) => tool?.name)
      .filter((name) => typeof name !== 'string' || !OPENAI_COMPATIBLE_TOOL_NAME_PATTERN.test(name));
    if (invalidToolNames.length > 0) {
      throw new Error(`tools/list exposed invalid OpenAI-compatible tool names: ${invalidToolNames.join(', ')}`);
    }

    await connectWebSocket(`ws://${host}:${port}/visualizer`);
    await connectWebSocket(`ws://${host}:${port}/godot`);

    console.log(`ci smoke passed with ${tools.result.tools.length} tools on ${host}:${port}`);
    await cleanup();
  } catch (error) {
    await cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
