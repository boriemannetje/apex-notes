import test from "node:test";
import assert from "node:assert/strict";
import {
  measureWorkspaceHistoryEntryRawBytes,
  trimWorkspaceHistoryStack,
  trimWorkspaceHistoryStacks
} from "./historyBudget.ts";

type TestEntry = { id: string; bytes: number };

function entry(id: string, bytes: number): TestEntry {
  return { id, bytes };
}

const measureEntryBytes = (item: TestEntry) => item.bytes;

test("measureWorkspaceHistoryEntryRawBytes measures UTF-8 string bytes", () => {
  assert.equal(measureWorkspaceHistoryEntryRawBytes("é\n"), 3);
  assert.ok(
    measureWorkspaceHistoryEntryRawBytes({
      notes: [{ path: "note.md", beforeRaw: null, afterRaw: "---\ntitle: \"A\"\n---\n" }]
    }) > 20
  );
});

test("trimWorkspaceHistoryStack keeps the newest entries within the count limit", () => {
  const entries = [entry("old", 1), entry("middle", 1), entry("new", 1)];

  const trimmed = trimWorkspaceHistoryStack(entries, {
    maxEntries: 2,
    measureEntryBytes
  });

  assert.deepEqual(trimmed.map((item) => item.id), ["middle", "new"]);
  assert.deepEqual(entries.map((item) => item.id), ["old", "middle", "new"]);
});

test("trimWorkspaceHistoryStack keeps the newest contiguous entries within the byte limit", () => {
  const entries = [entry("old", 4), entry("middle", 5), entry("new", 6)];

  assert.deepEqual(
    trimWorkspaceHistoryStack(entries, {
      maxBytes: 11,
      measureEntryBytes
    }).map((item) => item.id),
    ["middle", "new"]
  );

  assert.deepEqual(
    trimWorkspaceHistoryStack(entries, {
      maxBytes: 10,
      measureEntryBytes
    }).map((item) => item.id),
    ["new"]
  );
});

test("trimWorkspaceHistoryStack keeps the newest entry when it is oversized", () => {
  const entries = [entry("old", 1), entry("oversized", 12)];

  const trimmed = trimWorkspaceHistoryStack(entries, {
    maxBytes: 5,
    measureEntryBytes
  });

  assert.deepEqual(trimmed.map((item) => item.id), ["oversized"]);
});

test("trimWorkspaceHistoryStacks trims redo history with the same stack rules", () => {
  const undoStack = [entry("undo-old", 1), entry("undo-new", 1)];
  const redoStack = [entry("redo-old", 1), entry("redo-middle", 1), entry("redo-new", 1)];

  const trimmed = trimWorkspaceHistoryStacks(
    { undoStack, redoStack },
    {
      maxEntries: 2,
      measureEntryBytes
    }
  );

  assert.deepEqual(trimmed.undoStack.map((item) => item.id), ["undo-old", "undo-new"]);
  assert.deepEqual(trimmed.redoStack.map((item) => item.id), ["redo-middle", "redo-new"]);
  assert.notEqual(trimmed.redoStack, redoStack);
});
