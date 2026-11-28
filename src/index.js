#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import {
  DEFAULT_CHUNK,
  ManPages,
  buildMatcher,
  findHeading,
  findOptionEntries,
  formatComparison,
  formatOptionEntries,
  formatOutline,
  formatSearch,
  nameMatcher,
  paginate,
  parseHeadings,
  parsePageRef,
  ref,
  searchText,
} from "./lib.js";

const require = createRequire(import.meta.url);
const { createReader } = require("mcp-redhat-manpage-data");

// Read the bundled man pages, or a directory with the same layout from MANPAGES_DIR
const pages = new ManPages(createReader(process.env.MANPAGES_DIR || undefined));

const server = new McpServer({
  name: "mcp-redhat-manpage",
  version: "0.3.0",
});

const text = (t) => ({ content: [{ type: "text", text: t }] });
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

// --- Shared parameters ---

const versionParam = (def = "9") =>
  z.union([z.string(), z.number().int()]).optional().default(def)
    .describe(`RHEL major version (default: "${def}"). Available: "8", "9", "10"; "rhel9" and "9.4" also work.`);
const pageParam = z.string().min(1).max(200)
  .describe('Man page name, e.g. "sssd.conf", "sshd_config", "ls"; "sssd.conf(5)" also works.');
const sectionParam = z.union([z.string(), z.number().int()]).optional()
  .describe('Man page section, e.g. "5" (file formats), "8" (admin commands), "1" (user commands). When omitted, the page\'s only section is used, or the first of 5, 8, 1, 7 when it has several.');
const offsetParam = z.number().int().nonnegative().optional().default(0)
  .describe("Character offset into the rendered output. Use the value from the previous call's [truncated] footer.");
const limitParam = z.number().int().positive().optional().default(DEFAULT_CHUNK)
  .describe(`Maximum characters to return in this call (default ${DEFAULT_CHUNK}).`);

const sectionString = (s) => (s === undefined || s === null || s === "" ? undefined : String(s).trim());

// --- Tool: getManPage ---
server.registerTool(
  "getManPage",
  {
    description:
      "Read a RHEL man page for a specific RHEL major version. Pass `heading` (e.g. \"OPTIONS\", \"EXAMPLES\") to read one part; when a page is larger than one chunk, the first chunk lists its headings. To look up one option or directive, use getManPageOption instead.",
    inputSchema: {
      page: pageParam,
      section: sectionParam,
      rhelVersion: versionParam(),
      heading: z.string().max(200).optional()
        .describe('A heading of the page to read alone, e.g. "OPTIONS", "EXAMPLES", or a subsection such as "The [sssd] section". Matched ignoring case, then by prefix or substring.'),
      offset: offsetParam,
      limit: limitParam,
    },
    annotations: READ_ONLY,
  },
  async ({ page, section, rhelVersion, heading, offset, limit }) => {
    const version = await pages.version(rhelVersion);
    const r = await pages.resolve(version, page, sectionString(section));
    if (r.error) return text(r.error);
    const content = await pages.read(version, r.name, r.section);
    const notes = [];
    if (r.others.length) notes.push(`Also in: ${r.others.map((s) => ref(r.name, s)).join(", ")}.`);
    const headings = parseHeadings(content);
    let body = content;
    let label = `${ref(r.name, r.section)} — RHEL ${version}`;
    if (heading) {
      const h = findHeading(headings, heading);
      if (h.error) return text(`${ref(r.name, r.section)} on RHEL ${version}: ${h.error}`);
      body = content.slice(h.heading.start, h.heading.end).replace(/\s+$/, "");
      label += ` — ${h.heading.title}`;
    } else if (content.length > limit && offset === 0 && headings.length) {
      notes.push(`This page is ${content.length} characters. Pass heading to read one part. Headings: ${formatOutline(headings)}.`);
    }
    return text(paginate(body, offset, limit, label, notes));
  }
);

// --- Tool: getManPageOption ---
server.registerTool(
  "getManPageOption",
  {
    description:
      "Look up one configuration option, directive, or command-line flag (e.g. \"ldap_id_mapping\", \"PermitRootLogin\", \"TimeoutStartSec\", \"--all\") and return its definition and stated default from a RHEL man page. Give `page` when you know it (fast); without it, every page is scanned (about 10 seconds) and up to `maxPages` pages that define the option are returned.",
    inputSchema: {
      option: z.string().min(1).max(200).describe('Option, directive, or flag name, e.g. "ldap_id_mapping", "PermitRootLogin", "-a"'),
      page: pageParam.optional(),
      section: sectionParam,
      rhelVersion: versionParam(),
      maxPages: z.number().int().min(1).max(20).optional().default(5)
        .describe("Without page: the most pages to return definitions from (default 5)."),
      offset: offsetParam,
      limit: limitParam,
    },
    annotations: READ_ONLY,
  },
  async ({ option, page, section, rhelVersion, maxPages, offset, limit }) => {
    const version = await pages.version(rhelVersion);
    const opt = option.trim();
    const sec = sectionString(section);

    if (page) {
      const r = await pages.resolve(version, page, sec);
      if (r.error) return text(r.error);
      const content = await pages.read(version, r.name, r.section);
      const entries = findOptionEntries(content, opt);
      if (!entries.length) {
        const mentions = searchText(content, buildMatcher(opt), { keep: 0 }).count;
        const hint = mentions
          ? `It is mentioned on ${mentions} line${mentions === 1 ? "" : "s"}: use searchManPages with page "${r.name}" to see them.`
          : "The page does not mention it.";
        const others = r.others.length ? ` The page is also in ${r.others.map((s) => ref(r.name, s)).join(", ")}.` : "";
        return text(`No definition of "${opt}" in ${ref(r.name, r.section)} on RHEL ${version}. ${hint}${others}`);
      }
      return text(paginate(formatOptionEntries(r.name, r.section, version, entries), offset, limit,
        `"${opt}" in ${ref(r.name, r.section)} — RHEL ${version}`));
    }

    const quick = buildMatcher(opt);
    const found = [];
    for await (const stored of pages.reader.storedPages(version)) {
      if (sec && stored.section !== sec) continue;
      const content = await stored.read();
      if (!quick.test(content)) continue;
      const entries = findOptionEntries(content, opt);
      if (entries.length) found.push(formatOptionEntries(stored.name, stored.section, version, entries));
      if (found.length >= maxPages) break;
    }
    if (!found.length) {
      return text(`No man page on RHEL ${version}${sec ? ` in section ${sec}` : ""} defines "${opt}" as an option or directive. Try searchManPages to find mentions.`);
    }
    const more = found.length >= maxPages ? `\n\nStopped after ${maxPages} pages; more may define it. Raise maxPages or pass section.` : "";
    return text(paginate(`${found.join("\n\n")}${more}`, offset, limit, `"${opt}" — RHEL ${version}: defined in ${found.length} page${found.length === 1 ? "" : "s"}`));
  }
);

// --- Tool: searchManPages ---
server.registerTool(
  "searchManPages",
  {
    description:
      "Search the text of RHEL man pages and return matching lines with context, grouped by page. The query is literal text, matched ignoring case, unless regex is true. Narrow with `page`, `nameFilter`, or `section`: an unrestricted search reads every page (about 10 seconds).",
    inputSchema: {
      query: z.string().min(1).max(500).describe("Text to find, matched ignoring case"),
      regex: z.boolean().optional().default(false).describe("Treat query as a JavaScript regular expression (default false)"),
      rhelVersion: versionParam(),
      page: pageParam.optional().describe('Search only this page, e.g. "sssd.conf" (fast)'),
      nameFilter: z.string().max(200).optional().describe('Search only pages whose name matches this pattern, e.g. "sssd" or "^systemd\\."'),
      section: sectionParam,
      maxPages: z.number().int().min(1).max(100).optional().default(10)
        .describe("Most pages to return (default 10)"),
      matchesPerPage: z.number().int().min(1).max(50).optional().default(3)
        .describe("Most matching lines shown per page (default 3); the full count is always given"),
      contextLines: z.number().int().min(0).max(10).optional().default(2)
        .describe("Lines of context around each match (default 2)"),
      offset: offsetParam,
      limit: limitParam,
    },
    annotations: READ_ONLY,
  },
  async ({ query, regex, rhelVersion, page, nameFilter, section, maxPages, matchesPerPage, contextLines, offset, limit }) => {
    const version = await pages.version(rhelVersion);
    const matcher = buildMatcher(query, regex);
    const sec = sectionString(section);
    const opts = { contextLines, keep: matchesPerPage };
    const results = [];
    let stopped = false;
    let scope = "";

    if (page) {
      const r = await pages.resolve(version, page, sec);
      if (r.error) return text(r.error);
      const res = searchText(await pages.read(version, r.name, r.section), matcher, opts);
      if (res.count) results.push({ name: r.name, section: r.section, ...res });
      scope = ` (page ${ref(r.name, r.section)})`;
    } else {
      const names = nameMatcher(nameFilter);
      const parts = [names && `names matching "${nameFilter}"`, sec && `section ${sec}`].filter(Boolean);
      if (parts.length) scope = ` (${parts.join(", ")})`;
      for await (const stored of pages.reader.storedPages(version)) {
        if (sec && stored.section !== sec) continue;
        if (names && !names.test(stored.name)) continue;
        const content = await stored.read();
        if (!matcher.test(content)) continue;
        const res = searchText(content, matcher, opts);
        if (!res.count) continue;
        if (results.length >= maxPages) {
          stopped = true;
          break;
        }
        results.push({ name: stored.name, section: stored.section, ...res });
      }
    }
    const out = formatSearch({ query, version, results, stopped, scope });
    return text(paginate(out, offset, limit, `searchManPages "${query}" — RHEL ${version}`));
  }
);

// --- Tool: compareVersions ---
server.registerTool(
  "compareVersions",
  {
    description:
      "Compare a man page between two RHEL major versions: options and entries added, removed, or reworded, then the paragraphs that differ (ignoring line wrapping). Use it to find configuration changes between RHEL releases.",
    inputSchema: {
      page: pageParam,
      section: sectionParam,
      version1: versionParam("8").describe('Older RHEL major version (default: "8")'),
      version2: versionParam("9").describe('Newer RHEL major version (default: "9")'),
      offset: offsetParam,
      limit: limitParam,
    },
    annotations: READ_ONLY,
  },
  async ({ page, section, version1, version2, offset, limit }) => {
    const v1 = await pages.version(version1);
    const v2 = await pages.version(version2);
    let sec = sectionString(section);
    const { name } = parsePageRef(page, sec);
    const r1 = await pages.resolve(v1, page, sec);
    if (!sec && !r1.error) sec = r1.section;
    const r2 = await pages.resolve(v2, page, sec);
    if (r1.error && r2.error) return text(`Not on RHEL ${v1}: ${r1.error}\nNot on RHEL ${v2}: ${r2.error}`);
    if (r1.error) return text(`${ref(r2.name, r2.section)} exists on RHEL ${v2} but not on RHEL ${v1}. ${r1.error}`);
    if (r2.error) return text(`${ref(r1.name, r1.section)} exists on RHEL ${v1} but not on RHEL ${v2} (removed or renamed). ${r2.error}`);
    const a = await pages.read(v1, r1.name, r1.section);
    const b = await pages.read(v2, r2.name, r2.section);
    const out = formatComparison({ name: r1.name || name, section: r1.section, v1, v2, a, b });
    return text(paginate(out, offset, limit, `compareVersions ${ref(r1.name, r1.section)} — RHEL ${v1} vs ${v2}`));
  }
);

// --- Tool: listManPages ---
server.registerTool(
  "listManPages",
  {
    description:
      "List the man page names available for a RHEL major version, optionally filtered by name pattern and section. The unfiltered list has about 11,000 names, so filter it.",
    inputSchema: {
      rhelVersion: versionParam(),
      filter: z.string().max(200).optional()
        .describe('Name pattern, matched ignoring case: a regular expression such as "^sssd", or literal text when it is not a valid one'),
      section: sectionParam,
      offset: offsetParam,
      limit: limitParam,
    },
    annotations: READ_ONLY,
  },
  async ({ rhelVersion, filter, section, offset, limit }) => {
    const version = await pages.version(rhelVersion);
    const sec = sectionString(section);
    const names = nameMatcher(filter);
    let list = (await pages.index(version)).list;
    if (names) list = list.filter((p) => names.test(p.name));
    if (sec) list = list.filter((p) => p.section === sec);
    const what = [filter && `matching "${filter}"`, sec && `in section ${sec}`].filter(Boolean).join(" ");
    if (!list.length) return text(`No man pages ${what || "available"} on RHEL ${version}.`);
    const versions = await pages.reader.versions();
    const out = `## Man pages on RHEL ${version}${what ? ` ${what}` : ""}: ${list.length}\nAvailable versions: ${versions.join(", ")}\n\n${list.map((p) => ref(p.name, p.section)).join("\n")}`;
    return text(paginate(out, offset, limit, `listManPages — RHEL ${version}`));
  }
);

// Connect
const transport = new StdioServerTransport();
await server.connect(transport);
