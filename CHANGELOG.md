# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.5] - 2026-11-23

### Added
- Man pages from every RHEL BaseOS and AppStream package that ships them in sections 1, 5, 7, or 8, through `mcp-redhat-manpage-data` 0.2.1: about 11,000 pages per RHEL version instead of about 3,000 from 24 packages.
- A data test that exercises every tool against the installed man pages.
- This changelog and the MIT `LICENSE` file, included in the published package.

### Changed
- Pages are read through the reader API of `mcp-redhat-manpage-data` instead of from its files, so the data package can change its storage (now one compressed archive per RHEL version, with identical pages stored once) without a server change. A custom `MANPAGES_DIR` with plain `.txt` pages still works.

### Removed
- Pages in sections 2, 3, and other library or API sections, which `mcp-redhat-manpage-data` 0.2.1 no longer ships.

## [0.2.4] - 2026-11-23

### Added
- Continuous integration on Node.js 18, 20, 22, and 24 for every push and pull request to `main`, with a stdio smoke test that checks the registered tools against the README and the reported server version against `package.json`.
- Automated npm publishing with provenance through npm trusted publishing, plus a GitHub release for each version.
- `engines.node` declares the supported Node.js range (18.14.1 or later).
- README sections on pagination, version pinning, and the release process.

### Changed
- The published package contains only `src/`, `README.md`, and `package.json`.

### Fixed
- README setup for Claude Code (MCP servers belong in `~/.claude.json` or `.mcp.json`, not `settings.json`), VS Code (`servers` key and `${env:...}` variables), and Cursor, now documented separately.
- The `bin` path no longer uses a `./` prefix, which npm 11 drops on publish.
- The server reports its package version; releases 0.2.1 to 0.2.3 reported 0.2.0.

## [0.2.3] - 2026-05-05

### Added
- Optional `offset` and `limit` parameters on `getManPage` split large man pages into chunks; truncated responses end with a footer giving the next `offset`.

## [0.2.2] - 2026-03-20

### Changed
- Repository and issue URLs point to the `sleepytimeshon` GitHub account after the repository transfer.

## [0.2.1] - 2026-03-11

### Changed
- README lists related servers in a standard order across all servers.

### Removed
- An unused `.npmignore` file.

### Fixed
- The server version, which still reported 0.1.0.

## [0.2.0] - 2026-03-11

### Changed
- Man pages ship through the `mcp-redhat-manpage-data` dependency, so no container runtime or manual extraction is needed.
- README follows the same format as the other `mcp-redhat-*` servers.

## [0.1.0] - 2026-03-11

### Added
- First release: an MCP server for version-indexed RHEL 8, 9, and 10 man pages with `getManPage`, `searchManPages`, `listManPages`, and `compareVersions`.

[Unreleased]: https://github.com/sleepytimeshon/mcp-redhat-manpage/compare/v0.2.5...HEAD
[0.2.5]: https://www.npmjs.com/package/mcp-redhat-manpage/v/0.2.5
[0.2.4]: https://www.npmjs.com/package/mcp-redhat-manpage/v/0.2.4
[0.2.3]: https://www.npmjs.com/package/mcp-redhat-manpage/v/0.2.3
[0.2.2]: https://www.npmjs.com/package/mcp-redhat-manpage/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/mcp-redhat-manpage/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/mcp-redhat-manpage/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/mcp-redhat-manpage/v/0.1.0
