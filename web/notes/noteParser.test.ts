import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, parseNote, splitMarkdown, stripQuotes } from "./noteParser.ts";

test("splitMarkdown separates YAML frontmatter from the Markdown body", () => {
  assert.deepEqual(splitMarkdown("---\ntitle: \"Apex\"\nlevel: 0\n---\n\n# Body\n"), {
    hasFrontmatter: true,
    frontmatterRaw: 'title: "Apex"\nlevel: 0',
    body: "# Body\n"
  });
});

test("splitMarkdown treats missing closing delimiter as body text", () => {
  assert.deepEqual(splitMarkdown("---\ntitle: Broken\n# Body\n"), {
    hasFrontmatter: false,
    frontmatterRaw: "",
    body: "---\ntitle: Broken\n# Body\n"
  });
});

test("parseFrontmatter preserves unknown entry lines and strips simple quotes", () => {
  const parsed = parseFrontmatter("title: \"Quoted\"\ncustom:\n  - one\nparent: '[[root]]'");

  assert.equal(parsed.values.title, "Quoted");
  assert.equal(parsed.values.parent, "[[root]]");
  assert.deepEqual(parsed.entries, [
    { key: "title", lines: ['title: "Quoted"'] },
    { key: "custom", lines: ["custom:", "  - one"] },
    { key: "parent", lines: ["parent: '[[root]]'"] }
  ]);
});

test("parseNote parses title, parent, refs, aliases, search text, and ignores legacy level", () => {
  const note = parseNote(
    "area/child.md",
    "---\ntitle: \"Child Note\"\nlevel: 99\nparent: \"[[parent]]\"\n---\n\n# Ignored Heading\nLinks [[Sibling]] and [[Other|alias]].\n"
  );

  assert.equal(note.path, "area/child.md");
  assert.equal(note.basename, "child");
  assert.equal(note.title, "Child Note");
  assert.equal(note.level, 0);
  assert.equal(note.parentRef, "[[parent]]");
  assert.equal(note.hasFrontmatter, true);
  assert.equal(note.hasTitle, true);
  assert.equal(note.hasParent, true);
  assert.equal(note.frontmatterValues.level, "99");
  assert.deepEqual(note.bodyRefs.map((ref) => ref.ref), ["Sibling", "Other"]);
  assert.ok(note.keys.includes("child note"));
  assert.ok(note.searchText.includes("child note area/child.md"));
});

test("parseNote falls back to heading/path for loose malformed notes", () => {
  const note = parseNote("loose.md", "# Loose\n\nNo frontmatter");

  assert.equal(note.title, "Loose");
  assert.equal(note.level, 0);
  assert.equal(note.parentRef, null);
  assert.equal(note.hasFrontmatter, false);
  assert.equal(note.hasTitle, false);
  assert.equal(note.hasParent, false);
});

test("stripQuotes only removes matching outer quote pairs", () => {
  assert.equal(stripQuotes('"hello"'), "hello");
  assert.equal(stripQuotes("'hello'"), "hello");
  assert.equal(stripQuotes('"hello'), '"hello');
});
