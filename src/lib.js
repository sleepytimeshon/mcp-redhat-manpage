// Page lookup, search, option and heading extraction, comparison, and Markdown formatting
// for mcp-redhat-manpage. Kept separate from src/index.js, which starts the stdio transport,
// so tests can import it with a synthetic reader. Pages are read only through the reader API
// of mcp-redhat-manpage-data (versions, listPages, readPage, storedPages).

export const DEFAULT_CHUNK = 30000;
export const MAX_QUERY_LENGTH = 500;

// A man page section: "1", "5", "8", "7ossl", "3pm"
export const SECTION_RE = /^\d[a-z0-9]*$/i;

// Sections tried first when the caller names a page without a section
const SECTION_PREFERENCE = ["5", "8", "1", "7"];

export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collapse = (s) => String(s).replace(/\s+/g, " ").trim();
const indentOf = (line) => line.length - line.trimStart().length;
export const ref = (name, section) => `${name}(${section})`;

// --- Page references ---

// Accept "sssd.conf", "sssd.conf(5)", or a separate section argument
export function parsePageRef(page, section) {
  let name = String(page ?? "").trim();
  let sec = section === undefined || section === null ? "" : String(section).trim();
  const m = name.match(/^(.+?)\s*\((\d[a-z0-9]*)\)$/i);
  if (m) {
    name = m[1].trim();
    if (!sec) sec = m[2];
  }
  if (!name) throw new Error("A man page name is required, e.g. \"sssd.conf\"");
  if (sec && !SECTION_RE.test(sec)) throw new Error(`Invalid section "${sec}": expected a section such as 1, 5, 7, or 8`);
  return { name, section: sec || undefined };
}

const sectionRank = (s) => {
  const i = SECTION_PREFERENCE.indexOf(s);
  return i === -1 ? SECTION_PREFERENCE.length : i;
};

// Rank page names against a mistyped or partial name: exact (ignoring case), prefix, word, substring
export function suggestNames(names, query, max = 15) {
  const q = query.toLowerCase();
  const scored = [];
  for (const n of names) {
    const l = n.toLowerCase();
    let score;
    if (l === q) score = 0;
    else if (l.startsWith(q)) score = 1;
    else if (l.split(/[-_.:]/).includes(q)) score = 2;
    else if (q.length >= 3 && l.includes(q)) score = 3;
    else continue;
    scored.push([score, n]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  return { names: scored.slice(0, max).map(([, n]) => n), total: scored.length };
}

// --- Reader wrapper ---

export class ManPages {
  constructor(reader, { cacheSize = 32 } = {}) {
    this.reader = reader;
    this.cacheSize = cacheSize;
    this.cache = new Map();
    this.indexes = new Map();
  }

  // Normalize "9", 9, "rhel9", "RHEL 9", or "9.4" to an available major version
  async version(v) {
    const available = await this.reader.versions();
    const s = String(v ?? "").trim();
    const m = s.match(/^(?:rhel[\s-]*)?(\d+)(?:\.\d+)*$/i);
    const major = m ? String(Number(m[1])) : null;
    if (major && available.includes(major)) return major;
    throw new Error(`No man pages for RHEL "${s}". Available versions: ${available.join(", ")}.`);
  }

  // Every page of a version, and its sections by name
  async index(version) {
    if (this.indexes.has(version)) return this.indexes.get(version);
    const list = await this.reader.listPages(version);
    const byName = new Map();
    const byLower = new Map();
    for (const p of list) {
      if (!byName.has(p.name)) byName.set(p.name, []);
      byName.get(p.name).push(p.section);
      const l = p.name.toLowerCase();
      if (!byLower.has(l)) byLower.set(l, []);
      if (!byLower.get(l).includes(p.name)) byLower.get(l).push(p.name);
    }
    for (const secs of byName.values()) secs.sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b));
    const index = { list, byName, byLower };
    this.indexes.set(version, index);
    return index;
  }

  // The package that ships a page, as "package (license)", or null when the reader does not
  // know it (an older data package, or a custom MANPAGES_DIR without sources.tsv)
  async source(version, name, section) {
    if (typeof this.reader.pageSource !== "function") return null;
    try {
      const src = await this.reader.pageSource(version, name, section);
      return src?.package ? `${src.package}${src.license ? ` (license: ${src.license})` : ""}` : null;
    } catch {
      return null;
    }
  }

  // Read a page through a small LRU cache
  async read(version, name, section) {
    const key = `${version}:${name}.${section}`;
    if (this.cache.has(key)) {
      const hit = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const text = await this.reader.readPage(version, name, section);
    if (text !== null && text !== undefined) {
      this.cache.set(key, text);
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    }
    return text ?? null;
  }

  // Find a page: { name, section, others } or { error }
  async resolve(version, page, sectionArg) {
    const { byName, byLower } = await this.index(version);
    let { name, section } = parsePageRef(page, sectionArg);
    let found = byName.has(name) ? name : undefined;

    // "sssd.conf.5": a trailing section suffix
    if (!found && !section) {
      const dot = name.lastIndexOf(".");
      const base = name.slice(0, dot);
      const sfx = name.slice(dot + 1);
      if (dot > 0 && SECTION_RE.test(sfx) && byName.get(base)?.includes(sfx)) {
        found = base;
        section = sfx;
      }
    }
    if (!found) found = byLower.get(name.toLowerCase())?.[0];

    if (!found) {
      const { names, total } = suggestNames([...byName.keys()], name);
      if (!names.length) {
        return { error: `No man page named "${name}" on RHEL ${version}. Use searchManPages to find pages that mention it, or listManPages to browse names.` };
      }
      const shown = names.map((n) => byName.get(n).map((s) => ref(n, s)).join(", ")).join(", ");
      const more = total > names.length ? ` (${names.length} of ${total} names; narrow with listManPages filter)` : "";
      return { error: `No man page named "${name}" on RHEL ${version}. Closest names${more}: ${shown}.` };
    }

    const sections = byName.get(found);
    if (section && !sections.includes(section)) {
      return { error: `${ref(found, section)} does not exist on RHEL ${version}. Available: ${sections.map((s) => ref(found, s)).join(", ")}.` };
    }
    const chosen = section || sections[0];
    return { name: found, section: chosen, others: sections.filter((s) => s !== chosen) };
  }
}

// --- Headings ---

// Top-level headings (no indent) and subsection headings (3-space indent); skips the title
// and footer lines. Each heading spans to the next heading of the same or higher level.
export function parseHeadings(text) {
  const lines = text.split("\n");
  const starts = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const nonblank = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  const first = nonblank[0];
  const last = nonblank.at(-1);
  const footerStart = last !== undefined && last !== first ? starts[last] : text.length;

  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === first || i === last) continue;
    const line = lines[i];
    const t = line.trim();
    if (!t || t.length > 80) continue;
    const ind = indentOf(line);
    // A subsection heading follows a blank line or directly follows a top-level heading
    const prevBlank = i === 0 || !lines[i - 1].trim() || (indentOf(lines[i - 1]) === 0 && i - 1 !== first);
    if (ind === 0) found.push({ title: collapse(t), level: 1, start: starts[i] });
    else if (ind === 3 && prevBlank && !/[.,;]$/.test(t)) {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next !== undefined && indentOf(next) > 3) found.push({ title: collapse(t).replace(/:$/, ""), level: 2, start: starts[i] });
    }
  }
  for (let k = 0; k < found.length; k++) {
    const h = found[k];
    const next = found.slice(k + 1).find((n) => n.level <= h.level);
    h.end = next ? next.start : footerStart;
  }
  return found;
}

// Find a heading by exact title, then prefix, then substring (ignoring case)
export function findHeading(headings, wanted) {
  const w = collapse(wanted).toLowerCase().replace(/:$/, "");
  if (!w) return { error: "heading is empty" };
  const exact = headings.filter((h) => h.title.toLowerCase() === w);
  if (exact.length) return { heading: exact[0] };
  for (const test of [(t) => t.startsWith(w), (t) => t.includes(w)]) {
    const hits = headings.filter((h) => test(h.title.toLowerCase()));
    if (hits.length === 1) return { heading: hits[0] };
    if (hits.length > 1) return { error: `Heading "${wanted}" matches ${hits.length} headings: ${hits.map((h) => h.title).join("; ")}. Pass one of them.` };
  }
  return { error: `No heading "${wanted}". Headings: ${formatOutline(headings)}.` };
}

export function formatOutline(headings) {
  return headings.map((h) => `${h.level === 2 ? "> " : ""}${h.title} (${h.end - h.start} chars)`).join("; ");
}

// --- Options ---

// Definition-list entries whose term names the option: the term line names it first (or in
// a leading comma list such as "-a, --all" or "ldap_min_id, ldap_max_id (integer)"), and
// the following lines are indented deeper.
export function findOptionEntries(text, option, max = 10) {
  const opt = String(option ?? "").trim();
  if (!opt) throw new Error("option is required, e.g. \"ldap_id_mapping\" or \"PermitRootLogin\"");
  const re = new RegExp(`(^|[\\s,\\[|])${escapeRegExp(opt)}(?=$|[\\s,=\\[(:|<])`, "i");
  const lines = text.split("\n");
  const headings = [];
  const entries = [];
  for (let i = 0; i < lines.length && entries.length < max; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    const ind = indentOf(line);
    if (ind <= 3 && i > 0) {
      if (ind === 0) headings.length = 0;
      headings[ind === 0 ? 0 : 1] = collapse(t);
    }
    if (ind === 0 || t.length > 120) continue;
    const m = re.exec(t);
    if (!m) continue;
    const prefix = t.slice(0, m.index + m[1].length);
    if (!/^([^\s,]+,\s*)*$/.test(prefix)) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length || indentOf(lines[j]) <= ind) continue;
    let k = j;
    while (k < lines.length && (!lines[k].trim() || indentOf(lines[k]) > ind)) k++;
    while (k > i && !lines[k - 1].trim()) k--;
    const block = lines.slice(i, k).map((l) => l.slice(Math.min(ind, indentOf(l) || ind))).join("\n");
    // Read the default from the entry's own description, not from nested entries
    const own = lines.slice(j, k).filter((l) => !l.trim() || indentOf(l) === indentOf(lines[j])).join("\n");
    entries.push({ line: i + 1, term: t, context: headings.filter(Boolean).join(" > "), text: block, default: extractDefault(own) });
    i = k - 1;
  }
  return entries;
}

// The default a description states, if it states one
export function extractDefault(block) {
  for (const line of block.split("\n")) {
    const m = line.trim().match(/^Defaults?(?: value)?\s*:\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  const flat = collapse(block);
  const m = flat.match(/\b(?:the )?default(?: value)? is:?\s+(.+?)(?:\.(?:\s|$)|;|$)/i)
    || flat.match(/\bdefaults to\s+(.+?)(?:\.(?:\s|$)|;|$)/i);
  return m ? m[1].trim().slice(0, 200) : undefined;
}

export function formatOptionEntries(name, section, version, entries, source) {
  const pkg = source ? `\n**Package:** ${source}` : "";
  return entries.map((e) => {
    const where = e.context ? ` in ${e.context}` : "";
    const def = e.default !== undefined ? `\n**Default:** ${e.default}` : "";
    return `### ${ref(name, section)} RHEL ${version}, line ${e.line}${where}${def}${pkg}\n\n\`\`\`\n${e.text}\n\`\`\``;
  }).join("\n\n");
}

// --- Search ---

export function buildMatcher(query, regex = false) {
  const q = String(query ?? "");
  if (!q.trim()) throw new Error("query is empty");
  if (q.length > MAX_QUERY_LENGTH) throw new Error(`query is longer than ${MAX_QUERY_LENGTH} characters`);
  if (!regex) return new RegExp(escapeRegExp(q), "i");
  try {
    return new RegExp(q, "i");
  } catch (err) {
    throw new Error(`Invalid regular expression "${q}": ${String(err.message).replace(/^Invalid regular expression: /, "")}. Pass regex: false to search for the text literally.`);
  }
}

// Match page names: a regex when it compiles, otherwise literal text
export function nameMatcher(filter) {
  if (filter === undefined || filter === null || filter === "") return null;
  try {
    return new RegExp(filter, "i");
  } catch {
    return new RegExp(escapeRegExp(filter), "i");
  }
}

// Matching lines of one page: total count and the first `keep` with context
export function searchText(text, matcher, { contextLines = 2, keep = 3 } = {}) {
  const lines = text.split("\n");
  const hits = [];
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!matcher.test(lines[i])) continue;
    count++;
    if (hits.length >= keep) continue;
    const start = Math.max(0, i - contextLines);
    const end = Math.min(lines.length - 1, i + contextLines);
    const context = lines.slice(start, end + 1).map((l, k) => `${k + start === i ? ">" : " "} ${l}`).join("\n");
    hits.push({ line: i + 1, context });
  }
  return { count, hits };
}

export function formatSearch({ query, version, results, stopped, scope }) {
  if (!results.length) return `No matches for "${query}" in RHEL ${version} man pages${scope}.`;
  const more = stopped ? ` Stopped after ${results.length} pages, so more may exist: narrow with page, nameFilter, or section, or raise maxPages.` : "";
  const head = `## "${query}" in RHEL ${version} man pages${scope}: ${results.length} page${results.length === 1 ? "" : "s"}.${more}`;
  const body = results.map((r) => {
    const shown = r.hits.length < r.count ? ` (showing ${r.hits.length})` : "";
    const hits = r.hits.map((h) => `line ${h.line}:\n\`\`\`\n${h.context}\n\`\`\``).join("\n");
    return `### ${ref(r.name, r.section)}: ${r.count} matching line${r.count === 1 ? "" : "s"}${shown}\n${hits}`;
  }).join("\n\n");
  return `${head}\n\n${body}`;
}

// --- Comparison ---

// The page body without the title and footer lines
export function bodyLines(text) {
  const lines = text.split("\n");
  const nonblank = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  if (nonblank.length < 3) return lines;
  return lines.slice(nonblank[0] + 1, nonblank.at(-1));
}

// Paragraphs with whitespace collapsed, so rewrapped text compares equal
export function paragraphs(text) {
  return bodyLines(text).join("\n").split(/\n\s*\n/).map(collapse).filter(Boolean);
}

// Definition-list terms (options, directives, flags) and their normalized descriptions
export function optionTerms(text) {
  const lines = bodyLines(text);
  const terms = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const ind = indentOf(line);
    // Indent 3 holds subsection headings; terms sit deeper
    if (!t || ind <= 3 || ind > 16 || t.length > 80 || /[.:;,]$/.test(t)) continue;
    // A term starts a block: after a blank line or directly under a less indented heading
    if (i > 0 && lines[i - 1].trim() && indentOf(lines[i - 1]) >= ind) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length || indentOf(lines[j]) <= ind) continue;
    let k = j;
    while (k < lines.length && (!lines[k].trim() || indentOf(lines[k]) > ind)) k++;
    // Key by name without a trailing "(type)", so a changed type reads as a changed entry
    const term = collapse(t);
    const key = term.replace(/\s*\([^)]*\)$/, "") || term;
    if (!terms.has(key)) terms.set(key, `${term} ${collapse(lines.slice(j, k).join(" "))}`);
  }
  return terms;
}

export function comparePages(a, b) {
  const pa = paragraphs(a);
  const pb = paragraphs(b);
  const sa = new Set(pa);
  const sb = new Set(pb);
  const ta = optionTerms(a);
  const tb = optionTerms(b);
  return {
    identical: a === b,
    sameText: pa.length === pb.length && pa.every((p, i) => p === pb[i]),
    added: pb.filter((p) => !sa.has(p)),
    removed: pa.filter((p) => !sb.has(p)),
    optionsAdded: [...tb.keys()].filter((k) => !ta.has(k)),
    optionsRemoved: [...ta.keys()].filter((k) => !tb.has(k)),
    optionsChanged: [...tb.keys()].filter((k) => ta.has(k) && ta.get(k) !== tb.get(k)),
  };
}

export function formatComparison({ name, section, v1, v2, a, b, src1, src2 }) {
  const d = comparePages(a, b);
  const lines = (t) => t.split("\n").length;
  const from = (src) => (src ? `, from ${src}` : "");
  let out = `## ${ref(name, section)}: RHEL ${v1} vs RHEL ${v2}\n\n- RHEL ${v1}: ${lines(a)} lines${from(src1)}\n- RHEL ${v2}: ${lines(b)} lines${from(src2)}\n`;
  if (d.identical) return `${out}\nThe pages are identical.`;
  if (d.sameText) return `${out}\nThe text is the same; only line wrapping, spacing, or the title and footer lines differ.`;
  const list = (title, items) => (items.length ? `\n### ${title} (${items.length})\n${items.map((x) => `- \`${x}\``).join("\n")}\n` : "");
  out += list(`Options and entries added in RHEL ${v2}`, d.optionsAdded);
  out += list(`Options and entries removed in RHEL ${v2}`, d.optionsRemoved);
  out += list("Options and entries whose description changed", d.optionsChanged);
  const paras = (title, items, mark) => (items.length ? `\n### ${title} (${items.length} paragraphs)\n${items.map((p) => `${mark} ${p}`).join("\n")}\n` : "");
  out += paras(`Text only in RHEL ${v2}`, d.added, "+");
  out += paras(`Text only in RHEL ${v1}`, d.removed, "-");
  return out;
}

// --- Character pagination ---

export function paginate(text, offset, limit, label, notes = []) {
  const total = text.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + limit, total);
  const slice = text.slice(start, end);
  const noteText = notes.filter(Boolean).map((n) => `> ${n}\n`).join("");
  const header = `# ${label}\n# chars ${start}-${end} of ${total}\n${noteText}\n`;
  let footer = "";
  if (end < total) {
    footer = `\n\n[truncated: showing chars ${start}-${end} of ${total}. Call again with offset=${end} for the next chunk.]`;
  } else if (offset > 0 && offset >= total) {
    footer = `[offset ${offset} is past the end of the ${total}-character response. Call again with a smaller offset.]`;
  }
  return `${header}${slice}${footer}`;
}
