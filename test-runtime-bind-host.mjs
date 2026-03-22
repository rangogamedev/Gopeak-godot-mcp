import assert from 'node:assert/strict';
import fs from 'node:fs';

const expectedSnippet = 'listen(_port, "127.0.0.1")';
const files = [
  'src/addon/godot_mcp_runtime/mcp_runtime_autoload.gd',
  'build/addon/godot_mcp_runtime/mcp_runtime_autoload.gd',
];

for (const file of files) {
  const contents = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.match(
    contents,
    /listen\(_port,\s*"127\.0\.0\.1"\)/,
    `${file} must bind the runtime TCP server to localhost only (${expectedSnippet})`,
  );
}

console.log('runtime bind host regression checks passed');
