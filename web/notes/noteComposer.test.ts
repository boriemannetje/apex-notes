import test from "node:test";
import assert from "node:assert/strict";
import {
  bodyFromText,
  cleanTitleText,
  composeRaw,
  createNoteRaw,
  escapeYaml,
  getAvailableDisplayTitle,
  getAvailableNewNotePath,
  titleFromText
} from "./noteComposer.ts";

test("composeRaw writes canonical title and parent frontmatter and removes schema extras", () => {
  const raw = composeRaw(
    {
      frontmatterEntries: [
        { key: "title", lines: ['title: "Old"'] },
        { key: "level", lines: ["level: 4"] },
        { key: "group", lines: ["group: legacy"] },
        { key: "custom", lines: ["custom: keep-me"] }
      ]
    },
    "# Body\n",
    { title: 'New "Title"', parentRef: "[[parent-note]]" }
  );

  assert.equal(
    raw,
    "---\ntitle: \"New \\\"Title\\\"\"\nparent: \"[[parent-note]]\"\n---\n\n# Body\n"
  );
});

test("createNoteRaw creates loose/root notes without schema extras", () => {
  assert.equal(
    createNoteRaw({ title: "Loose", parent: null, body: "# Loose\n" }),
    "---\ntitle: \"Loose\"\nparent: null\n---\n\n# Loose\n"
  );
});

test("createNoteRaw creates immediate child frontmatter from parent basename", () => {
  assert.match(
    createNoteRaw({ title: "Child", parent: { basename: "parent-note" } }),
    /parent: "\[\[parent-note\]\]"/
  );
});

test("titleFromText and bodyFromText preserve pasted Markdown content", () => {
  const text = "# Pasted Loose\n\nA loose pasted note.";

  assert.equal(titleFromText(text), "Pasted Loose");
  assert.equal(bodyFromText(text, "Pasted Loose"), "# Pasted Loose\n\nA loose pasted note.\n");
});

test("available display titles and filenames avoid collisions deterministically", () => {
  assert.equal(getAvailableDisplayTitle("Root", new Set(["root", "root 2"])), "Root 3");
  assert.equal(getAvailableNewNotePath("Root", new Set(["root.md", "root-2.md"])), "root-3.md");
});

test("cleanTitleText handles Markdown punctuation, whitespace, empties, and length", () => {
  assert.equal(cleanTitleText("#   Lots   of   space", "Fallback"), "Lots of space");
  assert.equal(cleanTitleText("", "Fallback"), "Fallback");
  assert.equal(cleanTitleText("x".repeat(100), "Fallback").length, 56);
});

test("escapeYaml escapes quotes and backslashes", () => {
  assert.equal(escapeYaml('a "quote" and \\ slash'), 'a \\"quote\\" and \\\\ slash');
});
