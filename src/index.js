#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve man pages directory: env override > data package > local fallback
function resolveManpagesDir() {
  if (process.env.MANPAGES_DIR) return process.env.MANPAGES_DIR;
  try {
    const { manpagesDir } = require("mcp-redhat-manpage-data");
    return manpagesDir;
  } catch {
    return join(dirname(__dirname), "manpages");
  }
}

const MANPAGES_DIR = resolveManpagesDir();

const server = new McpServer({
  name: "mcp-redhat-manpage",
  version: "0.2.0",
});

// Cache loaded man pages in memory for fast repeated lookups
const cache = new Map();

async function getVersionDir(rhelVersion) {
  const dir = join(MANPAGES_DIR, `rhel${rhelVersion}`);
  if (!existsSync(dir)) {
    throw new Error(
      `No man pages found for RHEL ${rhelVersion}. Run 'npm run extract' or 'bash scripts/extract.sh ${rhelVersion}' first.`
    );
  }
  return dir;
}

async function loadManPage(rhelVersion, pageName, section) {
  const key = `${rhelVersion}:${pageName}.${section}`;
  if (cache.has(key)) return cache.get(key);

  const dir = await getVersionDir(rhelVersion);
  const file = join(dir, `${pageName}.${section}.txt`);

  if (!existsSync(file)) return null;

  const content = await readFile(file, "utf-8");
  cache.set(key, content);
  return content;
}

async function listAvailablePages(rhelVersion) {
  const dir = await getVersionDir(rhelVersion);
  const files = await readdir(dir);
  return files
    .filter((f) => f.endsWith(".txt"))
    .map((f) => {
      const base = f.replace(".txt", "");
      const parts = base.split(".");
      const section = parts.pop();
      const name = parts.join(".");
      return { name, section };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.section.localeCompare(b.section));
}

async function listVersions() {
  if (!existsSync(MANPAGES_DIR)) return [];
  const dirs = await readdir(MANPAGES_DIR);
  return dirs
    .filter((d) => d.startsWith("rhel"))
    .map((d) => d.replace("rhel", ""))
    .sort();
}

// --- Tool: getManPage ---
const DEFAULT_CHUNK = 30000;

server.registerTool(
  "getManPage",
  {
    description:
      "Get the content of a RHEL man page for a specific version. Use this to verify configuration parameter defaults, syntax, and behavior. Large pages are paginated — call repeatedly with `offset` to read subsequent chunks.",
    inputSchema: {
      page: z
        .string()
        .describe(
          'Man page name without section (e.g., "sssd.conf", "sssd-ad", "krb5.conf", "adcli", "authselect")'
        ),
      section: z
        .string()
        .optional()
        .default("5")
        .describe('Man page section (default: "5" for config files). Use "8" for commands, "1" for user commands.'),
      rhelVersion: z
        .string()
        .optional()
        .default("9")
        .describe('RHEL major version (default: "9"). Available: "8", "9", "10".'),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe(`Byte offset into the rendered manpage. Default 0. Use the value from the previous call's "[truncated]" footer to fetch the next chunk.`),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(DEFAULT_CHUNK)
        .describe(`Maximum characters to return in this call. Default ${DEFAULT_CHUNK} keeps responses under typical MCP tool-result token caps.`),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ page, section, rhelVersion, offset, limit }) => {
    const content = await loadManPage(rhelVersion, page, section);
    if (!content) {
      // Try to find the page in other sections
      const pages = await listAvailablePages(rhelVersion);
      const matches = pages.filter((p) => p.name === page || p.name.includes(page));
      if (matches.length > 0) {
        const suggestions = matches.map((m) => `${m.name}(${m.section})`).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Man page "${page}(${section})" not found for RHEL ${rhelVersion}. Did you mean: ${suggestions}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Man page "${page}(${section})" not found for RHEL ${rhelVersion}. Run 'npm run extract' to refresh man pages.`,
          },
        ],
      };
    }

    const total = content.length;
    const start = Math.min(offset, total);
    const end = Math.min(start + limit, total);
    const slice = content.slice(start, end);
    const header = `# ${page}(${section}) — RHEL ${rhelVersion}\n# chars ${start}-${end} of ${total}\n\n`;
    const footer =
      end < total
        ? `\n\n[truncated: showing chars ${start}-${end} of ${total}. Call again with offset=${end} for the next chunk.]`
        : "";

    return {
      content: [
        {
          type: "text",
          text: `${header}${slice}${footer}`,
        },
      ],
    };
  }
);

// --- Tool: searchManPages ---
server.registerTool(
  "searchManPages",
  {
    description:
      "Search across all man pages for a keyword or pattern. Returns matching lines with context. Use this to find which man page documents a specific parameter or feature.",
    inputSchema: {
      query: z.string().describe("Search term or regex pattern to find in man page content"),
      rhelVersion: z
        .string()
        .optional()
        .default("9")
        .describe('RHEL major version (default: "9").'),
      maxResults: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum number of matches to return (default: 20)"),
      contextLines: z
        .number()
        .optional()
        .default(3)
        .describe("Number of lines of context around each match (default: 3)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, rhelVersion, maxResults, contextLines }) => {
    const dir = await getVersionDir(rhelVersion);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".txt"));

    const results = [];
    const regex = new RegExp(query, "gi");

    for (const file of files) {
      if (results.length >= maxResults) break;

      const content = await readFile(join(dir, file), "utf-8");
      const lines = content.split("\n");
      const base = file.replace(".txt", "");

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break;
        if (!regex.test(lines[i])) continue;
        regex.lastIndex = 0; // Reset regex state

        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const context = lines
          .slice(start, end + 1)
          .map((l, idx) => (idx + start === i ? `>>> ${l}` : `    ${l}`))
          .join("\n");

        results.push({
          page: base,
          line: i + 1,
          context,
        });
      }
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No matches for "${query}" in RHEL ${rhelVersion} man pages.`,
          },
        ],
      };
    }

    const output = results
      .map((r) => `--- ${r.page} (line ${r.line}) ---\n${r.context}`)
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} match(es) for "${query}" in RHEL ${rhelVersion} man pages:\n\n${output}`,
        },
      ],
    };
  }
);

// --- Tool: compareVersions ---
server.registerTool(
  "compareVersions",
  {
    description:
      "Compare a man page between two RHEL versions. Shows which version has the page and highlights differences in content length. Use this to detect parameter changes between RHEL releases.",
    inputSchema: {
      page: z.string().describe("Man page name (e.g., \"sssd.conf\", \"sssd-ad\")"),
      section: z.string().optional().default("5").describe("Man page section (default: \"5\")"),
      version1: z.string().optional().default("8").describe("First RHEL version (default: \"8\")"),
      version2: z.string().optional().default("9").describe("Second RHEL version (default: \"9\")"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ page, section, version1, version2 }) => {
    const content1 = await loadManPage(version1, page, section);
    const content2 = await loadManPage(version2, page, section);

    if (!content1 && !content2) {
      return {
        content: [
          {
            type: "text",
            text: `Man page "${page}(${section})" not found in either RHEL ${version1} or RHEL ${version2}.`,
          },
        ],
      };
    }

    if (!content1) {
      return {
        content: [
          {
            type: "text",
            text: `Man page "${page}(${section})" exists in RHEL ${version2} but NOT in RHEL ${version1}. This may be a new feature in RHEL ${version2}.`,
          },
        ],
      };
    }

    if (!content2) {
      return {
        content: [
          {
            type: "text",
            text: `Man page "${page}(${section})" exists in RHEL ${version1} but NOT in RHEL ${version2}. This may have been removed or renamed.`,
          },
        ],
      };
    }

    const lines1 = content1.split("\n").length;
    const lines2 = content2.split("\n").length;
    const identical = content1 === content2;

    let summary = `## ${page}(${section}) — RHEL ${version1} vs RHEL ${version2}\n\n`;
    summary += `- RHEL ${version1}: ${lines1} lines\n`;
    summary += `- RHEL ${version2}: ${lines2} lines\n`;
    summary += `- Identical: ${identical ? "Yes" : "No"}\n`;

    if (!identical) {
      // Find lines unique to each version
      const set1 = new Set(content1.split("\n").map((l) => l.trim()).filter(Boolean));
      const set2 = new Set(content2.split("\n").map((l) => l.trim()).filter(Boolean));

      const onlyIn1 = [...set1].filter((l) => !set2.has(l));
      const onlyIn2 = [...set2].filter((l) => !set1.has(l));

      if (onlyIn2.length > 0) {
        summary += `\n### New in RHEL ${version2} (sample, up to 30 lines):\n`;
        summary += onlyIn2.slice(0, 30).map((l) => `+ ${l}`).join("\n");
      }

      if (onlyIn1.length > 0) {
        summary += `\n\n### Removed in RHEL ${version2} (sample, up to 30 lines):\n`;
        summary += onlyIn1.slice(0, 30).map((l) => `- ${l}`).join("\n");
      }
    }

    return { content: [{ type: "text", text: summary }] };
  }
);

// --- Tool: listManPages ---
server.registerTool(
  "listManPages",
  {
    description:
      "List all available man pages for a RHEL version, optionally filtered by name pattern.",
    inputSchema: {
      rhelVersion: z
        .string()
        .optional()
        .default("9")
        .describe('RHEL major version (default: "9").'),
      filter: z
        .string()
        .optional()
        .describe('Filter by name pattern (e.g., "sssd" returns all SSSD-related pages)'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ rhelVersion, filter }) => {
    let pages = await listAvailablePages(rhelVersion);

    if (filter) {
      const pattern = new RegExp(filter, "i");
      pages = pages.filter((p) => pattern.test(p.name));
    }

    if (pages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: filter
              ? `No man pages matching "${filter}" for RHEL ${rhelVersion}.`
              : `No man pages available for RHEL ${rhelVersion}. Run 'npm run extract' first.`,
          },
        ],
      };
    }

    const versions = await listVersions();
    const output = pages.map((p) => `${p.name}(${p.section})`).join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Available man pages for RHEL ${rhelVersion} (${pages.length} pages):\nAvailable versions: ${versions.join(", ")}\n\n${output}`,
        },
      ],
    };
  }
);

// Connect
const transport = new StdioServerTransport();
await server.connect(transport);
