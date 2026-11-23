#!/usr/bin/env node
// Start the server over stdio, then check its reported version and tool list against
// package.json and the README tool tables. Needs no credentials: listing tools never
// calls a Red Hat API.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const readme = await readFile(new URL("README.md", root), "utf8");

// Collect tool names from the first column of every table under "## Tools"
const toolsSection = readme.split(/^## Tools$/m)[1]?.split(/^## /m)[0] ?? "";
const documented = [...toolsSection.matchAll(/^\| `([A-Za-z_]\w*)`/gm)].map((m) => m[1]);
assert.ok(documented.length > 0, "README.md has no tool table under '## Tools'");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL(pkg.main, root))],
  stderr: "inherit",
});
const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);

try {
  const server = client.getServerVersion();
  assert.equal(server.name, pkg.name, "server name differs from package.json name");
  assert.equal(server.version, pkg.version, "server version differs from package.json version");

  const registered = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    registered.push(...page.tools.map((t) => t.name));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(
    [...registered].sort(),
    [...documented].sort(),
    "registered tools differ from the README tool tables",
  );
  console.log(`ok: ${pkg.name}@${pkg.version} registers ${registered.length} tools, all documented`);
} finally {
  await client.close();
}
