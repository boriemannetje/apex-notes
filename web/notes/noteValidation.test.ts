import test from "node:test";
import assert from "node:assert/strict";

import { createGraphIndex } from "../graphModel.ts";
import { parseNote } from "./noteParser.ts";
import { validateNotes } from "./noteValidation.ts";

test("validateNotes requires the parent frontmatter key", () => {
  const note = parseNote("missing-parent-key.md", "---\ntitle: \"Missing Parent Key\"\n---\n\n# Missing Parent Key\n");
  const byPath = new Map([[note.path, note]]);
  const graphIndex = createGraphIndex([note]);

  assert.deepEqual(
    validateNotes([note], graphIndex, byPath).map((issue) => issue.message),
    ["Missing Parent Key is missing a parent"]
  );
});

test("validateNotes accepts nullish parent values as loose/root notes", () => {
  for (const parentLine of ["parent: null", "parent:", "parent: undefined", "parent: ~"]) {
    const note = parseNote("root.md", `---\ntitle: "Root"\n${parentLine}\n---\n\n# Root\n`);
    const byPath = new Map([[note.path, note]]);
    const graphIndex = createGraphIndex([note]);

    assert.deepEqual(
      validateNotes([note], graphIndex, byPath).map((issue) => issue.message),
      []
    );
  }
});
