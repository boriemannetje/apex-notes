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
  localDay,
  reconcileNoteDates,
  type DateStamp,
  type NoteDates
} from "../notes/noteDates.ts";

export const setNoteDates = StateEffect.define<NoteDates | null>();

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
    for (const effect of transaction.effects) {
      if (!effect.is(setNoteDates)) continue;
      noteDates = effect.value;
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
  const reconciled = reconcileNoteDates(transaction.state.doc.toString(), previous, stamp);
  const oldDocument = transaction.startState.doc;
  const newDocument = transaction.state.doc;

  for (let lineNumber = 1; lineNumber <= oldDocument.lines; lineNumber += 1) {
    const previousLine = previous.lines[lineNumber - 1];
    if (!previousLine) continue;

    const oldLine = oldDocument.line(lineNumber);
    const mappedFrom = transaction.changes.mapPos(oldLine.from, 1);
    const mappedTo = transaction.changes.mapPos(oldLine.to, -1);
    if (mappedFrom > mappedTo) continue;

    const newLine = newDocument.lineAt(mappedFrom);
    if (
      newLine.from !== mappedFrom ||
      newLine.to !== mappedTo ||
      newLine.text !== oldLine.text
    ) {
      continue;
    }

    const reconciledLine = reconciled.lines[newLine.number - 1];
    if (!reconciledLine) continue;
    reconciled.lines[newLine.number - 1] = {
      ...reconciledLine,
      day: previousLine.day,
      estimated: previousLine.estimated
    };
  }

  return reconciled;
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
    element.setAttribute("aria-hidden", "true");
    element.textContent = label;
    element.title = this.stamp.estimated ? `${label} (estimated)` : label;
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
  for (const group of dateGroups(state.doc.toString(), noteDates)) {
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
  return [setNoteDates.of(transaction.startState.field(noteDatesField))];
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
