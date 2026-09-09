import assert from "node:assert/strict";
import test from "node:test";
import { history, historyField, redo, undo, undoDepth } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { lineAnchor, seedNoteDates, type NoteDates } from "../notes/noteDates.ts";
import {
  createDateTrackingExtension,
  getEditorNoteDates,
  setNoteDates
} from "./dateDecorations.ts";

function dispatch(state: EditorState, spec: Parameters<EditorState["update"]>[0]) {
  return state.update(spec).state;
}

function runCommand(state: EditorState, command: typeof undo) {
  let next = state;
  const applied = command({
    state,
    dispatch(transaction) {
      next = transaction.state;
    }
  });
  assert.equal(applied, true);
  return next;
}

test("hydration replaces text and dates without restamping", () => {
  let currentDay = "2026-09-09";
  let state = EditorState.create({
    extensions: createDateTrackingExtension({ getDay: () => currentDay })
  });
  const hydrated = seedNoteDates("alpha", { isNew: true, day: "2026-09-08" });

  currentDay = "2026-09-10";
  state = dispatch(state, {
    changes: { from: 0, insert: "alpha" },
    effects: setNoteDates.of(hydrated),
    annotations: Transaction.addToHistory.of(false)
  });

  assert.deepEqual(getEditorNoteDates(state), hydrated);
});

test("edits capture the day when the transaction is applied", () => {
  let currentDay = "2026-09-09";
  const initial = seedNoteDates("alpha", { isNew: true, day: "2026-09-08" });
  let state = EditorState.create({
    doc: "alpha",
    extensions: createDateTrackingExtension({ getDay: () => currentDay })
  });
  state = dispatch(state, {
    effects: setNoteDates.of(initial),
    annotations: Transaction.addToHistory.of(false)
  });

  currentDay = "2026-09-10";
  state = dispatch(state, { changes: { from: 5, insert: "!" } });

  const dates = getEditorNoteDates(state);
  assert.deepEqual(dates?.created, initial.created);
  assert.equal(dates?.lines[0]?.day, "2026-09-10");
  assert.equal(dates?.lines[0]?.estimated, false);
});

test("null metadata leaves date tracking disabled", () => {
  let getDayCalls = 0;
  let state = EditorState.create({
    doc: "alpha",
    extensions: createDateTrackingExtension({
      getDay() {
        getDayCalls += 1;
        return "2026-09-09";
      }
    })
  });

  state = dispatch(state, { changes: { from: 5, insert: "!" } });

  assert.equal(getEditorNoteDates(state), null);
  assert.equal(getDayCalls, 0);
});

test("transaction mapping preserves untouched duplicate lines between edits", () => {
  const body = "A\nsame\nsame\nB";
  const initial: NoteDates = {
    created: { day: "2026-09-01", estimated: false },
    lines: body.split("\n").map((line, index) => ({
      anchor: lineAnchor(line),
      day: `2026-09-0${index + 1}`,
      estimated: false
    }))
  };
  let state = EditorState.create({
    doc: body,
    extensions: createDateTrackingExtension({ getDay: () => "2026-09-09" })
  });
  state = dispatch(state, {
    effects: setNoteDates.of(initial),
    annotations: Transaction.addToHistory.of(false)
  });

  state = dispatch(state, {
    changes: [
      { from: 0, to: 1, insert: "X" },
      { from: 12, to: 13, insert: "Y" }
    ]
  });

  const dates = getEditorNoteDates(state);
  assert.deepEqual(dates?.lines.map((line) => line.day), [
    "2026-09-09",
    "2026-09-02",
    "2026-09-03",
    "2026-09-09"
  ]);
  assert.equal(dates?.lines[1], initial.lines[1]);
  assert.equal(dates?.lines[2], initial.lines[2]);
});

test("boundary edits preserve the following line when a first line becomes blank or gains text", () => {
  const exactDays = (body: string): NoteDates => ({
    created: { day: "2026-09-01", estimated: false },
    lines: body.split("\n").map((line, index) => ({
      anchor: lineAnchor(line),
      day: `2026-09-0${index + 1}`,
      estimated: false
    }))
  });

  for (const scenario of [
    { body: "abc\nX", change: { from: 0, to: 3, insert: "" }, expected: "\nX" },
    { body: "\nX", change: { from: 0, to: 0, insert: "abc" }, expected: "abc\nX" }
  ]) {
    const initial = exactDays(scenario.body);
    let state = EditorState.create({
      doc: scenario.body,
      extensions: [history(), createDateTrackingExtension({ getDay: () => "2026-09-09" })]
    });
    state = dispatch(state, {
      effects: setNoteDates.of(initial),
      annotations: Transaction.addToHistory.of(false)
    });
    state = dispatch(state, { changes: scenario.change });

    assert.equal(state.doc.toString(), scenario.expected);
    assert.equal(getEditorNoteDates(state)?.lines[0]?.day, "2026-09-09");
    assert.equal(getEditorNoteDates(state)?.lines[1], initial.lines[1]);

    state = runCommand(state, undo);
    assert.equal(state.doc.toString(), scenario.body);
    assert.deepEqual(getEditorNoteDates(state), initial);
    state = runCommand(state, redo);
    assert.equal(state.doc.toString(), scenario.expected);
    assert.equal(getEditorNoteDates(state)?.lines[1]?.day, "2026-09-02");
  }
});

test("oversized edits retain bounded metadata and recover after shrinking", () => {
  const initial = seedNoteDates("alpha", { isNew: true, day: "2026-09-08" });
  let state = EditorState.create({
    doc: "alpha",
    extensions: createDateTrackingExtension({ getDay: () => "2026-09-09" })
  });
  state = dispatch(state, {
    effects: setNoteDates.of(initial),
    annotations: Transaction.addToHistory.of(false)
  });

  state = dispatch(state, { changes: { from: 5, insert: "\n".repeat(100_000) } });
  assert.equal(state.doc.lines, 100_001);
  assert.deepEqual(getEditorNoteDates(state), initial);

  state = dispatch(state, { changes: { from: 0, to: state.doc.length, insert: "beta" } });
  assert.equal(state.doc.toString(), "beta");
  assert.equal(getEditorNoteDates(state)?.lines[0]?.day, "2026-09-09");
  assert.deepEqual(getEditorNoteDates(state)?.created, initial.created);
});

test("undo and redo restore grouped cross-midnight text and dates atomically", () => {
  let currentDay = "2026-09-08";
  const initial = seedNoteDates("a", { isNew: true, day: "2026-09-07" });
  let state = EditorState.create({
    doc: "a",
    extensions: [history(), createDateTrackingExtension({ getDay: () => currentDay })]
  });
  state = dispatch(state, {
    effects: setNoteDates.of(initial),
    annotations: Transaction.addToHistory.of(false)
  });

  state = dispatch(state, {
    changes: { from: 1, insert: "b" },
    annotations: Transaction.userEvent.of("input.type")
  });
  assert.equal(getEditorNoteDates(state)?.lines[0]?.day, "2026-09-08");

  currentDay = "2026-09-09";
  state = dispatch(state, {
    changes: { from: 2, insert: "c" },
    annotations: Transaction.userEvent.of("input.type")
  });
  assert.equal(state.doc.toString(), "abc");
  assert.equal(getEditorNoteDates(state)?.lines[0]?.day, "2026-09-09");
  assert.equal(undoDepth(state), 1);

  state = runCommand(state, undo);
  assert.equal(state.doc.toString(), "a");
  assert.deepEqual(getEditorNoteDates(state), initial);

  state = runCommand(state, redo);
  assert.equal(state.doc.toString(), "abc");
  assert.equal(getEditorNoteDates(state)?.lines[0]?.day, "2026-09-09");
});

test("grouped multiline deletion and insertion restore compact date deltas across midnight", () => {
  const body = "A\nB\nC\nD";
  const initial: NoteDates = {
    created: { day: "2026-09-01", estimated: false },
    lines: body.split("\n").map((line, index) => ({
      anchor: lineAnchor(line),
      day: `2026-09-0${index + 1}`,
      estimated: false
    }))
  };
  let currentDay = "2026-09-09";
  let state = EditorState.create({
    doc: body,
    extensions: [history(), createDateTrackingExtension({ getDay: () => currentDay })]
  });
  state = dispatch(state, {
    effects: setNoteDates.of(initial),
    annotations: Transaction.addToHistory.of(false)
  });

  state = dispatch(state, {
    changes: { from: 2, to: 4 },
    annotations: Transaction.userEvent.of("delete")
  });
  currentDay = "2026-09-10";
  state = dispatch(state, {
    changes: { from: 2, insert: "X\nY\n" },
    annotations: Transaction.userEvent.of("input.type")
  });

  assert.equal(state.doc.toString(), "A\nX\nY\nC\nD");
  assert.equal(undoDepth(state), 1);
  assert.deepEqual(getEditorNoteDates(state)?.lines.map((line) => line.day), [
    "2026-09-01", "2026-09-10", "2026-09-10", "2026-09-03", "2026-09-04"
  ]);

  state = runCommand(state, undo);
  assert.equal(state.doc.toString(), body);
  assert.deepEqual(getEditorNoteDates(state), initial);

  state = runCommand(state, redo);
  assert.equal(state.doc.toString(), "A\nX\nY\nC\nD");
  assert.deepEqual(getEditorNoteDates(state)?.lines.map((line) => line.day), [
    "2026-09-01", "2026-09-10", "2026-09-10", "2026-09-03", "2026-09-04"
  ]);
});

test("history retains only touched line metadata for grouped edits in a large note", () => {
  const body = Array.from({ length: 2_000 }, (_, index) => `line-${index}`).join("\n");
  let state = EditorState.create({
    doc: body,
    extensions: [history(), createDateTrackingExtension({ getDay: () => "2026-09-09" })]
  });
  state = dispatch(state, {
    effects: setNoteDates.of(seedNoteDates(body, { isNew: true, day: "2026-09-08" })),
    annotations: Transaction.addToHistory.of(false)
  });

  for (let index = 0; index < 40; index += 1) {
    state = dispatch(state, {
      changes: { from: state.doc.length, insert: String(index % 10) },
      annotations: Transaction.userEvent.of("input.type")
    });
  }

  assert.equal(undoDepth(state), 1);
  const storedHistory = state.field(historyField) as unknown as {
    done: Array<{ effects: Array<{ value?: { lines?: unknown[] } }> }>;
  };
  const effects = storedHistory.done.at(-1)?.effects ?? [];
  const retainedDateLines = effects.reduce((count, effect) => count + (effect.value?.lines?.length ?? 0), 0);
  assert.equal(effects.length, 40);
  assert.equal(retainedDateLines, 40);
  assert(retainedDateLines < state.doc.lines);

  state = runCommand(state, undo);
  assert.equal(state.doc.toString(), body);
  assert.ok(getEditorNoteDates(state)?.lines.every((line) => line.day === "2026-09-08"));
});
