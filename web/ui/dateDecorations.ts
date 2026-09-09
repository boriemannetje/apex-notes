import { invertedEffects } from "@codemirror/commands";
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import {
  dateGroups,
  formatDateStamp,
  lineAnchor,
  localDay,
  reconcileNoteDates,
  type DateStamp,
  type NoteDates
} from "../notes/noteDates.ts";

export const setNoteDates = StateEffect.define<NoteDates | null>();

type DateHistoryLine = {
  from: number;
  line: NoteDates["lines"][number];
};

type DateHistoryDelta = {
  created: DateStamp;
  lines: DateHistoryLine[];
};

const restoreNoteDateDelta = StateEffect.define<DateHistoryDelta>({
  map(delta, changes) {
    return {
      created: delta.created,
      lines: delta.lines.map((entry) => ({
        from: changes.mapPos(entry.from, 1),
        line: entry.line
      }))
    };
  }
});

const MAX_TRACKED_LINES = 100_000;

type DateTrackingConfig = {
  getDay: () => string | null;
};

const dateTrackingConfig = Facet.define<DateTrackingConfig, DateTrackingConfig>({
  combine(configs) {
    return configs.at(-1) ?? { getDay: () => localDay() };
  }
});

const noteDatesField = StateField.define<NoteDates | null>({
  create() {
    return null;
  },
  update(noteDates, transaction) {
    let hydrated = false;
    const historyDeltas: DateHistoryDelta[] = [];
    for (const effect of transaction.effects) {
      if (effect.is(setNoteDates)) {
        noteDates = effect.value;
        hydrated = true;
      } else if (effect.is(restoreNoteDateDelta)) {
        historyDeltas.push(effect.value);
      }
    }
    if (historyDeltas.length) {
      noteDates = restoreDateDeltas(transaction, noteDates, historyDeltas);
      hydrated = true;
    }

    if (hydrated || !transaction.docChanged || noteDates === null) {
      return noteDates;
    }

    const { getDay } = transaction.state.facet(dateTrackingConfig);
    if (transaction.state.doc.lines > MAX_TRACKED_LINES) return noteDates;
    try {
      return reconcileEditorNoteDates(transaction, noteDates, {
        day: getDay(),
        estimated: false
      });
    } catch {
      // Date metadata is supplemental. Keep the last bounded state so an
      // oversized or otherwise unreconcilable edit never blocks Markdown.
      return noteDates;
    }
  }
});

function reconcileEditorNoteDates(
  transaction: Transaction,
  previous: NoteDates,
  stamp: DateStamp
): NoteDates {
  const oldDocument = transaction.startState.doc;
  const newDocument = transaction.state.doc;
  if (oldDocument.lines > MAX_TRACKED_LINES || previous.lines.length !== oldDocument.lines) {
    return reconcileNoteDates(newDocument.toString(), previous, stamp);
  }
  const lines: Array<NoteDates["lines"][number] | undefined> = new Array(newDocument.lines);
  transaction.changes.iterGaps((oldFrom, newFrom, length) => {
    const oldSpan = completeLineSpan(oldDocument, oldFrom, oldFrom + length);
    const newSpan = completeLineSpan(newDocument, newFrom, newFrom + length);
    if (!oldSpan || !newSpan) return;
    const startOffset = Math.max(oldSpan.firstFrom - oldFrom, newSpan.firstFrom - newFrom);
    const endOffset = Math.min(oldSpan.lastTo - oldFrom, newSpan.lastTo - newFrom);
    if (startOffset > endOffset) return;
    const oldFirst = oldDocument.lineAt(oldFrom + startOffset);
    const newFirst = newDocument.lineAt(newFrom + startOffset);
    const oldLast = oldDocument.lineAt(oldFrom + endOffset);
    const newLast = newDocument.lineAt(newFrom + endOffset);
    if (
      oldFirst.from !== oldFrom + startOffset ||
      newFirst.from !== newFrom + startOffset ||
      oldLast.to !== oldFrom + endOffset ||
      newLast.to !== newFrom + endOffset
    ) {
      return;
    }
    const count = oldLast.number - oldFirst.number + 1;
    if (count !== newLast.number - newFirst.number + 1) return;
    for (let offset = 0; offset < count; offset += 1) {
      lines[newFirst.number - 1 + offset] = previous.lines[oldFirst.number - 1 + offset];
    }
  });
  for (let lineNumber = 1; lineNumber <= newDocument.lines; lineNumber += 1) {
    if (lines[lineNumber - 1]) continue;
    const text = newDocument.line(lineNumber).text;
    lines[lineNumber - 1] = {
      anchor: lineAnchor(text.endsWith("\r") ? text.slice(0, -1) : text),
      day: stamp.day,
      estimated: stamp.estimated
    };
  }
  return {
    created: previous.created,
    lines: lines as NoteDates["lines"]
  };
}

function completeLineSpan(
  document: EditorState["doc"],
  from: number,
  to: number
): { firstFrom: number; lastTo: number } | null {
  let first = document.lineAt(from).number;
  if (document.line(first).from < from) first += 1;
  let last = document.lineAt(to).number;
  if (document.line(last).to > to) last -= 1;
  return first <= last
    ? { firstFrom: document.line(first).from, lastTo: document.line(last).to }
    : null;
}

class DateStampWidget extends WidgetType {
  readonly stamp: DateStamp;

  constructor(stamp: DateStamp) {
    super();
    this.stamp = stamp;
  }

  eq(other: DateStampWidget) {
    return other.stamp.day === this.stamp.day && other.stamp.estimated === this.stamp.estimated;
  }

  toDOM(view: EditorView) {
    const element = view.dom.ownerDocument.createElement("span");
    const label = formatDateStamp(this.stamp);
    element.className = `cm-date-stamp${this.stamp.estimated ? " is-estimated" : ""}`;
    element.contentEditable = "false";
    element.spellcheck = false;
    element.dataset.dateDay = this.stamp.day ?? "";
    element.dataset.estimated = String(this.stamp.estimated);
    element.setAttribute("role", "note");
    element.setAttribute(
      "aria-label",
      this.stamp.estimated
        ? `Line date ${label}. Estimated from file timestamps or external edits; exact line history is unavailable.`
        : `Line date ${label}.`
    );
    element.textContent = label;
    element.title = this.stamp.estimated
      ? `${label} — estimated from file timestamps or external edits; exact line history is unavailable.`
      : label;
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

function buildDateDecorations(state: EditorState): DecorationSet {
  const noteDates = state.field(noteDatesField);
  if (noteDates === null || state.doc.lines > MAX_TRACKED_LINES) return Decoration.none;

  const ranges = [];
  for (const group of dateGroups(state.doc.toString(), noteDates, { trusted: true })) {
    if (group.lineNumber < 1 || group.lineNumber > state.doc.lines) continue;
    const line = state.doc.line(group.lineNumber);
    ranges.push(
      Decoration.widget({
        widget: new DateStampWidget(group.stamp),
        side: 1
      }).range(line.to)
    );
  }
  return Decoration.set(ranges, true);
}

function invertDateState(transaction: Transaction) {
  if (!transaction.docChanged) return [];
  const noteDates = transaction.startState.field(noteDatesField);
  if (noteDates === null) return [];
  const lineNumbers = new Set<number>();
  transaction.changes.iterChangedRanges((from, to) => {
    const first = transaction.startState.doc.lineAt(from).number;
    const last = Math.min(transaction.startState.doc.lineAt(to).number, noteDates.lines.length);
    for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
      lineNumbers.add(lineNumber);
    }
  });
  const lines: DateHistoryLine[] = [];
  for (const lineNumber of lineNumbers) {
    const line = noteDates.lines[lineNumber - 1];
    if (!line) continue;
    lines.push({ from: transaction.startState.doc.line(lineNumber).from, line });
  }
  return [restoreNoteDateDelta.of({ created: noteDates.created, lines })];
}

function restoreDateDeltas(
  transaction: Transaction,
  current: NoteDates | null,
  deltas: readonly DateHistoryDelta[]
): NoteDates | null {
  if (current === null) return null;
  let restored: NoteDates;
  try {
    restored = reconcileEditorNoteDates(transaction, current, { day: null, estimated: true });
  } catch {
    return current;
  }
  for (const delta of deltas) {
    for (const entry of delta.lines) {
      if (entry.from < 0 || entry.from > transaction.state.doc.length) continue;
      const documentLine = transaction.state.doc.lineAt(entry.from);
      const restoredLine = restored.lines[documentLine.number - 1];
      if (
        documentLine.from !== entry.from ||
        !restoredLine ||
        restoredLine.anchor !== entry.line.anchor
      ) {
        continue;
      }
      restored.lines[documentLine.number - 1] = entry.line;
    }
    restored.created = delta.created;
  }
  return restored;
}

export function createDateTrackingExtension(options: { getDay?: () => string } = {}): Extension {
  return [
    dateTrackingConfig.of({ getDay: options.getDay ?? (() => localDay()) }),
    noteDatesField,
    invertedEffects.of(invertDateState),
    EditorView.decorations.compute(["doc", noteDatesField], buildDateDecorations)
  ];
}

export function getEditorNoteDates(state: EditorState): NoteDates | null {
  return state.field(noteDatesField, false) ?? null;
}
