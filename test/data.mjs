#!/usr/bin/env node
// Exercise every tool against the installed man page data (or MANPAGES_DIR): a stored
// page, an aliased page, search, listing, and a cross-version comparison.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
  env: process.env.MANPAGES_DIR ? { MANPAGES_DIR: process.env.MANPAGES_DIR } : undefined,
  stderr: "inherit",
});
const client = new Client({ name: "data-test", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return result.content.map((c) => c.text).join("\n");
};

try {
  for (const rhelVersion of ["8", "9", "10"]) {
    const sssd = await call("getManPage", { page: "sssd.conf", section: "5", rhelVersion });
    assert.match(sssd, /the configuration file for SSSD/, `RHEL ${rhelVersion}: sssd.conf(5)`);

    const sshd = await call("getManPage", { page: "sshd_config", section: "5", rhelVersion });
    assert.match(sshd, /OpenSSH (SSH )?daemon configuration file/, `RHEL ${rhelVersion}: sshd_config(5)`);

    const search = await call("searchManPages", { query: "ldap_uri", rhelVersion, maxResults: 3 });
    assert.match(search, /Found \d+ match/, `RHEL ${rhelVersion}: search for ldap_uri`);

    const list = await call("listManPages", { rhelVersion, filter: "^sssd" });
    assert.match(list, /sssd\.conf\(5\)/, `RHEL ${rhelVersion}: list sssd pages`);
  }

  // An aliased page resolves to its stored copy
  const alias = await call("getManPage", { page: "podman-run", section: "1", rhelVersion: "9" });
  assert.match(alias, /podman-run/i, "RHEL 9: podman-run(1) through its alias");

  const compare = await call("compareVersions", { page: "chrony.conf", section: "5", version1: "8", version2: "9" });
  assert.match(compare, /RHEL 8: \d+ lines/, "compare chrony.conf(5) between RHEL 8 and 9");

  console.log("ok: getManPage, aliases, searchManPages, listManPages, and compareVersions on RHEL 8, 9, 10");
} finally {
  await client.close();
}
