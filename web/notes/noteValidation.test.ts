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
