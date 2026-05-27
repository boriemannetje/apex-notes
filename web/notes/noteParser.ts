import { getNoteAliasKeys, parseWikiRefs } from "../noteRefs.ts";

export interface FrontmatterEntry {
  key: string | null;
  lines: string[];
}

export interface ParsedFrontmatter {
  entries: FrontmatterEntry[];
  values: Record<string, string>;
}

export interface SplitMarkdown {
  hasFrontmatter: boolean;
  frontmatterRaw: string;
  body: string;
}

export interface ParsedNote {
  path: string;
  pathNoExt: string;
  basename: string;
  title: string;
  level: number;
  declaredLevel: number | null;
  derivedLevel: number | null;
  rawLevel: string | undefined;
  hasFrontmatter: boolean;
  hasLevel: boolean;
  hasTitle: boolean;
  parentRef: string | null;
  raw: string;
  frontmatterRaw: string;
  frontmatterEntries: FrontmatterEntry[];
  frontmatterValues: Record<string, string>;
  body: string;
  bodyRefs: ReturnType<typeof parseWikiRefs>;
  bodyRefNotes: ParsedNote[];
  searchText: string;
  keys: string[];
  parentNote: ParsedNote | null;
  children: ParsedNote[];
}

export function parseNote(path: string, raw: string): ParsedNote {
  const parsed = splitMarkdown(raw);
  const frontmatter = parseFrontmatter(parsed.frontmatterRaw);
  const body = parsed.body;
  const pathNoExt = path.replace(/\.md$/i, "");
  const basename = pathNoExt.split("/").pop() || pathNoExt;
  const heading = body.match(/^#\s+(.+)$/m);
  const title = frontmatter.values.title || (heading && heading[1].trim()) || basename;
  const level = Number.parseInt(frontmatter.values.level, 10);
  const bodyRefs = parseWikiRefs(body);
  const searchText = `${title} ${path} ${raw}`.toLowerCase();
  const keys = new Set(getNoteAliasKeys(path, title));

  return {
    path,
    pathNoExt,
    basename,
    title,
    level: Number.isFinite(level) ? level : 4,
    declaredLevel: Number.isFinite(level) ? level : null,
    derivedLevel: null,
    rawLevel: frontmatter.values.level,
    hasFrontmatter: parsed.hasFrontmatter,
    hasLevel: Object.prototype.hasOwnProperty.call(frontmatter.values, "level") && Number.isFinite(level),
    hasTitle: Object.prototype.hasOwnProperty.call(frontmatter.values, "title"),
    parentRef: frontmatter.values.parent || null,
    raw,
    frontmatterRaw: parsed.frontmatterRaw,
    frontmatterEntries: frontmatter.entries,
    frontmatterValues: frontmatter.values,
    body,
    bodyRefs,
    bodyRefNotes: [],
    searchText,
    keys: [...keys],
    parentNote: null,
    children: []
  };
}

export function splitMarkdown(raw: string): SplitMarkdown {
  if (!raw.startsWith("---")) {
    return {
      hasFrontmatter: false,
      frontmatterRaw: "",
      body: raw
    };
  }

  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) {
    return {
      hasFrontmatter: false,
      frontmatterRaw: "",
      body: raw
    };
  }

  const frontmatterRaw = raw.slice(3, endIndex).replace(/^\n/, "").replace(/\s+$/, "");
  const body = raw.slice(endIndex + 4).replace(/^\s*\n/, "");
  return {
    hasFrontmatter: true,
    frontmatterRaw,
    body
  };
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw ? raw.split("\n") : [];
  const entries: FrontmatterEntry[] = [];
  const values: Record<string, string> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      entries.push({ key: null, lines: [line] });
      index += 1;
      continue;
    }

    const key = match[1];
    const entryLines = [line];
    index += 1;
    while (index < lines.length && !lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)) {
      entryLines.push(lines[index]);
      index += 1;
    }
    entries.push({ key, lines: entryLines });
    values[key] = stripQuotes(match[2].trim());
  }

  return { entries, values };
}

export function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
