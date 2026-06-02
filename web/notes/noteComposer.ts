import { normalizeKey, slugify } from "../noteRefs.ts";
import { parseFrontmatter, splitMarkdown } from "./noteParser.ts";

type ComposeNote = object;

interface ComposeValues {
  title: string;
  parentRef?: string | null;
}

interface NoteParent {
  basename: string;
}

export function composeRaw(_note: ComposeNote, body: string, values: ComposeValues): string {
  const lines = [
    `title: "${escapeYaml(values.title)}"`,
    values.parentRef ? `parent: "${escapeYaml(values.parentRef)}"` : "parent: null"
  ];

  const cleanBody = body || "";
  return `---\n${lines.join("\n")}\n---\n\n${cleanBody}${cleanBody.endsWith("\n") ? "" : "\n"}`;
}

export function createNoteRaw({
  title,
  parent,
  body
}: {
  title: string;
  parent: NoteParent | null;
  body?: string;
}): string {
  return [
    "---",
    `title: "${escapeYaml(title)}"`,
    parent ? `parent: "[[${parent.basename}]]"` : "parent: null",
    "---",
    "",
    body || `# ${title}\n`
  ].join("\n");
}

export function getAvailableDisplayTitle(title: string, reservedTitles: Set<string>): string {
  const base = String(title || "").trim() || "Untitled note";
  let candidate = base;
  let suffix = 2;
  while (reservedTitles.has(normalizeKey(candidate))) {
    candidate = `${base} ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function getAvailableNewNotePath(title: string, reservedPaths: Set<string>): string {
  const base = slugify(title) || "untitled";
  const existing = new Set([...reservedPaths].map((path) => path.toLowerCase()));
  let suffix = 0;

  while (true) {
    const filename = `${base}${suffix ? `-${suffix + 1}` : ""}.md`;
    if (!existing.has(filename.toLowerCase())) return filename;
    suffix += 1;
  }
}

export function titleFromText(text: string, fallback = "Pasted note"): string {
  const parsed = splitMarkdown(text);
  const frontmatter = parseFrontmatter(parsed.frontmatterRaw);
  if (frontmatter.values.title) return frontmatter.values.title;

  const body = parsed.body || text;
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return cleanTitleText(heading[1], fallback);

  return cleanTitleText(body, fallback);
}

export function cleanTitleText(text: string, fallback: string): string {
  const words = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]().,!?:;"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  const title = words.join(" ").slice(0, 56).trim();
  return title || fallback;
}

export function bodyFromText(text: string, title: string): string {
  const parsed = splitMarkdown(text);
  const body = (parsed.hasFrontmatter ? parsed.body : text).trim();
  return body ? `${body}\n` : `# ${title}\n`;
}

export function escapeYaml(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
