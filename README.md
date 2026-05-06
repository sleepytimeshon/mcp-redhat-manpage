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

- Node.js 18+

Man pages for RHEL 8, 9, and 10 are included via the [mcp-redhat-manpage-data](https://github.com/sleepytimeshon/mcp-redhat-manpage-data) dependency. No container runtime or manual extraction required.

## Configuration

No authentication required. The server reads man pages bundled in the data package.

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

Add to `~/.claude/settings.json`:

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

### VS Code / Cursor

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "redhat-manpage": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-redhat-manpage"]
    }
  }
}
```

To override the bundled man pages with a custom directory, set the `MANPAGES_DIR` environment variable.

## Related MCP Servers

- [mcp-redhat-account](https://github.com/sleepytimeshon/mcp-redhat-account) - Account management
- [mcp-redhat-knowledge](https://github.com/sleepytimeshon/mcp-redhat-knowledge) - Knowledge Base search
- [mcp-redhat-manpage-data](https://github.com/sleepytimeshon/mcp-redhat-manpage-data) - Man page data (bundled as a dependency)
- [mcp-redhat-subscription](https://github.com/sleepytimeshon/mcp-redhat-subscription) - Subscription management
- [mcp-redhat-support](https://github.com/sleepytimeshon/mcp-redhat-support) - Support case management

## License

MIT
