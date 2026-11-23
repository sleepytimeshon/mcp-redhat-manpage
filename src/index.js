#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createReader } = require("mcp-redhat-manpage-data");

// Read the bundled man pages, or a directory with the same layout from MANPAGES_DIR
const reader = createReader(process.env.MANPAGES_DIR || undefined);

const server = new McpServer({
  name: "mcp-redhat-manpage",
  version: "0.2.5",
});

// Cache loaded man pages in memory for fast repeated lookups
const cache = new Map();

async function loadManPage(rhelVersion, pageName, section) {
  const key = `${rhelVersion}:${pageName}.${section}`;
  if (cache.has(key)) return cache.get(key);

  const content = await reader.readPage(rhelVersion, pageName, section);
  if (content !== null) cache.set(key, content);
  return content;
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
      const pages = await reader.listPages(rhelVersion);
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
            text: `Man page "${page}(${section})" not found for RHEL ${rhelVersion}.`,
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
    // Each distinct page once; aliases share their stored page's content
    const results = [];
    const regex = new RegExp(query, "gi");

    for await (const stored of reader.storedPages(rhelVersion)) {
      if (results.length >= maxResults) break;

      const content = await stored.read();
      const lines = content.split("\n");
      const base = `${stored.name}.${stored.section}`;

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
    let pages = await reader.listPages(rhelVersion);

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
              : `No man pages available for RHEL ${rhelVersion}.`,
          },
        ],
      };
    }

    const versions = await reader.versions();
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
