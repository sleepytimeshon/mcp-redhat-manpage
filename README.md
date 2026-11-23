# mcp-redhat-manpage

An [MCP](https://modelcontextprotocol.io/) server for RHEL man pages. Lets AI assistants look up configuration parameter defaults, syntax, and supported options from the actual man pages shipped with each RHEL major version.

## Tools

| Tool | Description |
|------|-------------|
| `getManPage` | Get the content of a man page for a specific RHEL version (paginated) |
| `searchManPages` | Search across all man pages for a keyword or regex pattern, with context lines |
| `compareVersions` | Compare a man page between two RHEL versions to detect parameter changes |
| `listManPages` | List available man pages, optionally filtered by name pattern |

## Pagination

`getManPage` accepts optional `offset` (default 0) and `limit` (default 30000) parameters to chunk large man pages — many RHEL config files (e.g. `sssd.conf(5)`, `nm-settings-dbus(5)`) exceed typical MCP tool-result token caps when returned whole. When a response is truncated, the output ends with a footer like:

```
[truncated: showing chars 0-30000 of 102783. Call again with offset=30000 for the next chunk.]
```

Pass that `offset` back to fetch the next chunk. Small pages return in one call.

## Prerequisites

- Node.js 18.14.1+

Man pages for RHEL 8, 9, and 10 are included via the [mcp-redhat-manpage-data](https://github.com/sleepytimeshon/mcp-redhat-manpage-data) dependency. No container runtime or manual extraction required.

## Configuration

No authentication required. The server reads man pages bundled in the data package.

### Pinning a version

The examples below run `npx -y mcp-redhat-manpage`, which fetches the latest published release each time the server starts. For operational use, pin a version so upgrades happen deliberately:

- Replace `mcp-redhat-manpage` in `args` with `mcp-redhat-manpage@<version>` (e.g. `mcp-redhat-manpage@0.2.3`), or
- Install it once with `npm install -g mcp-redhat-manpage@<version>` and use `mcp-redhat-manpage` as the `command` with no `args`.

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "redhat-manpage": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-manpage"]
    }
  }
}
```

### watsonx Orchestrate

```bash
orchestrate toolkits import --kind mcp \
  --name redhat-manpage \
  --description "RHEL Man Pages" \
  --command "npx -y mcp-redhat-manpage" \
  --tools "*"
```

### Claude Code

Claude Code reads MCP servers from `~/.claude.json` (user and local scopes) or a project's `.mcp.json`, not from `settings.json`.

To make the server available in every project, add it at user scope:

```bash
claude mcp add redhat-manpage --scope user -- npx -y mcp-redhat-manpage
```

To share it with a project instead, add it to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "redhat-manpage": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-manpage"]
    }
  }
}
```

Run `claude mcp list` to confirm the server connects.

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "redhat-manpage": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-redhat-manpage"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your workspace, or `~/.cursor/mcp.json` for all workspaces:

```json
{
  "mcpServers": {
    "redhat-manpage": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-manpage"]
    }
  }
}
```

To override the bundled man pages with a custom directory, set the `MANPAGES_DIR` environment variable.

## Releasing

Every push to `main` runs CI (`.github/workflows/ci.yml`): `npm ci`, a syntax check, and `npm test` on Node 18, 20, 22, and 24. `npm test` starts the server and checks that its tools match the tables in [Tools](#tools) and that it reports the `package.json` version.

To release, bump `version` in both `package.json` and the `McpServer` declaration in `src/index.js`, move the `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under a heading for the new version, then push to `main`. When that version is not yet on npm, CI publishes it with provenance through npm trusted publishing and creates a `vX.Y.Z` GitHub release. Pushes that keep the version only run the tests.

## Related MCP Servers

- [mcp-redhat-account](https://github.com/sleepytimeshon/mcp-redhat-account) - Account management
- [mcp-redhat-knowledge](https://github.com/sleepytimeshon/mcp-redhat-knowledge) - Knowledge Base search
- [mcp-redhat-manpage-data](https://github.com/sleepytimeshon/mcp-redhat-manpage-data) - Man page data (bundled as a dependency)
- [mcp-redhat-subscription](https://github.com/sleepytimeshon/mcp-redhat-subscription) - Subscription management
- [mcp-redhat-support](https://github.com/sleepytimeshon/mcp-redhat-support) - Support case management

## License

MIT
