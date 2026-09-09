import test from "node:test";
import assert from "node:assert/strict";
import {
  dateGroups,
  dayFromTimestamp,
  emptyDateDocument,
  formatDateStamp,
  lineAnchor,
  localDay,
  normalizeDateDocument,
  reconcileNoteDates,
  seedNoteDates,
  type DateStamp,
  type NoteDates
} from "./noteDates.ts";

const exact = (day: string | null): DateStamp => ({ day, estimated: false });
const estimated = (day: string | null): DateStamp => ({ day, estimated: true });

test("calendar helpers use local days, reject invalid timestamps, and format deterministically", () => {
  assert.equal(localDay(new Date(2026, 8, 9, 23, 59)), "2026-09-09");
  assert.equal(localDay(new Date(Number.NaN)), null);
  assert.equal(dayFromTimestamp(new Date(2025, 1, 3, 12).getTime()), "2025-02-03");
  assert.equal(dayFromTimestamp(Number.NaN), null);
  assert.equal(formatDateStamp(exact("2026-09-09")), "9 Sep 2026");
  assert.equal(formatDateStamp(estimated("2026-09-09")), "≈ 9 Sep 2026");
  assert.equal(formatDateStamp(exact(null)), "Date unavailable");
  assert.equal(formatDateStamp(exact("2026-02-29")), "Date unavailable");
});

test("line anchors are deterministic 32-character content anchors", () => {
  assert.match(lineAnchor("same line"), /^[0-9a-f]{32}$/);
  assert.equal(lineAnchor("same line"), lineAnchor("same line"));
  assert.notEqual(lineAnchor("same line"), lineAnchor("different line"));
});

test("new notes use the supplied edit day and do not inherit pasted manual markers", () => {
  const body = "# Old text\n*Written: 2021-04-03*\nStill pasted\n";
  const dates = seedNoteDates(body, {
    isNew: true,
    day: "2026-09-09",
    createdMs: new Date(2020, 0, 1).getTime(),
    modifiedMs: new Date(2021, 0, 1).getTime()
  });

  assert.deepEqual(dates.created, exact("2026-09-09"));
  assert.equal(dates.lines.length, 4);
  assert.ok(dates.lines.every(({ day, estimated }) => day === "2026-09-09" && !estimated));
});

test("existing notes seed immutable creation and section blocks from valid Written and Added markers", () => {
  const body = [
    "# Note",
    "*Written: 2024-01-02*",
    "First paragraph",
    "",
    "## Later",
    "*Added: 2024-03-04*",
    "Later paragraph",
    ""
  ].join("\n");
  const dates = seedNoteDates(body, {
    createdMs: new Date(2023, 0, 1).getTime(),
    modifiedMs: new Date(2025, 5, 6).getTime()
  });

  assert.deepEqual(dates.created, exact("2024-01-02"));
  assert.deepEqual(dates.lines.map(({ day, estimated }) => ({ day, estimated })), [
    exact("2024-01-02"), exact("2024-01-02"), exact("2024-01-02"), exact("2024-01-02"),
    exact("2024-03-04"), exact("2024-03-04"), exact("2024-03-04"), exact("2024-03-04")
  ]);
  assert.equal(body.includes("*Written: 2024-01-02*"), true);
});

test("existing notes fall back to estimated filesystem dates without fabricating missing days", () => {
  const createdMs = new Date(2022, 6, 8, 8).getTime();
  const modifiedMs = new Date(2023, 7, 9, 8).getTime();
  const dated = seedNoteDates("Alpha\nBeta", { createdMs, modifiedMs });
  assert.deepEqual(dated.created, estimated("2022-07-08"));
  assert.ok(dated.lines.every(({ day, estimated }) => day === "2023-08-09" && estimated));

  const missing = seedNoteDates("Alpha", {});
  assert.deepEqual(missing.created, estimated(null));
  assert.deepEqual({ day: missing.lines[0].day, estimated: missing.lines[0].estimated }, estimated(null));

  const modifiedOnly = seedNoteDates("Alpha", { modifiedMs });
  assert.deepEqual(modifiedOnly.created, estimated("2023-08-09"));
});

test("invalid manual calendar dates never seed provenance", () => {
  const dates = seedNoteDates("# Note\n*Written: 2025-02-29*\nText", {});
  assert.deepEqual(dates.created, estimated(null));
  assert.ok(dates.lines.every(({ day }) => day === null));
});

test("reconciliation preserves immutable creation and unchanged lines around edits", () => {
  const previous = seedNoteDates("Alpha\nBeta\nGamma", { isNew: true, day: "2026-09-08" });
  const next = reconcileNoteDates("Inserted\nAlpha\nBeta edited\nGamma", previous, exact("2026-09-09"));

  assert.deepEqual(next.created, exact("2026-09-08"));
  assert.deepEqual(next.lines.map(({ day }) => day), [
    "2026-09-09", "2026-09-08", "2026-09-09", "2026-09-08"
  ]);
  assert.equal(next.lines[1].anchor, previous.lines[0].anchor);
  assert.equal(next.lines[3].anchor, previous.lines[2].anchor);
});

test("reconciliation safely retains position-aligned duplicate prefix and suffix lines", () => {
  const previous = seedNoteDates("Start\nRepeat\nOld\nRepeat\nEnd", { isNew: true, day: "2026-09-08" });
  const next = reconcileNoteDates("Start\nRepeat\nNew\nRepeat\nEnd", previous, exact("2026-09-09"));

  assert.deepEqual(next.lines.map(({ day }) => day), [
    "2026-09-08", "2026-09-08", "2026-09-09", "2026-09-08", "2026-09-08"
  ]);
});

test("reconciliation never assigns ambiguous interior duplicates an old date", () => {
  const previous = seedNoteDates("Start\nA\nRepeat\nMiddle\nRepeat\nB\nEnd", { isNew: true, day: "2026-09-08" });
  const next = reconcileNoteDates("Start\nA\nRepeat\nRepeat\nMiddle\nB\nEnd", previous, exact("2026-09-09"));

  assert.deepEqual(next.lines.map(({ day }) => day), [
    "2026-09-08", "2026-09-08", "2026-09-08", "2026-09-09",
    "2026-09-08", "2026-09-08", "2026-09-08"
  ]);
});

test("external reconciliation uses the provided estimated stamp", () => {
  const previous = seedNoteDates("Alpha\nBeta", { isNew: true, day: "2026-09-08" });
  const next = reconcileNoteDates("Alpha changed\nBeta", previous, estimated("2026-09-09"));
  assert.deepEqual({ day: next.lines[0].day, estimated: next.lines[0].estimated }, estimated("2026-09-09"));
  assert.deepEqual({ day: next.lines[1].day, estimated: next.lines[1].estimated }, exact("2026-09-08"));
});

test("date groups bridge blanks and label only the last nonblank logical line", () => {
  const body = "One\n\nTwo\nThree\n\nFour\n";
  const seeded = seedNoteDates(body, { isNew: true, day: "2026-09-08" });
  const dates: NoteDates = {
    created: seeded.created,
    lines: seeded.lines.map((line, index) => ({
      ...line,
      day: index < 3 ? "2026-09-08" : "2026-09-09"
    }))
  };

  assert.deepEqual(dateGroups(body, dates), [
    { lineNumber: 3, stamp: exact("2026-09-08") },
    { lineNumber: 6, stamp: exact("2026-09-09") }
  ]);
  assert.deepEqual(dateGroups("\n\n", dates), []);
});

test("date groups expose unavailable provenance when line metadata is absent", () => {
  assert.deepEqual(dateGroups("One", null), [
    { lineNumber: 1, stamp: estimated(null) }
  ]);
});

test("date groups merge exact and estimated lines from the same day and mark the group estimated", () => {
  const body = "One\nTwo";
  const seeded = seedNoteDates(body, { isNew: true, day: "2026-09-09" });
  seeded.lines[1].estimated = true;
  assert.deepEqual(dateGroups(body, seeded), [
    { lineNumber: 2, stamp: estimated("2026-09-09") }
  ]);
});

test("date document normalization strictly validates and clones persistent metadata", () => {
  const anchor = lineAnchor("Alpha");
  assert.deepEqual(emptyDateDocument(), { version: 1, notes: {} });
  assert.deepEqual(normalizeDateDocument({
    version: 1,
    notes: {
      "folder/good.MD": {
        created: { day: "2024-02-29", estimated: false },
        lines: [{ anchor, day: "2025-02-28", estimated: true }]
      }
    }
  }), {
    version: 1,
    notes: {
      "folder/good.MD": {
        created: exact("2024-02-29"),
        lines: [{ anchor, day: "2025-02-28", estimated: true }]
      }
    }
  });
});

test("date document normalization throws on newer, malformed, unknown, and traversal data", () => {
  const anchor = lineAnchor("Alpha");
  assert.throws(() => normalizeDateDocument({ version: 2, notes: {} }), /Unsupported/);
  assert.throws(() => normalizeDateDocument({ version: 1, notes: {}, extra: true }), /unknown fields/);
  assert.throws(() => normalizeDateDocument({
    version: 1,
    notes: {
      "../bad.md": { created: exact("2026-09-09"), lines: [] }
    }
  }), /Invalid.*path/);
  assert.throws(() => normalizeDateDocument({
    version: 1,
    notes: {
      "bad.md": { created: exact("2026-02-29"), lines: [] }
    }
  }), /invalid day/);
  assert.throws(() => normalizeDateDocument({
    version: 1,
    notes: {
      "bad.md": {
        created: exact("2026-09-09"),
        lines: [{ anchor, day: "2026-09-09", estimated: false, extra: true }]
      }
    }
  }), /unknown fields/);
});

test("date line caps fail clearly before provenance arrays are allocated", () => {
  const oversizedBody = `${"\n".repeat(100_000)}`;
  assert.throws(
    () => seedNoteDates(oversizedBody, { isNew: true, day: "2026-09-09" }),
    /exceeds 100000 date lines/
  );
  assert.throws(() => normalizeDateDocument({
    version: 1,
    notes: {
      "too-large.md": {
        created: exact("2026-09-09"),
        lines: new Array(100_001).fill({ anchor: lineAnchor(""), ...exact("2026-09-09") })
      }
    }
  }), /exceeds 100000 lines/);
});
