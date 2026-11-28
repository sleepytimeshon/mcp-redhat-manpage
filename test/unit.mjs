#!/usr/bin/env node
// Offline tests of src/lib.js against a synthetic in-memory reader: page resolution,
// headings, option lookup, search, comparison, and pagination.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ManPages,
  buildMatcher,
  comparePages,
  extractDefault,
  findHeading,
  findOptionEntries,
  nameMatcher,
  paginate,
  parseHeadings,
  parsePageRef,
  searchText,
  suggestNames,
} from "../src/lib.js";

const CONF_V1 = `DEMO.CONF(5)                 File Formats                 DEMO.CONF(5)

NAME
       demo.conf - configuration file for demo

OPTIONS
   General options
       cache_size (integer)
           How many entries to cache.

           Default: 100

       timeout, retry_timeout (integer)
           Seconds to wait for a reply. The default is 30.

       mode (string)
           Operating mode.

               fast (string)
                   A nested entry.

                   Default: nested

           Defaults to safe.

EXAMPLES
       cache_size = 10

demo 1.0                      2026-01-01                 DEMO.CONF(5)
`;

const CONF_V2 = CONF_V1
  .replace("           Seconds to wait for a reply. The default is 30.", "           Seconds to wait for a reply.\n           The default is 30.")
  .replace("       mode (string)", "       new_option (bool)\n           Added later.\n\n       mode (string)")
  .replace("How many entries to cache.", "How many entries to keep.");

const CMD = `DEMO(1)                     User Commands                     DEMO(1)

NAME
       demo - a demo command

DESCRIPTION
       -a, --all
              show all entries

       --quiet
              print nothing

demo 1.0                      2026-01-01                     DEMO(1)
`;

function fakeReader(data) {
  const split = (base) => {
    const dot = base.lastIndexOf(".");
    return { name: base.slice(0, dot), section: base.slice(dot + 1) };
  };
  return {
    async versions() { return Object.keys(data); },
    async listPages(v) {
      if (!data[v]) throw new Error(`No man pages for RHEL ${v} in /secret/path`);
      return Object.keys(data[v]).map(split).sort((a, b) => a.name.localeCompare(b.name) || a.section.localeCompare(b.section));
    },
    async readPage(v, name, section) { return data[v]?.[`${name}.${section}`] ?? null; },
    async *storedPages(v) {
      for (const [base, t] of Object.entries(data[v])) yield { ...split(base), read: async () => t };
    },
  };
}

const pages = new ManPages(fakeReader({
  8: { "demo.conf.5": CONF_V1, "demo.1": CMD },
  9: { "demo.conf.5": CONF_V2, "demo.1": CMD, "demo.8": CMD, "Mixed.1": CMD, "python3.11.1": CMD },
}));

test("parsePageRef accepts name(section) and rejects bad sections", () => {
  assert.deepEqual(parsePageRef("sssd.conf(5)"), { name: "sssd.conf", section: "5" });
  assert.deepEqual(parsePageRef(" ls ", 1), { name: "ls", section: "1" });
  assert.deepEqual(parsePageRef("openssl(1ossl)"), { name: "openssl", section: "1ossl" });
  assert.throws(() => parsePageRef(""), /name is required/);
  assert.throws(() => parsePageRef("ls", "../x"), /Invalid section/);
});

test("version normalizes forms and lists available versions without paths", async () => {
  assert.equal(await pages.version("9"), "9");
  assert.equal(await pages.version(9), "9");
  assert.equal(await pages.version("RHEL 8"), "8");
  assert.equal(await pages.version("rhel9"), "9");
  assert.equal(await pages.version("9.4"), "9");
  await assert.rejects(pages.version("7"), (e) => /Available versions: 8, 9/.test(e.message) && !/secret/.test(e.message));
});

test("resolve picks sections, parses suffixes, ignores case, and suggests", async () => {
  assert.deepEqual(await pages.resolve("9", "demo.conf"), { name: "demo.conf", section: "5", others: [] });
  assert.deepEqual(await pages.resolve("9", "demo"), { name: "demo", section: "8", others: ["1"] });
  assert.deepEqual(await pages.resolve("9", "demo", "1"), { name: "demo", section: "1", others: ["8"] });
  assert.deepEqual(await pages.resolve("9", "demo.conf.5"), { name: "demo.conf", section: "5", others: [] });
  assert.deepEqual(await pages.resolve("9", "python3.11"), { name: "python3.11", section: "1", others: [] });
  assert.equal((await pages.resolve("9", "mixed")).name, "Mixed");
  assert.match((await pages.resolve("9", "demo", "5")).error, /demo\(5\) does not exist .* demo\(8\), demo\(1\)/);
  assert.match((await pages.resolve("9", "dem")).error, /Closest names.*demo\(8\)/);
  assert.match((await pages.resolve("9", "zzz")).error, /searchManPages/);
});

test("suggestNames ranks and caps", () => {
  const names = ["e", "ed", "sed", "free", "crontab", "ex"];
  const { names: got, total } = suggestNames(names, "e", 3);
  assert.deepEqual(got, ["e", "ed", "ex"]);
  assert.equal(total, 3);
  assert.deepEqual(suggestNames(["foo-bar", "barn"], "bar").names, ["barn", "foo-bar"]);
});

test("parseHeadings finds top-level and subsection headings, not title or footer", () => {
  const h = parseHeadings(CONF_V1);
  assert.deepEqual(h.map((x) => [x.title, x.level]), [["NAME", 1], ["OPTIONS", 1], ["General options", 2], ["EXAMPLES", 1]]);
  const examples = h.find((x) => x.title === "EXAMPLES");
  assert.equal(CONF_V1.slice(examples.start, examples.end).trim(), "EXAMPLES\n       cache_size = 10");
  assert.equal(findHeading(h, "general").heading.title, "General options");
  assert.match(findHeading(h, "zzz").error, /Headings: NAME/);
});

test("findOptionEntries returns definitions and stated defaults", () => {
  const [cache] = findOptionEntries(CONF_V1, "cache_size");
  assert.equal(cache.term, "cache_size (integer)");
  assert.equal(cache.default, "100");
  assert.equal(cache.context, "OPTIONS > General options");
  assert.equal(findOptionEntries(CONF_V1, "retry_timeout")[0].default, "30");
  assert.equal(findOptionEntries(CONF_V1, "mode")[0].default, "safe", "default from the entry itself, not a nested one");
  assert.equal(findOptionEntries(CMD, "--all")[0].term, "-a, --all");
  assert.equal(findOptionEntries(CMD, "-a")[0].term, "-a, --all");
  assert.equal(findOptionEntries(CMD, "all").length, 0, "a word inside a description is not a definition");
  assert.equal(findOptionEntries(CONF_V1, "cache").length, 0);
  assert.throws(() => findOptionEntries(CONF_V1, " "), /option is required/);
});

test("extractDefault reads common phrasings", () => {
  assert.equal(extractDefault("Default: false"), "false");
  assert.equal(extractDefault("The default is prohibit-password. Other text."), "prohibit-password");
  assert.equal(extractDefault("Defaults to 90s."), "90s");
  assert.equal(extractDefault("No default here"), undefined);
});

test("buildMatcher is literal by default and explains bad regexes", () => {
  assert.ok(buildMatcher("a.b").test("A.B"));
  assert.ok(!buildMatcher("a.b").test("axb"));
  assert.ok(buildMatcher("a.b", true).test("axb"));
  assert.ok(buildMatcher("(").test("f(x)"));
  assert.throws(() => buildMatcher("(", true), /Pass regex: false/);
  assert.throws(() => buildMatcher("  "), /empty/);
  assert.ok(nameMatcher("[").test("a[b"), "invalid name regex falls back to literal");
  assert.equal(nameMatcher(""), null);
});

test("searchText counts every match and keeps the first few with context", () => {
  const r = searchText("a\ntimeout\nb\nTIMEOUT\nc\ntimeout", buildMatcher("timeout"), { contextLines: 1, keep: 2 });
  assert.equal(r.count, 3);
  assert.equal(r.hits.length, 2);
  assert.deepEqual(r.hits.map((h) => h.line), [2, 4]);
  assert.equal(r.hits[0].context, "  a\n> timeout\n  b");
});

test("comparePages ignores rewrapping and reports option changes", () => {
  const d = comparePages(CONF_V1, CONF_V2);
  assert.deepEqual(d.optionsAdded, ["new_option"]);
  assert.deepEqual(d.optionsRemoved, []);
  assert.deepEqual(d.optionsChanged, ["cache_size"]);
  assert.ok(!d.added.some((p) => p.includes("Seconds to wait")), "rewrapped paragraph is unchanged");
  const typed = comparePages(CONF_V1, CONF_V1.replace("cache_size (integer)", "cache_size (string)"));
  assert.deepEqual([typed.optionsAdded, typed.optionsRemoved, typed.optionsChanged], [[], [], ["cache_size"]]);
  const footer = comparePages(CONF_V1, CONF_V1.replace("2026-01-01", "2027-02-02"));
  assert.ok(footer.sameText && !footer.identical);
});

test("source reports the package when the reader knows it, and null otherwise", async () => {
  const reader = fakeReader({ 9: { "demo.1": CMD } });
  assert.equal(await new ManPages(reader).source("9", "demo", "1"), null, "reader without pageSource");
  reader.pageSource = async (v, name) => (name === "demo" ? { package: "demo-1.0-1.el9.x86_64", license: "MIT" } : null);
  const withSource = new ManPages(reader);
  assert.equal(await withSource.source("9", "demo", "1"), "demo-1.0-1.el9.x86_64 (license: MIT)");
  assert.equal(await withSource.source("9", "other", "1"), null);
  reader.pageSource = async () => { throw new Error("boom"); };
  assert.equal(await new ManPages(reader).source("9", "demo", "1"), null, "a failing lookup is not fatal");
});

test("paginate notes truncation and offsets past the end", () => {
  const out = paginate("abcdef", 0, 4, "label", ["note"]);
  assert.match(out, /^# label\n# chars 0-4 of 6\n> note\n\nabcd/);
  assert.match(out, /offset=4/);
  assert.match(paginate("abc", 10, 4, "x"), /past the end/);
});
