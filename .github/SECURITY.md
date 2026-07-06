# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in GoPeak, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email the maintainer or use [GitHub Security Advisories](https://github.com/HaD0Yun/godot-mcp/security/advisories/new)
3. Include steps to reproduce and potential impact

We will acknowledge receipt within 48 hours and provide a fix timeline.

## Security Considerations

- **Path Traversal**: MCP Resources (`godot://` URIs) include path traversal protection
- **Localhost Only**: Runtime addon TCP (port 7777), LSP (port 6005), and DAP (port 6006) connections are localhost-only
- **No Release Bind**: the runtime addon never binds its socket in release/export builds (`OS.is_debug_build()` gate); debug exports still bind so tester/`export-run` workflows keep runtime inspection
- **No Remote Execution**: All file operations are restricted to the Godot project directory
