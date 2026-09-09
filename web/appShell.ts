// @ts-nocheck
import { defaultKeymap, history, historyKeymap, indentWithTab, redo as redoEditorHistory } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, dropCursor, highlightActiveLine, keymap, placeholder } from "@codemirror/view";
import {
  detectLargeGraphMode,
  selectLargeModeReferenceEdges
} from "./graphLargeMode.ts";
import { LARGE_GRAPH_CONFIG } from "./graphConfig.ts";
import { createGraphIndex } from "./graphModel.ts";
import { buildGraphLayout } from "./graphLayout.ts";
import { getGraphWheelZoomFactor } from "./graphWheelZoom.ts";
import {
  computeNoteLinkStats,
  decideVisibleLabels,
  getLabelVisibilityPolicy,
  prepareLabelVisibilityCache
} from "./labelVisibility.ts";
import { connectionCountToNodeScale } from "./nodeSizing.ts";
import { createSearchIndex } from "./searchIndex.ts";
import { buildSearchResults } from "./searchResults.ts";
import {
  cleanWikiRef,
  normalizeKey,
  parseWikiTarget,
  slugify
} from "./noteRefs.ts";
import {
  createAbsolutePositionPatch,
  findChildPosition,
  findLooseGridPositions,
  resolveStoredPosition as resolveStoredGraphPosition
} from "./graphPositioning.ts";
import { getClampedPopoverPosition } from "./popoverPositioning.ts";
import {
  loadRecentProjects,
  normalizeRecentProjects,
  projectDisplayPath,
  projectLocationFromPath,
  projectNameFromPath,
  projectParentFromPath,
  rememberRecentProject,
  removeRecentProject,
  saveRecentProjects
} from "./recentProjects.ts";
import { createIcon, setButtonIcon } from "./icons.ts";
import { checkForAppUpdate, getCurrentBuildInfo } from "./persistence/appUpdates.ts";
import {
  buildFileSignatureMap,
  cloneFileSignatures,
  diffFileSignatures,
  liveUpdateStatus
} from "./persistence/liveSync.ts";
import { invokeNative as nativeInvoke, isTauriApp, pickNativeDirectory } from "./persistence/nativeWorkspaceAdapter.ts";
import { dayFromTimestamp, emptyDateDocument, formatDateStamp, localDay, normalizeDateDocument, reconcileNoteDates, seedNoteDates } from "./notes/noteDates.ts";
import { createDateTrackingExtension, getEditorNoteDates, setNoteDates } from "./ui/dateDecorations.ts";
import {
  bodyFromText,
  composeRaw,
  createNoteRaw,
  getAvailableDisplayTitle,
  getAvailableNewNotePath as getAvailableNewNotePathForTitle,
  titleFromText
} from "./notes/noteComposer.ts";
import { parseNote } from "./notes/noteParser.ts";
import { validateNotes as validateNoteCollection } from "./notes/noteValidation.ts";
import { trimWorkspaceHistoryStack, trimWorkspaceHistoryStacks } from "./state/historyBudget.ts";
import { createWorkspaceStore } from "./state/workspaceStore.ts";
import { getDomElements } from "./ui/domElements.ts";
import {
  MAX_ANNOTATION_ITEMS,
  MAX_ANNOTATION_NAME_LENGTH,
  MAX_ANNOTATION_TEXT_LENGTH,
  annotationBounds,
  annotationLabelPoint,
  cloneAnnotationDocument,
  createAnnotationId,
  documentBounds,
  emptyAnnotationDocument,
  hitTestAnnotation,
  normalizeAnnotationDocument,
  resizeAnnotation,
  simplifyStroke,
  translateAnnotation
} from "./annotations.ts";
import apexNotesWritingSkill from "../skills/apex-notes-writing/SKILL.md";

const LEVEL_COLORS = ["#f1eee6", "#9fc5ff", "#a9d6ac", "#e8d188", "#ffb6d1", "#f2b380", "#7fd6df", "#c7b89a"];
const STORAGE_PREFIX = "hamkg-layout-v2";
const EDITOR_PANE_WIDTH_STORAGE_KEY = "apex-notes-editor-pane-width";
const MIN_EDITOR_PANE_WIDTH = 260;
const ABSOLUTE_MIN_EDITOR_PANE_WIDTH = 220;
const MIN_GRAPH_PANE_WIDTH = 320;
const ABSOLUTE_MIN_GRAPH_PANE_WIDTH = 220;
const EDITOR_PANE_WIDTH_STEP = 24;
const EDITOR_PANE_WIDTH_LARGE_STEP = 96;
const HIERARCHY_AGENT_INSTRUCTIONS = `Custom hierarchy guidance:
- check for pre-existing hierarchy, sometimes only a few files don't have the correct formatting
- Build sensible hierarchy edges from the notes in this folder following the note writing skill.
- Parentless notes are allowed as loose notes or roots of independent hierarchies.
- When a note is connected to a parent, its depth is derived from the parent chain.
- Moving down a connected hierarchy should become progressively less abstract and more concrete: principles -> themes -> projects/areas -> concrete notes, examples, tasks, or observations.
- Use body wiki links only for contextual references between related notes, not as hierarchy.

Full Apex Notes writing skill, copied from skills/apex-notes-writing/SKILL.md:

${apexNotesWritingSkill.trim()}`;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 2.2;
const SEARCH_FLY_TO_MIN_ZOOM = 1.65;
const SEARCH_FLY_TO_ZOOM_FACTOR = 1.55;
const GRAPH_FLY_TO_DURATION_MS = 460;
const DOT_RADIUS = 7;
const HIT_RADIUS = 22;
const NODE_LABEL_FONT_SIZE = 12.5;
const NODE_LABEL_LINE_HEIGHT = 15;
const NODE_LABEL_Y = 30;
const NODE_BOUND_X = 92;
const NODE_BOUND_TOP = 42;
const NODE_BOUND_BOTTOM = 62;
const LEVEL_GAP = 138;
const NODE_GAP = 168;
const GRAPH_PAD = 96;
const FIT_VIEW_PADDING = 24;
const SPATIAL_CELL_SIZE = 240;
const LIVE_SYNC_INTERVAL_MS = 1500;
const APP_UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const MAX_WORKSPACE_HISTORY_ENTRIES = 80;
const MAX_WORKSPACE_HISTORY_BYTES = 12 * 1024 * 1024;
const LARGE_FOLDER_NOTE_WARNING_THRESHOLD = 1000;
const LARGE_FOLDER_TOTAL_BYTES_WARNING_THRESHOLD = 50 * 1024 * 1024;
const LARGE_NOTE_BYTE_WARNING_THRESHOLD = 2 * 1024 * 1024;
const annotationWriteTailsByWorkspace = new Map();
const pendingAnnotationWritesByWorkspace = new Map();
const pendingAnnotationChangesByWorkspace = new Map();
const annotationSaveTokensByWorkspace = new Map();
const annotationTransitionLocksByWorkspace = new Map();
const persistedAnnotationDocumentsByWorkspace = new Map();
const deferredAnnotationHistoryByWorkspace = new Map();
const dateWriteTailsByWorkspace = new Map();
const editorDateHistory = new Compartment();
let editorNoteKey = "";
let editorHydrationEpoch = 0;
const SEARCH_BODY_NOTE_THRESHOLD = 1000;
const SEARCH_BODY_TOTAL_BYTES_THRESHOLD = 25 * 1024 * 1024;
const SEARCH_TRIGRAM_TOTAL_CHARS_THRESHOLD = 3_000_000;
const BROWSE_PROJECT_LOCATION_VALUE = "__browse_project_location__";
const POSITIONING_OPTIONS = {
  levelGap: LEVEL_GAP,
  nodeGap: NODE_GAP,
  collisionGap: NODE_GAP,
  looseGapX: NODE_GAP,
  looseGapY: LEVEL_GAP,
  looseMarginX: NODE_GAP * 2,
  looseColumns: 3,
  precision: 2
};
const PERF_ENABLED = isPerfEnabled();
const workspaceMetricEncoder = new TextEncoder();
const EMPTY_NOTE_PLACEHOLDER = "Write down your thoughts...";

const editorEditable = new Compartment();
const editorPlaceholder = new Compartment();
const wikiLinkRefreshEffect = StateEffect.define();

const state = createWorkspaceStore(loadRecentProjects());

let suppressWorkspaceRenameCommit = false;
let appEventController = null;
let graphPinch = null;
let resizeDebounceTimer = 0;
let largeGraphRefreshTimer = 0;

const els = getDomElements();

const wikiLinkField = StateField.define({
  create(editorState) {
    return buildWikiLinkDecorations(editorState.doc);
  },
  update(decorations, transaction) {
    if (transaction.effects.some((effect) => effect.is(wikiLinkRefreshEffect))) {
      return buildWikiLinkDecorations(transaction.state.doc);
    }
    if (transaction.docChanged) {
      scheduleWikiLinkRefresh();
      return decorations.map(transaction.changes);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

let wikiLinkRefreshTimer = 0;
function scheduleWikiLinkRefresh() {
  if (wikiLinkRefreshTimer) {
    window.clearTimeout(wikiLinkRefreshTimer);
  }
  wikiLinkRefreshTimer = window.setTimeout(() => {
    wikiLinkRefreshTimer = 0;
    refreshEditorDecorations();
  }, 140);
}

function clearWikiLinkRefreshTimer() {
  if (!wikiLinkRefreshTimer) return;
  window.clearTimeout(wikiLinkRefreshTimer);
  wikiLinkRefreshTimer = 0;
}

function isPerfEnabled() {
  if (window.location.search.includes("perf=1")) return true;
  try {
    return window.localStorage.getItem("apex-notes-perf") === "1";
  } catch {
    return false;
  }
}

let deleteConfirmResolver = null;

class WikiLinkWidget extends WidgetType {
  constructor(ref, label, note) {
    super();
    this.ref = ref;
    this.label = label;
    this.notePath = note ? note.path : "";
    this.noteLevel = note ? note.level : null;
  }

  eq(other) {
    return (
      other.ref === this.ref &&
      other.label === this.label &&
      other.notePath === this.notePath &&
      other.noteLevel === this.noteLevel
    );
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = `cm-wikiLink${this.notePath ? "" : " is-missing"}`;
    span.textContent = this.label;
    span.title = this.notePath ? `Open ${this.label}` : `Missing note: ${this.ref}`;
    if (this.noteLevel !== null) {
      span.style.setProperty("--wiki-link-color", getLevelColor(this.noteLevel));
    }
    span.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.notePath) {
        selectNote(this.notePath);
      } else {
        setStatus(`No note found for [[${this.ref}]]`);
      }
    });
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export function initializeApp() {
  if (appEventController || state.editorView || state.graphResizeObserver) {
    disposeApp();
  }
  initializeEditor();
  initializeIcons();
  initializeEditorPaneWidth();
  bindEvents();
  initializeGraphResizeObserver();
  startEmpty();
  void hydrateRecentProjects();
  startAppUpdateChecks();
}

export function disposeApp() {
  graphPinch = null;
  stopLiveSync();
  cancelQueuedGraphRender();
  cancelGraphViewAnimation();
  cancelLabelVisibilityRefresh();
  clearResizeDebounceTimer();
  clearLargeGraphRefreshTimer();
  cancelInteraction();
  cancelEditorResizeDrag();
  clearWikiLinkRefreshTimer();

  if (state.appUpdateCheckTimer) {
    window.clearInterval(state.appUpdateCheckTimer);
    state.appUpdateCheckTimer = 0;
  }
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  if (appEventController) {
    appEventController.abort();
    appEventController = null;
  }
  if (state.graphResizeObserver) {
    state.graphResizeObserver.disconnect();
    state.graphResizeObserver = null;
  }
  if (state.editorView) {
    state.editorView.destroy();
    state.editorView = null;
  }
}

function initializeIcons() {
  setButtonIcon(els.graphHelpButton, "help");
  setButtonIcon(els.newNoteButton, "newNote", "New note");
  setButtonIcon(els.launchOpenProjectButton, "openProject", "Open project");
  setButtonIcon(els.launchCreateProjectButton, "createProject", "Create project");
  setButtonIcon(els.graphOpenProjectButton, "openProject", "Open project");
  setButtonIcon(els.graphCreateProjectButton, "createProject", "Create project");
  setButtonIcon(els.closeGraphProjectLauncherButton, "close");
  setButtonIcon(els.updateButton, "download", "Update");
  els.searchFieldIcon.replaceChildren(createIcon("search"));
  setButtonIcon(els.zoomOutButton, "zoomOut");
  setButtonIcon(els.resetViewButton, "fit");
  setButtonIcon(els.zoomInButton, "zoomIn");
  setButtonIcon(els.fullscreenGraphButton, "fullscreenEnter");
  setButtonIcon(els.fullscreenEditorButton, "fullscreenEnter");
  setButtonIcon(els.deleteNoteButton, "trash");
}

function initializeEditor() {
  state.editorView = new EditorView({
    parent: els.editor,
    state: EditorState.create({
      doc: "",
      extensions: [
        editorDateHistory.of(history()),
        createDateTrackingExtension(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        wikiLinkField,
        editorEditable.of(EditorView.editable.of(false)),
        editorPlaceholder.of([]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || state.editorHydrating) return;
          markSelectedDirty();
        }),
        keymap.of([
          { key: "Mod-y", run: redoEditorHistory },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap
        ]),
        EditorView.theme(
          {
            "&": {
              height: "100%",
              background: "var(--bg)",
              color: "var(--fg)"
            },
            ".cm-scroller": {
              fontFamily: "inherit",
              lineHeight: "1.5",
              overflow: "auto"
            },
            ".cm-content": {
              minHeight: "100%",
              padding: "14px",
              caretColor: "var(--fg)",
              whiteSpace: "pre-wrap"
            },
            ".cm-line": {
              padding: "0"
            },
            ".cm-cursor": {
              borderLeftColor: "var(--fg)"
            },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "rgba(242, 240, 234, 0.2)"
            },
            "&.cm-focused": {
              outline: "none"
            }
          },
          { dark: true }
        )
      ]
    })
  });
}

function initializeEditorPaneWidth() {
  const storedWidth = readStoredEditorPaneWidth();
  if (storedWidth !== null) {
    applyEditorPaneWidth(storedWidth, { persist: false });
  } else {
    updateEditorResizeHandleAttributes(getCurrentEditorPaneWidth());
  }
}

function initializeGraphResizeObserver() {
  if (!els.graphScroller || typeof ResizeObserver !== "function") return;
  if (state.graphResizeObserver) {
    state.graphResizeObserver.disconnect();
  }
  state.graphResizeObserver = new ResizeObserver(() => {
    scheduleResizeRender();
  });
  state.graphResizeObserver.observe(els.graphScroller);
}

function readStoredEditorPaneWidth() {
  try {
    const raw = window.localStorage.getItem(EDITOR_PANE_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const width = Number.parseFloat(raw);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

function writeStoredEditorPaneWidth(width) {
  try {
    window.localStorage.setItem(EDITOR_PANE_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Ignore storage failures; resizing still works for the current session.
  }
}

function getLayoutWidth() {
  return els.layout?.getBoundingClientRect().width || window.innerWidth || 0;
}

function getEditorResizeHandleWidth() {
  return els.editorResizeHandle?.getBoundingClientRect().width || 8;
}

function getEditorPaneMinWidth(layoutWidth = getLayoutWidth()) {
  if (!layoutWidth) return MIN_EDITOR_PANE_WIDTH;
  const responsiveMin = Math.floor(layoutWidth * 0.34);
  return Math.max(
    ABSOLUTE_MIN_EDITOR_PANE_WIDTH,
    Math.min(MIN_EDITOR_PANE_WIDTH, responsiveMin)
  );
}

function getGraphPaneMinWidth(layoutWidth = getLayoutWidth()) {
  if (!layoutWidth) return MIN_GRAPH_PANE_WIDTH;
  const responsiveMin = Math.floor(layoutWidth * 0.42);
  return Math.max(
    ABSOLUTE_MIN_GRAPH_PANE_WIDTH,
    Math.min(MIN_GRAPH_PANE_WIDTH, responsiveMin)
  );
}

function getEditorPaneWidthBounds() {
  const layoutWidth = getLayoutWidth();
  const handleWidth = getEditorResizeHandleWidth();
  const minWidth = getEditorPaneMinWidth(layoutWidth);
  const graphMinWidth = getGraphPaneMinWidth(layoutWidth);
  const maxWidth = Math.floor(layoutWidth - handleWidth - graphMinWidth);

  return {
    min: minWidth,
    max: Math.max(minWidth, maxWidth)
  };
}

function getEditorPaneMaxWidth() {
  return getEditorPaneWidthBounds().max;
}

function getEditorPaneKeyboardMinWidth() {
  return getEditorPaneWidthBounds().min;
}

function clampEditorPaneWidth(width) {
  const bounds = getEditorPaneWidthBounds();
  if (!Number.isFinite(width)) return bounds.min;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

function getDefaultEditorPaneWidth() {
  return clampEditorPaneWidth(getLayoutWidth() * 0.34);
}

function getCurrentEditorPaneWidth() {
  const currentWidth = els.editorPane?.getBoundingClientRect().width || 0;
  if (currentWidth > 0) return currentWidth;
  if (state.editorPaneWidth !== null) return state.editorPaneWidth;
  return getDefaultEditorPaneWidth();
}

function updateEditorResizeHandleAttributes(width) {
  const bounds = getEditorPaneWidthBounds();
  const nextWidth = clampEditorPaneWidth(width);
  els.editorResizeHandle.setAttribute("aria-valuemin", String(bounds.min));
  els.editorResizeHandle.setAttribute("aria-valuemax", String(bounds.max));
  els.editorResizeHandle.setAttribute("aria-valuenow", String(nextWidth));
}

function applyEditorPaneWidth(width, { persist = true } = {}) {
  const nextWidth = clampEditorPaneWidth(width);
  state.editorPaneWidth = nextWidth;
  els.layout.style.setProperty("--editor-pane-width", `${nextWidth}px`);
  updateEditorResizeHandleAttributes(nextWidth);
  if (persist) {
    writeStoredEditorPaneWidth(nextWidth);
  }
  return nextWidth;
}

function syncEditorPaneWidthForViewport() {
  if (state.editorPaneWidth !== null) {
    applyEditorPaneWidth(state.editorPaneWidth, { persist: true });
    return;
  }
  updateEditorResizeHandleAttributes(getCurrentEditorPaneWidth());
}

function startEditorResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  const startWidth = getCurrentEditorPaneWidth();
  state.editorResizeDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth
  };
  els.editorResizeHandle.setPointerCapture(event.pointerId);
  els.editorResizeHandle.classList.add("isDragging");
  document.body.classList.add("isResizingEditor");
  updateEditorResizeHandleAttributes(startWidth);
}

function onEditorResizePointerMove(event) {
  const drag = state.editorResizeDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  applyEditorPaneWidth(drag.startWidth + drag.startX - event.clientX);
}

function endEditorResize(event) {
  const drag = state.editorResizeDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  cancelEditorResizeDrag();
  syncEditorPaneWidthForViewport();
}

function cancelEditorResizeDrag() {
  const drag = state.editorResizeDrag;
  state.editorResizeDrag = null;
  if (drag && drag.pointerId !== undefined && drag.pointerId !== null) {
    try {
      if (els.editorResizeHandle.hasPointerCapture(drag.pointerId)) {
        els.editorResizeHandle.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Pointer capture may already be gone after cancellation or disposal.
    }
  }
  els.editorResizeHandle.classList.remove("isDragging");
  document.body.classList.remove("isResizingEditor");
}

function onEditorResizeKeydown(event) {
  const currentWidth = getCurrentEditorPaneWidth();
  const step = event.shiftKey ? EDITOR_PANE_WIDTH_LARGE_STEP : EDITOR_PANE_WIDTH_STEP;
  let nextWidth = null;

  if (event.key === "ArrowLeft") {
    nextWidth = currentWidth + step;
  } else if (event.key === "ArrowRight") {
    nextWidth = currentWidth - step;
  } else if (event.key === "Home") {
    nextWidth = getEditorPaneKeyboardMinWidth();
  } else if (event.key === "End") {
    nextWidth = getEditorPaneMaxWidth();
  }

  if (nextWidth === null) return;
  event.preventDefault();
  applyEditorPaneWidth(nextWidth);
}

function bindEvents() {
  if (appEventController) appEventController.abort();
  appEventController = new AbortController();
  const on = (target, type, listener, options = {}) => {
    target.addEventListener(type, listener, {
      ...(typeof options === "boolean" ? { capture: options } : options),
      signal: appEventController.signal
    });
  };

  on(els.graphHelpButton, "click", openGraphHelpDialog);
  on(els.annotationToolbar, "click", onAnnotationToolbarClick);
  on(els.annotationEditor, "keydown", onAnnotationEditorKeydown);
  on(els.annotationEditor, "blur", commitAnnotationEditor);
  on(els.closeGraphHelpButton, "click", closeGraphHelpDialog);
  on(els.launchOpenProjectButton, "click", openNotesFolder);
  on(els.launchCreateProjectButton, "click", openCreateFolderDialog);
  on(els.launchRecentList, "click", onLaunchRecentClick);
  on(els.graphOpenProjectButton, "click", openNotesFolder);
  on(els.graphCreateProjectButton, "click", openCreateFolderDialog);
  on(els.graphRecentList, "click", onLaunchRecentClick);
  on(els.closeGraphProjectLauncherButton, "click", closeGraphProjectLauncher);
  on(els.updateButton, "click", installAvailableUpdate);
  on(els.workspaceTabs, "click", onWorkspaceTabsClick);
  on(els.workspaceTabs, "dblclick", onWorkspaceTabsDoubleClick);
  on(els.workspaceTabs, "focusout", onWorkspaceTabsFocusOut);
  on(els.workspaceTabs, "input", onWorkspaceTabsInput);
  on(els.workspaceTabs, "keydown", onWorkspaceTabsKeydown);
  on(els.newNoteButton, "click", openNewNoteDialog);
  on(els.zoomInButton, "click", () => zoomAtCenter(1.18));
  on(els.zoomOutButton, "click", () => zoomAtCenter(1 / 1.18));
  on(els.resetViewButton, "click", fitGraphViewFromControl);
  on(els.fullscreenGraphButton, "click", toggleGraphFullscreen);
  on(els.cancelNewNoteButton, "click", () => closeNewNoteDialog());
  on(els.cancelCreateFolderButton, "click", () => closeCreateFolderDialog());
  on(els.createFolderLocationSelect, "change", onCreateProjectLocationChange);
  on(els.closeHierarchyPromptButton, "click", () => closeHierarchyPromptDialog());
  on(els.copyHierarchyPromptButton, "click", () => copyHierarchyPrompt());
  on(els.cancelDeleteButton, "click", () => settleDeleteConfirm(false));
  on(els.confirmDeleteButton, "click", () => settleDeleteConfirm(true));
  on(els.deleteConfirmDialog, "close", () => settleDeleteConfirm(false));
  on(els.newNoteParent, "change", updateNewNoteHint);
  on(els.newNoteForm, "submit", createNewNote);
  on(els.createFolderForm, "submit", createGraphFolder);
  on(els.noteTitle, "blur", commitHeaderNoteTitle);
  on(els.noteTitle, "keydown", onHeaderNoteTitleKeydown);
  on(els.noteTitle, "paste", onHeaderNoteTitlePaste);
  on(els.noteInfo, "toggle", keepDisabledInfoClosed);
  on(els.infoParent, "change", onInfoChanged);
  on(els.fullscreenEditorButton, "click", toggleEditorFullscreen);
  on(els.deleteNoteButton, "click", deleteSelectedNote);
  on(els.graphCreatePopover, "submit", createGraphNoteFromPopover);
  on(els.cancelGraphCreateButton, "click", closeGraphCreatePopover);
  on(els.editorResizeHandle, "pointerdown", startEditorResize);
  on(els.editorResizeHandle, "pointermove", onEditorResizePointerMove);
  on(els.editorResizeHandle, "pointerup", endEditorResize);
  on(els.editorResizeHandle, "pointercancel", endEditorResize);
  on(els.editorResizeHandle, "keydown", onEditorResizeKeydown);

  on(els.searchInput, "focus", openSearchResults);
  on(els.searchInput, "click", openSearchResults);
  on(els.searchInput, "input", onSearchInput);
  on(els.searchInput, "keydown", onSearchKeydown);
  on(els.searchResults, "pointerdown", (event) => event.preventDefault());
  on(els.searchResults, "click", onSearchResultsClick);
  on(els.searchField, "focusout", onSearchFocusOut);
  on(document, "pointerdown", onDocumentSearchPointerDown);

  on(els.graph, "wheel", onGraphWheel, { passive: false });
  on(els.graph, "gesturestart", onGraphPinchStart, { passive: false });
  on(els.graph, "gesturechange", onGraphPinchChange, { passive: false });
  on(els.graph, "gestureend", onGraphPinchEnd, { passive: false });
  on(window, "blur", () => { graphPinch = null; });
  on(els.graph, "dblclick", onGraphDoubleClick);
  on(els.graph, "pointerdown", startGraphPointerDown);
  on(els.graph, "pointerover", onGraphPointerOver);
  on(els.graph, "pointerout", onGraphPointerOut);
  on(els.graph, "focusin", onGraphFocusIn);
  on(els.graph, "focusout", onGraphFocusOut);
  on(els.graph, "pointermove", queueInteraction);
  on(els.graph, "pointerup", endInteraction);
  on(els.graph, "pointercancel", cancelInteraction);
  on(els.graph, "keydown", onGraphKeydown);
  on(els.graph, "dragover", onGraphDragOver);
  on(els.graph, "dragleave", onGraphDragLeave);
  on(els.graph, "drop", onGraphDrop);
  on(document, "keydown", onDocumentKeydown);
  on(document, "pointerdown", onDocumentPointerDown);
  on(window, "resize", scheduleResizeRender);
  on(window, "focus", refreshAppUpdateOnFocus);
  on(document, "visibilitychange", refreshAppUpdateOnVisibilityChange);
  on(document, "fullscreenchange", syncFullscreenState);
  on(window, "keydown", (event) => {
    if (event.key === "Escape") {
      if (state.editorFullscreenFallback && document.body.classList.contains("editorFullscreen") && !document.fullscreenElement) {
        event.preventDefault();
        exitEditorFullscreen();
        return;
      }
      const isGraphCreateTarget = els.graphCreatePopover.contains(event.target);
      if (!isGraphCreateTarget && (isTextEntryTarget(event.target) || isAnyDialogOpen())) return;

      const hadGraphCreatePopover = !els.graphCreatePopover.hidden;
      closeGraphCreatePopover();
      if (hadGraphCreatePopover) {
        event.preventDefault();
        setStatus("New graph note canceled");
      }
      if (state.armedRope) {
        event.preventDefault();
        clearArmedRope("Connection canceled");
      }
      if (state.activeInteraction?.type?.startsWith?.("annotation-")) {
        event.preventDefault();
        cancelInteraction();
        setAnnotationTool("select");
        setStatus("Drawing canceled");
        return;
      }
      if (state.annotationTool !== "select") {
        event.preventDefault();
        setAnnotationTool("select");
        return;
      }
      if (state.graphFullscreenFallback && document.body.classList.contains("graphFullscreen") && !document.fullscreenElement) {
        event.preventDefault();
        exitGraphFullscreen();
      }
    }
  });
}

function openGraphHelpDialog() {
  if (typeof els.graphHelpDialog.showModal === "function") {
    els.graphHelpDialog.showModal();
  } else {
    els.graphHelpDialog.removeAttribute("hidden");
  }
}

function closeGraphHelpDialog() {
  if (typeof els.graphHelpDialog.close === "function") {
    els.graphHelpDialog.close();
  } else {
    els.graphHelpDialog.setAttribute("hidden", "");
  }
}

function openGraphProjectLauncher() {
  if (!hasWritableWorkspace() || state.historyApplying) {
    return;
  }

  closeGraphCreatePopover();
  prepareAnnotationTransition();
  state.graphProjectLauncherOpen = true;
  renderGraphProjectLauncher();
  renderWorkspaceTabs();
  setStatus("Choose a project");
}

function closeGraphProjectLauncher() {
  if (!state.graphProjectLauncherOpen) return;

  state.graphProjectLauncherOpen = false;
  renderGraphProjectLauncher();
  renderWorkspaceTabs();
  setStatus(hasWritableWorkspace() ? "Graph ready" : "");
}

function isAnyDialogOpen() {
  return [
    els.graphHelpDialog,
    els.newNoteDialog,
    els.createFolderDialog,
    els.hierarchyPromptDialog,
    els.deleteConfirmDialog
  ].some((dialog) => dialog && dialog.open);
}

function toggleGraphFullscreen() {
  if (document.body.classList.contains("graphFullscreen")) {
    exitGraphFullscreen();
    return;
  }

  enterGraphFullscreen();
}

function syncFullscreenState() {
  syncGraphFullscreenState();
  syncEditorFullscreenState();
}

function enterGraphFullscreen() {
  closeGraphCreatePopover();
  document.body.classList.remove("editorFullscreen");
  state.editorFullscreenFallback = false;
  syncEditorFullscreenButton();
  document.body.classList.add("graphFullscreen");
  state.graphFullscreenFallback = !document.body.requestFullscreen;
  syncGraphFullscreenButton();
  requestGraphRender({ preserveView: true });

  if (document.body.requestFullscreen && !document.fullscreenElement) {
    document.body.requestFullscreen().catch(() => {
      state.graphFullscreenFallback = true;
      syncGraphFullscreenState();
    });
  }
}

function exitGraphFullscreen() {
  document.body.classList.remove("graphFullscreen");
  state.graphFullscreenFallback = false;
  syncGraphFullscreenButton();
  requestGraphRender({ preserveView: true });

  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {
      syncGraphFullscreenState();
    });
  }
}

function syncGraphFullscreenState() {
  const fullscreenElement = document.fullscreenElement;
  const isFullscreen = fullscreenElement === document.body || fullscreenElement === els.graphPane || (
    state.graphFullscreenFallback &&
    document.body.classList.contains("graphFullscreen") &&
    !fullscreenElement
  );
  if (fullscreenElement === document.body || fullscreenElement === els.graphPane) {
    state.graphFullscreenFallback = false;
  }
  document.body.classList.toggle("graphFullscreen", isFullscreen);
  syncGraphFullscreenButton();
  requestGraphRender({ preserveView: true });
}

function syncGraphFullscreenButton() {
  const isFullscreen = document.body.classList.contains("graphFullscreen");
  setButtonIcon(els.fullscreenGraphButton, isFullscreen ? "fullscreenExit" : "fullscreenEnter");
  els.fullscreenGraphButton.setAttribute(
    "aria-label",
    isFullscreen ? "Exit full screen graph" : "Enter full screen graph"
  );
  els.fullscreenGraphButton.title = isFullscreen ? "Exit full screen graph" : "Enter full screen graph";
  els.fullscreenGraphButton.setAttribute("aria-pressed", String(isFullscreen));
}

function toggleEditorFullscreen() {
  if (document.body.classList.contains("editorFullscreen")) {
    exitEditorFullscreen();
    return;
  }

  enterEditorFullscreen();
}

function enterEditorFullscreen() {
  closeGraphCreatePopover();
  document.body.classList.remove("graphFullscreen");
  state.graphFullscreenFallback = false;
  syncGraphFullscreenButton();
  document.body.classList.add("editorFullscreen");
  state.editorFullscreenFallback = !els.editorPane.requestFullscreen;
  syncEditorFullscreenButton();
  refreshEditorLayout();

  if (els.editorPane.requestFullscreen && !document.fullscreenElement) {
    els.editorPane.requestFullscreen().catch(() => {
      state.editorFullscreenFallback = true;
      syncEditorFullscreenState();
    });
  }
}

function exitEditorFullscreen() {
  document.body.classList.remove("editorFullscreen");
  state.editorFullscreenFallback = false;
  syncEditorFullscreenButton();
  refreshEditorLayout();

  if (document.fullscreenElement === els.editorPane && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {
      syncEditorFullscreenState();
    });
  }
}

function syncEditorFullscreenState() {
  const fullscreenElement = document.fullscreenElement;
  const isFullscreen = fullscreenElement === els.editorPane || (
    state.editorFullscreenFallback &&
    document.body.classList.contains("editorFullscreen") &&
    !fullscreenElement
  );
  if (fullscreenElement === els.editorPane) {
    state.editorFullscreenFallback = false;
  }
  document.body.classList.toggle("editorFullscreen", isFullscreen);
  syncEditorFullscreenButton();
  refreshEditorLayout();
}

function syncEditorFullscreenButton() {
  const isFullscreen = document.body.classList.contains("editorFullscreen");
  setButtonIcon(els.fullscreenEditorButton, isFullscreen ? "fullscreenExit" : "fullscreenEnter");
  els.fullscreenEditorButton.setAttribute(
    "aria-label",
    isFullscreen ? "Exit full screen editor" : "Enter full screen editor"
  );
  els.fullscreenEditorButton.title = isFullscreen ? "Exit full screen editor" : "Enter full screen editor";
  els.fullscreenEditorButton.setAttribute("aria-pressed", String(isFullscreen));
}

function refreshEditorLayout() {
  state.editorView?.requestMeasure();
}

function updateGraphTitle() {
  if (state.renamingWorkspaceId && state.renamingWorkspaceId !== state.activeWorkspaceId) {
    state.renamingWorkspaceId = null;
    state.workspaceRenameDraft = "";
  }
}

function updateHeaderNoteTitleEditable(isEditable) {
  els.noteTitle.contentEditable = isEditable ? "plaintext-only" : "false";
  els.noteTitle.setAttribute("aria-readonly", String(!isEditable));
  els.noteTitle.setAttribute("aria-label", isEditable ? "Edit selected note title" : "Selected note title");
  els.noteTitle.title = isEditable ? "Edit selected note title" : "Selected note title";
  els.noteTitle.tabIndex = isEditable ? 0 : -1;
  els.noteTitle.classList.toggle("editableTitle", isEditable);
  if (isEditable) {
    els.noteTitle.setAttribute("role", "textbox");
    els.noteTitle.setAttribute("aria-multiline", "false");
  } else {
    els.noteTitle.removeAttribute("role");
    els.noteTitle.removeAttribute("aria-multiline");
  }
}

function commitHeaderNoteTitle() {
  const note = getSelectedNote();
  if (!hasWritableWorkspace() || !note) return;

  const title = normalizeHeaderTitleText(els.noteTitle.textContent);
  if (!title || title === note.title) {
    els.noteTitle.textContent = note.title || "Untitled";
    return;
  }

  els.noteTitle.textContent = title;
  markSelectedDirty();
}

function onHeaderNoteTitleKeydown(event) {
  if (!els.noteTitle.classList.contains("editableTitle")) return;
  event.stopPropagation();
  if (event.key === "Enter") {
    event.preventDefault();
    els.noteTitle.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    const note = getSelectedNote();
    els.noteTitle.textContent = note ? note.title : "Select a note";
    els.noteTitle.blur();
  }
}

function onHeaderNoteTitlePaste(event) {
  if (!els.noteTitle.classList.contains("editableTitle")) return;
  event.preventDefault();
  const text = normalizeHeaderTitleText(event.clipboardData?.getData("text") || "");
  if (!text) return;
  insertTextIntoEditableTitle(text);
}

function insertTextIntoEditableTitle(text) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !els.noteTitle.contains(selection.anchorNode)) {
    els.noteTitle.textContent = normalizeHeaderTitleText(`${els.noteTitle.textContent || ""} ${text}`);
    placeCaretAtEnd(els.noteTitle);
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  els.noteTitle.textContent = normalizeHeaderTitleText(els.noteTitle.textContent);
  placeCaretAtEnd(els.noteTitle);
}

function placeCaretAtEnd(element) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function normalizeHeaderTitleText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function keepDisabledInfoClosed() {
  if (els.noteInfo.getAttribute("aria-disabled") === "true" && els.noteInfo.open) {
    els.noteInfo.open = false;
  }
}

async function renameActiveWorkspace(requestedName) {
  requestedName = normalizeHeaderTitleText(requestedName);
  if (!hasWritableWorkspace()) {
    renderWorkspaceTabs();
    return;
  }

  if (!requestedName || requestedName === state.workspaceName) {
    renderWorkspaceTabs();
    return;
  }

  const previousRootPath = state.rootPath;
  const transitionLock = beginAnnotationTransitionLock(state.activeWorkspaceId);
  if (!transitionLock) {
    setStatus("Folder transition already in progress");
    return;
  }
  stopLiveSync();

  try {
    if (state.dirty) {
      await flushAutosave();
      if (state.dirty) {
        throw new Error("Save the current note before renaming the folder.");
      }
    }

    await awaitPendingAnnotationWrites(state.activeWorkspaceId);

    const workspace = await invokeNative("rename_workspace", {
      rootPath: previousRootPath,
      folderName: requestedName
    });
    setNativeWorkspace(workspace, "Folder renamed", { previousRootPath, preserveHistory: true });
  } catch (error) {
    setStatus(`Could not rename folder: ${String(error)}`);
    renderWorkspaceTabs();
    startLiveSync();
  } finally {
    endAnnotationTransitionLock(transitionLock);
  }
}

function startWorkspaceTabRename(workspaceId) {
  if (!hasWritableWorkspace() || workspaceId !== state.activeWorkspaceId) return;
  state.renamingWorkspaceId = workspaceId;
  state.workspaceRenameDraft = state.workspaceName || "Folder";
  renderWorkspaceTabs();
  window.requestAnimationFrame(() => {
    const input = els.workspaceTabs.querySelector("[data-rename-workspace]");
    if (!input) return;
    input.focus();
    input.select();
  });
}

function cancelWorkspaceTabRename() {
  if (!state.renamingWorkspaceId) return;
  state.renamingWorkspaceId = null;
  state.workspaceRenameDraft = "";
  renderWorkspaceTabs();
}

async function commitWorkspaceTabRename(input) {
  const workspaceId = input?.dataset.renameWorkspace || "";
  if (!workspaceId || state.renamingWorkspaceId !== workspaceId) return;
  const requestedName = normalizeHeaderTitleText(input.value);
  state.renamingWorkspaceId = null;
  state.workspaceRenameDraft = "";
  renderWorkspaceTabs();
  await renameActiveWorkspace(requestedName);
}

function onWorkspaceTabsClick(event) {
  if (event.target.closest("[data-rename-workspace]")) {
    return;
  }

  const openButton = event.target.closest("[data-open-workspace]");
  if (openButton) {
    event.preventDefault();
    openGraphProjectLauncher();
    return;
  }

  const closeProjectChooserButton = event.target.closest("[data-close-project-chooser]");
  if (closeProjectChooserButton) {
    event.preventDefault();
    event.stopPropagation();
    closeGraphProjectLauncher();
    return;
  }

  const closeButton = event.target.closest("[data-close-workspace]");
  if (closeButton) {
    event.preventDefault();
    event.stopPropagation();
    void closeWorkspaceTab(closeButton.dataset.closeWorkspace);
    return;
  }

  const switchButton = event.target.closest("[data-switch-workspace]");
  if (switchButton) {
    event.preventDefault();
    if (switchButton.dataset.switchWorkspace === state.activeWorkspaceId) {
      closeGraphProjectLauncher();
      return;
    }
    void switchWorkspaceTab(switchButton.dataset.switchWorkspace);
  }
}

function onWorkspaceTabsDoubleClick(event) {
  if (event.target.closest("[data-close-workspace], [data-close-project-chooser], [data-open-workspace], [data-rename-workspace]")) {
    return;
  }

  const tab = event.target.closest(".workspaceTab.active[data-workspace-id]");
  if (!tab) return;
  event.preventDefault();
  startWorkspaceTabRename(tab.dataset.workspaceId);
}

function onWorkspaceTabsInput(event) {
  const input = event.target.closest("[data-rename-workspace]");
  if (!input || state.renamingWorkspaceId !== input.dataset.renameWorkspace) return;
  state.workspaceRenameDraft = input.value;
}

function onWorkspaceTabsFocusOut(event) {
  if (suppressWorkspaceRenameCommit) return;
  const input = event.target.closest("[data-rename-workspace]");
  if (!input) return;
  void commitWorkspaceTabRename(input);
}

function onWorkspaceTabsKeydown(event) {
  const renameInput = event.target.closest("[data-rename-workspace]");
  if (renameInput) {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commitWorkspaceTabRename(renameInput);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelWorkspaceTabRename();
    }
    return;
  }

  if (event.key !== "F2") return;
  const switchButton = event.target.closest("[data-switch-workspace]");
  if (!switchButton || switchButton.dataset.switchWorkspace !== state.activeWorkspaceId) return;
  event.preventDefault();
  startWorkspaceTabRename(switchButton.dataset.switchWorkspace);
}

function onLaunchRecentClick(event) {
  const recentButton = event.target.closest("[data-recent-root-path]");
  if (!recentButton) return;

  event.preventDefault();
  void openRecentProject(recentButton.dataset.recentRootPath);
}

function startEmpty() {
  prepareAnnotationTransition();
  stopLiveSync();
  closeGraphProjectLauncher();
  state.activeWorkspaceId = null;
  state.notes = [];
  state.graphIndex = null;
  state.searchIndex = null;
  state.byPath = new Map();
  state.byKey = new Map();
  state.notePaths = new Set();
  state.sortedNotes = [];
  state.sortedParentOptions = [];
  state.selectedPath = null;
  state.selectedPaths = new Set();
  state.rootPath = "";
  state.notesPath = "";
  state.source = "none";
  state.workspaceName = "";
  state.workspaceMetrics = null;
  state.searchIndexMode = "full";
  state.dirty = false;
  state.saveToken += 1;
  state.undoStack = [];
  state.redoStack = [];
  state.historyApplying = false;
  state.fileSignatures = new Map();
  cancelQueuedGraphRender();
  cancelGraphViewAnimation();
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  state.filter = "";
  state.searchResults = [];
  state.searchOpen = false;
  state.searchActiveIndex = -1;
  state.validation = [];
  state.layoutKey = "";
  state.graphHasHierarchy = true;
  state.annotations = emptyAnnotationDocument();
  state.annotationsError = "";
  state.dates = emptyDateDocument();
  state.datesError = "";
  state.noteFileTimes = {};
  state.annotationTool = "select";
  state.selectedAnnotationId = null;
  state.annotationEditorState = null;
  state.hierarchyPromptShown = false;
  state.manualPositions = {};
  state.autoPositions = new Map();
  state.positions = new Map();
  state.nodeSizes = new Map();
  state.nodeElements = new Map();
  state.edgeElements = [];
  state.edgeElementsByPath = new Map();
  state.spatialIndex = null;
  state.referenceEdges = [];
  state.referenceEdgeCount = 0;
  state.largeGraphMode = false;
  state.labelStats = new Map();
  state.labelVisibilityCache = null;
  state.labelVisibility = null;
  state.labelVisibilityKey = "";
  cancelLabelVisibilityRefresh();
  state.hoveredPath = null;
  state.focusedPath = null;
  state.pendingCreatePoint = null;
  state.nodeClipboard = null;
  state.lastGraphPoint = null;
  state.lastNodePointerDown = null;
  state.suppressGraphCreateUntil = 0;
  state.armedRope = null;
  state.activeInteraction = null;
  state.renamingWorkspaceId = null;
  state.workspaceRenameDraft = "";
  cancelQueuedInteraction();
  state.graphViewport = null;
  els.searchInput.value = "";
  renderSearchResults();
  renderSelectedNote("Open or create a folder");
  renderNewNoteParents();
  renderGraph({ preserveView: false });
  updateSourceStatus();
  renderValidationStatus();
  renderWorkspaceTabs();
  renderLaunchScreen();
}

async function openNotesFolder() {
  if (!isTauriApp()) {
    setStatus("Open the desktop app to use local folders");
    return;
  }

  let transitionLock = null;
  try {
    const rootPath = await pickNativeDirectory();
    if (!rootPath) return;
    const existing = state.workspaces.find((workspace) => workspace.rootPath === rootPath);
    if (existing) {
      transitionLock = beginAnnotationTransitionLock(existing.id);
      if (!transitionLock) throw new Error("Folder transition already in progress");
    }
    if (state.dirty) {
      await flushAutosave();
      if (state.dirty) return;
    }
    await awaitPendingAnnotationWritesForRoot(rootPath);
    const workspace = await invokeNative("read_workspace", { rootPath });
    closeGraphProjectLauncher();
    setNativeWorkspace(workspace, "Folder loaded");
  } catch (error) {
    if (error && error.name !== "AbortError") {
      setStatus("Could not open folder");
      console.error(error);
    }
  } finally {
    endAnnotationTransitionLock(transitionLock);
  }
}

async function openRecentProject(rootPath) {
  if (!rootPath) return;

  if (!isTauriApp()) {
    setStatus("Open the desktop app to use recent projects");
    return;
  }

  const existing = state.workspaces.find((workspace) => workspace.rootPath === rootPath);
  const transitionLock = existing ? beginAnnotationTransitionLock(existing.id) : null;
  if (existing && !transitionLock) {
    setStatus("Folder transition already in progress");
    return;
  }
  try {
    if (state.dirty) {
      await flushAutosave();
      if (state.dirty) return;
    }
    setStatus("Opening recent project");
    await awaitPendingAnnotationWritesForRoot(rootPath);
    const workspace = await invokeNative("read_workspace", { rootPath });
    closeGraphProjectLauncher();
    setNativeWorkspace(workspace, "Recent project opened");
  } catch (error) {
    state.recentProjects = removeRecentProject(rootPath, state.recentProjects);
    saveRecentProjects(state.recentProjects);
    renderLaunchScreen();
    void forgetNativeRecentProject(rootPath);
    setStatus("Could not open recent project");
    console.error(error);
  } finally {
    endAnnotationTransitionLock(transitionLock);
  }
}

async function openCreateFolderDialog() {
  if (!isTauriApp()) {
    setStatus("Open the desktop app to create folders");
    return;
  }

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  await hydrateDefaultProjectLocation();
  prepareCreateProjectDialog();

  if (typeof els.createFolderDialog.showModal === "function") {
    els.createFolderDialog.showModal();
  } else {
    els.createFolderDialog.removeAttribute("hidden");
  }
  els.createFolderName.focus();
}

function closeCreateFolderDialog() {
  if (typeof els.createFolderDialog.close === "function") {
    els.createFolderDialog.close();
  } else {
    els.createFolderDialog.setAttribute("hidden", "");
  }
}

async function hydrateDefaultProjectLocation() {
  if (!isTauriApp() || state.defaultProjectLocation) return;

  try {
    state.defaultProjectLocation = await invokeNative("default_project_location");
  } catch (error) {
    console.error(error);
  }
}

function prepareCreateProjectDialog() {
  if (!els.createFolderName.value.trim()) {
    els.createFolderName.value = "apex-notes";
  }
  if (!state.createProjectParentPath) {
    state.createProjectParentPath = getPreferredProjectLocation();
  }
  renderCreateProjectLocations();
}

function getPreferredProjectLocation() {
  return buildProjectLocationOptions()[0]?.path || "";
}

function buildProjectLocationOptions() {
  const locations = [];

  if (state.rootPath) {
    locations.push({
      path: projectParentFromPath(state.rootPath),
      label: "Current location"
    });
  }

  if (state.browsedProjectLocation) {
    locations.push({
      path: state.browsedProjectLocation,
      label: "Selected location"
    });
  }

  for (const project of state.recentProjects) {
    const path = projectParentFromPath(project.rootPath);
    locations.push({
      path,
      label: projectNameFromPath(path)
    });
  }

  if (state.defaultProjectLocation) {
    locations.push({
      path: state.defaultProjectLocation,
      label: "Default location"
    });
  }

  const seen = new Set();
  const options = [];
  for (const location of locations) {
    const path = String(location.path || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    options.push({
      path,
      label: location.label || projectNameFromPath(path) || "Location"
    });
    if (options.length === 4) break;
  }

  return options;
}

function renderCreateProjectLocations() {
  const options = buildProjectLocationOptions();
  if (!options.some((option) => option.path === state.createProjectParentPath)) {
    state.createProjectParentPath = options[0]?.path || "";
  }

  const fragment = document.createDocumentFragment();
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.path;
    item.textContent = `${option.label} - ${projectDisplayPath(option.path)}`;
    fragment.appendChild(item);
  }

  const browse = document.createElement("option");
  browse.value = BROWSE_PROJECT_LOCATION_VALUE;
  browse.textContent = "Browse...";
  fragment.appendChild(browse);

  els.createFolderLocationSelect.replaceChildren(fragment);
  els.createFolderLocationSelect.value = state.createProjectParentPath || BROWSE_PROJECT_LOCATION_VALUE;
  els.createFolderLocationPath.textContent = state.createProjectParentPath
    ? projectDisplayPath(state.createProjectParentPath)
    : "Choose Browse to pick a location";
}

async function onCreateProjectLocationChange() {
  const selected = els.createFolderLocationSelect.value;
  if (selected !== BROWSE_PROJECT_LOCATION_VALUE) {
    state.createProjectParentPath = selected;
    renderCreateProjectLocations();
    return;
  }

  const previous = state.createProjectParentPath;
  try {
    setStatus("Choose where to store the project");
    const parentPath = await pickNativeDirectory();
    if (parentPath) {
      state.browsedProjectLocation = parentPath;
      state.createProjectParentPath = parentPath;
    } else {
      state.createProjectParentPath = previous;
    }
  } catch (error) {
    state.createProjectParentPath = previous;
    if (error && error.name !== "AbortError") {
      setStatus("Could not choose project location");
      console.error(error);
    }
  }

  renderCreateProjectLocations();
}

async function createGraphFolder(event) {
  event.preventDefault();

  const requestedFolder = slugify(els.createFolderName.value.trim()) || "apex-notes";
  const parentPath = state.createProjectParentPath || getPreferredProjectLocation();

  if (!parentPath) {
    setStatus("Choose a project location");
    renderCreateProjectLocations();
    return;
  }

  try {
    setStatus("Creating project");
    const workspace = await invokeNative("create_workspace", {
      parentPath,
      folderName: requestedFolder
    });
    closeGraphProjectLauncher();
    setNativeWorkspace(workspace, "Folder created");
    closeCreateFolderDialog();
  } catch (error) {
    if (error && error.name !== "AbortError") {
      setStatus("Could not create folder");
      console.error(error);
    }
  }
}

async function hydrateRecentProjects() {
  if (!isTauriApp()) {
    renderLaunchScreen();
    return;
  }

  try {
    state.recentProjects = normalizeRecentProjects(await invokeNative("read_recent_projects"));
    saveRecentProjects(state.recentProjects);
    renderLaunchScreen();
  } catch (error) {
    renderLaunchScreen();
    console.error(error);
  }
}

function startAppUpdateChecks() {
  renderUpdateButton();
  if (!canCheckForAppUpdate()) return;

  void checkForAvailableUpdate();
  if (state.appUpdateCheckTimer) window.clearInterval(state.appUpdateCheckTimer);
  state.appUpdateCheckTimer = window.setInterval(() => {
    void checkForAvailableUpdate();
  }, APP_UPDATE_CHECK_INTERVAL_MS);
}

function canCheckForAppUpdate() {
  return isTauriApp() && typeof window.fetch === "function";
}

function refreshAppUpdateOnFocus() {
  void checkForAvailableUpdate();
}

function refreshAppUpdateOnVisibilityChange() {
  if (!document.hidden) {
    void checkForAvailableUpdate();
  }
}

async function checkForAvailableUpdate() {
  if (!canCheckForAppUpdate() || state.appUpdateCheckInFlight || state.appUpdateInstallInFlight) return;
  state.appUpdateCheckInFlight = true;

  try {
    const availability = await checkForAppUpdate({
      current: getCurrentBuildInfo(),
      fetchImpl: window.fetch.bind(window)
    });
    state.appUpdate = availability.available ? availability : null;
    renderUpdateButton();
  } catch (error) {
    state.appUpdate = null;
    renderUpdateButton();
    console.warn("Update check failed", error);
  } finally {
    state.appUpdateCheckInFlight = false;
  }
}

function renderUpdateButton(statusMessage = "") {
  const update = state.appUpdate;
  const visible = Boolean(update && update.available);
  document.body.classList.toggle("hasAppUpdate", visible);
  els.updateButton.hidden = !visible;

  if (!visible) {
    els.updateButton.disabled = false;
    hideUpdateRestartOverlay();
    return;
  }

  const label = state.appUpdateInstallState || "Update";
  setButtonIcon(els.updateButton, "download", label);
  els.updateButton.disabled = state.appUpdateInstallInFlight;
  els.updateButton.title = statusMessage || `Install main update ${update.shortCommit}`;
  els.updateButton.setAttribute("aria-label", statusMessage || `Install Apex Notes update ${update.shortCommit}`);
}

async function installAvailableUpdate() {
  const update = state.appUpdate;
  if (!update || !update.available || state.appUpdateInstallInFlight) return;

  state.appUpdateInstallInFlight = true;
  state.appUpdateInstallState = "Updating...";
  renderUpdateButton("Installing update");
  setStatus("Installing update");

  try {
    await waitForPaint();
    await invokeNative("install_app_update", {
      releaseCommit: update.releaseCommit
    });
    state.appUpdateInstallState = "Restarting...";
    renderUpdateButton("Restarting after update");
    setStatus("Restarting after update");
    showUpdateRestartOverlay();
    await waitForPaint();
  } catch (error) {
    state.appUpdateInstallInFlight = false;
    state.appUpdateInstallState = "";
    renderUpdateButton();
    hideUpdateRestartOverlay();
    setStatus("Update failed");
    console.error(error);
  }
}

function showUpdateRestartOverlay() {
  els.updateRestartOverlay.hidden = false;
  els.updateRestartOverlay.focus({ preventScroll: true });
}

function hideUpdateRestartOverlay() {
  els.updateRestartOverlay.hidden = true;
}

function waitForPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

function canLiveSyncWorkspace() {
  return isTauriApp() && state.source === "folder" && Boolean(state.notesPath);
}

function startLiveSync() {
  stopLiveSync();
  if (!canLiveSyncWorkspace()) return;

  state.liveSyncToken += 1;
  scheduleLiveSync(true);
}

function stopLiveSync() {
  if (state.liveSyncTimer) {
    window.clearTimeout(state.liveSyncTimer);
    state.liveSyncTimer = 0;
  }
  state.liveSyncToken += 1;
  state.liveSyncInFlight = false;
}

function scheduleLiveSync(immediate = false) {
  if (!canLiveSyncWorkspace()) return;
  if (state.liveSyncTimer) {
    window.clearTimeout(state.liveSyncTimer);
  }

  state.liveSyncTimer = window.setTimeout(() => {
    state.liveSyncTimer = 0;
    void checkLiveFolderUpdates();
  }, immediate ? 0 : LIVE_SYNC_INTERVAL_MS);
}

async function checkLiveFolderUpdates() {
  if (!canLiveSyncWorkspace()) return;
  if (state.liveSyncInFlight) {
    scheduleLiveSync();
    return;
  }

  const token = state.liveSyncToken;
  state.liveSyncInFlight = true;

  try {
    if (state.dirty || state.saveTimer || state.activeInteraction || dateWriteTailsByWorkspace.has(state.activeWorkspaceId)) return;

    const statuses = await invokeNative("list_note_files", {
      notesPath: state.notesPath
    });
    if (token !== state.liveSyncToken || !canLiveSyncWorkspace()) return;

    const { pathsToRead, deletedPaths, nextSignatures } = diffFileSignatures(state.fileSignatures, statuses);

    if (!pathsToRead.length && !deletedPaths.length) {
      state.fileSignatures = nextSignatures;
      saveActiveWorkspaceState();
      return;
    }

    if (state.dirty || state.saveTimer || state.activeInteraction || dateWriteTailsByWorkspace.has(state.activeWorkspaceId)) return;

    const files = pathsToRead.length
      ? await invokeNative("read_notes", {
        notesPath: state.notesPath,
        paths: pathsToRead
      })
      : [];

    if (
      token !== state.liveSyncToken ||
      !canLiveSyncWorkspace() ||
      state.dirty ||
      state.saveTimer ||
      state.activeInteraction ||
      dateWriteTailsByWorkspace.has(state.activeWorkspaceId)
    ) {
      return;
    }

    applyLiveWorkspaceUpdate({ files, deletedPaths, nextSignatures });
  } catch (error) {
    console.warn("Live folder sync failed", error);
  } finally {
    if (token === state.liveSyncToken) {
      state.liveSyncInFlight = false;
    }
    if (token === state.liveSyncToken && canLiveSyncWorkspace()) {
      scheduleLiveSync();
    }
  }
}

function applyLiveWorkspaceUpdate({ files, deletedPaths, nextSignatures }) {
  const deletedSet = new Set(deletedPaths.filter((path) => state.byPath.has(path)));
  const incomingNotes = new Map();
  const added = new Set();
  const changed = new Set();
  const layoutSnapshot = snapshotGraphPositions();
  const dateNotes = { ...(state.dates?.notes || {}) };
  const dateBudget = dateMetadataBudget(dateNotes);

  for (const file of files || []) {
    if (!file || !file.path) continue;
    state.noteFileTimes[file.path] = { createdMs: file.createdMs, modifiedMs: file.modifiedMs };
    const existing = state.byPath.get(file.path);
    if (existing && existing.raw === file.raw) continue;

    const note = parseNote(file.path, file.raw);
    try {
      if (!getActiveWorkspace().dateCapacityError) {
        const nextDates = dateNotes[file.path]
          ? reconcileNoteDates(note.body, dateNotes[file.path], { day: dayFromTimestamp(file.modifiedMs), estimated: true })
          : seedNoteDates(note.body, file);
        assignBoundedNoteDates(getActiveWorkspace(), dateNotes, file.path, nextDates, dateBudget);
      }
    } catch (error) {
      const workspace = getActiveWorkspace();
      workspace.dateTrackingErrors ||= {};
      workspace.dateTrackingErrors[file.path] = `Date tracking unavailable: ${error?.message || error}`;
    }
    incomingNotes.set(file.path, note);
    if (existing) {
      changed.add(file.path);
    } else {
      added.add(file.path);
    }
  }

  if (!incomingNotes.size && !deletedSet.size) {
    state.fileSignatures = nextSignatures;
    saveActiveWorkspaceState();
    renderNoteDates();
    return;
  }

  for (const path of deletedSet) { delete dateNotes[path]; delete state.noteFileTimes[path]; }
  setWorkspaceDates(getActiveWorkspace(), { version: 1, notes: dateNotes });
  editorHydrationEpoch += 1;

  state.notes = state.notes.filter((note) => !deletedSet.has(note.path) && !incomingNotes.has(note.path));
  state.notes.push(...incomingNotes.values());
  state.notes.sort((a, b) => compareText(a.path, b.path));

  for (const path of deletedSet) {
    delete state.manualPositions[path];
  }

  state.fileSignatures = nextSignatures;
  state.dirty = false;
  rebuildIndex();
  state.validation = validateNotes();
  state.manualPositions = pruneStoredPositions(state.manualPositions);
  freezeGraphPositions(layoutSnapshot, { excludePaths: deletedSet });
  seedAddedNotePositions(added, layoutSnapshot);
  normalizeSelectionAfterNotesChanged();

  renderCurrentSelection(liveUpdateStatus(added.size, changed.size, deletedSet.size));
  renderNewNoteParents();
  renderGraph({ preserveView: true });
  void savePositionPatch(positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot, added)));
  updateSourceStatus();
  maybeShowHierarchyPrompt();
  renderValidationStatus();
  clearWorkspaceHistory();
  saveActiveWorkspaceState();
  void queueDatePersistence();
}

function normalizeSelectionAfterNotesChanged() {
  state.selectedPaths = new Set([...state.selectedPaths].filter((path) => state.byPath.has(path)));
  if (state.selectedPath && !state.byPath.has(state.selectedPath)) {
    state.selectedPath = null;
  }
  if (state.selectedPaths.size > 1) {
    state.selectedPath = null;
  }
  if (state.selectedPath && !state.selectedPaths.size) {
    state.selectedPaths.add(state.selectedPath);
  }
  if (!state.selectedPath && state.selectedPaths.size === 1) {
    state.selectedPath = [...state.selectedPaths][0];
  }
  if (!state.selectedPath && !state.selectedPaths.size) {
    const firstRoot = state.notes.find((note) => note.level === 0) || state.notes[0];
    state.selectedPath = firstRoot ? firstRoot.path : null;
    if (state.selectedPath) {
      state.selectedPaths.add(state.selectedPath);
    }
  }
}

function setNativeWorkspace(workspace, statusMessage, { previousRootPath, preserveHistory = false } = {}) {
  editorHydrationEpoch += 1;
  prepareAnnotationTransition();
  saveActiveWorkspaceState();

  const rootPath = workspace.rootPath || "";
  const workspaceName = workspace.workspaceName || rootPath || "Folder";
  const existing = state.workspaces.find((item) => item.rootPath === rootPath || (
    previousRootPath &&
    item.rootPath === previousRootPath
  ));
  const target = existing || {
    id: `workspace-${state.nextWorkspaceId++}`,
    selectedPath: null,
    filter: "",
    view: { x: 0, y: 0, scale: 1 },
    hasView: false,
    undoStack: [],
    redoStack: [],
    hierarchyPromptShown: false,
    hierarchyPromptText: ""
  };

  const layoutKey = buildLayoutKey("folder", rootPath, workspaceName);
  target.rootPath = rootPath;
  target.notesPath = workspace.notesPath || "";
  target.source = "folder";
  target.workspaceName = workspaceName;
  target.layoutKey = layoutKey;
  target.notes = (workspace.notes || []).map((note) => parseNote(note.path, note.raw));
  target.workspaceMetrics = buildWorkspaceMetricsFromFiles(workspace.notes || []);
  target.searchIndexMode = searchIndexModeForMetrics(target.workspaceMetrics);
  target.fileSignatures = buildFileSignatureMap(workspace.notes || []);
  initializeWorkspaceDates(target, workspace);
  target.dirty = false;
  if (!preserveHistory) {
    target.undoStack = [];
    target.redoStack = [];
  }
  target.annotationsError = workspace.annotationsError || "";
  try {
    target.annotations = normalizeAnnotationDocument(workspace.annotations || emptyAnnotationDocument());
  } catch (error) {
    target.annotations = emptyAnnotationDocument();
    target.annotationsError = workspace.annotationsError || String(error?.message || error);
  }
  target.persistedAnnotations = cloneAnnotationDocument(target.annotations);
  target.annotationSaveError = "";
  persistedAnnotationDocumentsByWorkspace.set(target.id, cloneAnnotationDocument(target.annotations));
  deferredAnnotationHistoryByWorkspace.delete(target.id);
  const targetNotePaths = new Set(target.notes.map((note) => note.path));
  target.manualPositions = existing
    ? pruneStoredPositions(existing.manualPositions, targetNotePaths)
    : readStoredPositions(workspace.positions || {}, layoutKey, targetNotePaths);

  if (!existing) {
    state.workspaces.push(target);
  }

  restoreWorkspaceState(target, statusMessage, { preserveView: target.hasView });
  rememberWorkspaceRecent({ rootPath, workspaceName }, previousRootPath);
  void queueDatePersistence({ workspaceId: target.id, notesPath: target.notesPath });
}

function initializeWorkspaceDates(target, nativeWorkspace) {
  target.datesError = nativeWorkspace.datesError || "";
  target.dateSaveError = "";
  target.dateTrackingErrors = {};
  target.dateCapacityError = "";
  target.noteFileTimes = Object.fromEntries((nativeWorkspace.notes || []).map((file) => [file.path, { createdMs: file.createdMs, modifiedMs: file.modifiedMs }]));
  let stored = emptyDateDocument();
  try {
    stored = normalizeDateDocument(nativeWorkspace.dates || stored);
  } catch (error) {
    target.datesError = String(error?.message || error);
  }
  target.persistedDates = stored;
  if ((nativeWorkspace.notes || []).length > 20_000) {
    target.dates = emptyDateDocument();
    target.dateCapacityError = "Date tracking paused: workspace exceeds 20,000 notes. Reopen after reducing its size.";
    return;
  }
  const notes = {};
  let totalLines = 0;
  for (const file of nativeWorkspace.notes || []) {
    target.noteFileTimes[file.path] = { createdMs: file.createdMs, modifiedMs: file.modifiedMs };
    const body = parseNote(file.path, file.raw).body;
    try {
      const noteDates = stored.notes[file.path]
        ? reconcileNoteDates(body, stored.notes[file.path], { day: dayFromTimestamp(file.modifiedMs), estimated: true })
        : seedNoteDates(body, file);
      totalLines += noteDates.lines.length;
      if (totalLines > 200_000) {
        target.dates = emptyDateDocument();
        target.dateCapacityError = "Date tracking paused: workspace exceeds 200,000 tracked lines. Reopen after reducing its size.";
        return;
      }
      notes[file.path] = noteDates;
    } catch (error) {
      target.dateTrackingErrors[file.path] = `Date tracking unavailable: ${error?.message || error}`;
      target.dateCapacityError = `Date tracking paused: ${error?.message || error} Existing date metadata is preserved. Reopen after reducing the note size.`;
      target.dates = emptyDateDocument();
      return;
    }
  }
  setWorkspaceDates(target, { version: 1, notes });
}

function setWorkspaceDates(workspace, dates) {
  if (!workspace.dateCapacityError) {
    try { normalizeDateDocument(dates); }
    catch (error) { workspace.dateCapacityError = `Date tracking paused: ${error?.message || error} Reopen after reducing its size.`; }
  }
  workspace.dates = workspace.dateCapacityError ? emptyDateDocument() : dates;
  if (workspace.id === state.activeWorkspaceId) {
    state.dates = workspace.dates;
    if (workspace.dateCapacityError && state.editorView) {
      state.editorView.dispatch({ effects: setNoteDates.of(null), annotations: Transaction.addToHistory.of(false) });
    }
  }
}

function dateMetadataBudget(notes) {
  return { notes: Object.keys(notes).length, lines: Object.values(notes).reduce((sum, note) => sum + note.lines.length, 0) };
}

function assignBoundedNoteDates(workspace, notes, path, next, budget) {
  const noteCount = budget.notes + (Object.hasOwn(notes, path) ? 0 : 1);
  const lineCount = budget.lines - (notes[path]?.lines.length || 0) + next.lines.length;
  if (noteCount > 20_000 || lineCount > 200_000) {
    workspace.dateCapacityError = "Date tracking paused: workspace exceeds 20,000 notes or 200,000 tracked lines. Existing date metadata is preserved. Reopen after reducing its size.";
    return;
  }
  notes[path] = next;
  budget.notes = noteCount;
  budget.lines = lineCount;
}

function queueWorkspaceDateTask(context, action) {
  const previous = dateWriteTailsByWorkspace.get(context.workspaceId) || Promise.resolve();
  const task = previous.catch(() => undefined).then(action);
  dateWriteTailsByWorkspace.set(context.workspaceId, task);
  void task.finally(() => {
    if (dateWriteTailsByWorkspace.get(context.workspaceId) === task) dateWriteTailsByWorkspace.delete(context.workspaceId);
  }).catch(() => undefined);
  return task;
}

async function persistWorkspaceDates(context) {
  const workspace = state.workspaces.find((item) => item.id === context.workspaceId);
  if (!workspace || workspace.notesPath !== context.notesPath || workspace.datesError || workspace.dateCapacityError) return;
  try {
    const dates = normalizeDateDocument(workspace.dates || emptyDateDocument());
    if (JSON.stringify(dates) !== JSON.stringify(workspace.persistedDates)) {
      await nativeInvoke("write_dates", { notesPath: context.notesPath, dates });
      workspace.persistedDates = dates;
    }
    workspace.dateSaveError = "";
  } catch (error) {
    workspace.dateSaveError = `Dates could not be saved. Your Markdown is safe. ${error?.message || error}`;
  }
  if (workspace.id === state.activeWorkspaceId) renderNoteDates();
}

function queueDatePersistence(context = captureWorkspaceContext()) {
  if (!context.workspaceId || !context.notesPath) return Promise.resolve();
  return queueWorkspaceDateTask(context, () => persistWorkspaceDates(context));
}

// Keep Markdown writes and their date sidecar in one per-workspace queue. Capture
// the originating workspace and editor metadata before any asynchronous work.
async function invokeNative(command, args = {}) {
  if (!["write_note", "create_note", "create_notes", "trash_notes"].includes(command)) return nativeInvoke(command, args);
  const workspace = state.workspaces.find((item) => item.notesPath === args.notesPath);
  if (!workspace) return nativeInvoke(command, args);
  const context = { workspaceId: workspace.id, notesPath: args.notesPath };
  const day = localDay();
  const writes = command === "create_notes" ? args.notes : (command === "trash_notes" ? [] : [{ path: args.path, raw: args.raw }]);
  const capturedEditorDates = workspace.id === state.activeWorkspaceId && state.editorView &&
    writes.some((write) => write.path === state.selectedPath && parseNote(write.path, write.raw).body === parseNote(write.path, composeRaw({}, getEditorBody(), { title: "" })).body)
    ? { path: state.selectedPath, dates: getEditorNoteDates(state.editorView.state) }
    : null;
  return queueWorkspaceDateTask(context, async () => {
    if (workspace.notesPath !== context.notesPath) throw new Error("Folder changed before note save");
    const result = await nativeInvoke(command, args);
    const notes = { ...(workspace.dates?.notes || {}) };
    const dateBudget = dateMetadataBudget(notes);
    for (const write of writes) {
      const body = parseNote(write.path, write.raw).body;
      try {
        const editorDates = capturedEditorDates?.path === write.path ? capturedEditorDates.dates : null;
        if (!workspace.dateCapacityError) {
          const nextDates = editorDates
            ? reconcileNoteDates(body, editorDates, { day, estimated: false })
            : notes[write.path]
              ? reconcileNoteDates(body, notes[write.path], { day, estimated: false })
              : seedNoteDates(body, { isNew: true, day });
          assignBoundedNoteDates(workspace, notes, write.path, nextDates, dateBudget);
        }
        if (workspace.dateTrackingErrors) delete workspace.dateTrackingErrors[write.path];
      } catch (error) {
        workspace.dateTrackingErrors ||= {};
        workspace.dateTrackingErrors[write.path] = `Date tracking unavailable: ${error?.message || error}`;
      }
      const previousTimes = workspace.noteFileTimes?.[write.path] || {};
      workspace.noteFileTimes ||= {};
      const unchanged = workspace.notes?.find((note) => note.path === write.path)?.raw === write.raw;
      workspace.noteFileTimes[write.path] = { createdMs: previousTimes.createdMs || Date.now(), modifiedMs: unchanged ? previousTimes.modifiedMs : Date.now() };
    }
    for (const path of command === "trash_notes" ? args.paths : []) {
      delete notes[path];
      delete workspace.noteFileTimes?.[path];
    }
    setWorkspaceDates(workspace, { version: 1, notes });
    if (workspace.id === state.activeWorkspaceId) state.noteFileTimes = workspace.noteFileTimes;
    await persistWorkspaceDates(context);
    return result;
  });
}

function renderNoteDates(note = getSelectedNote()) {
  if (!els.noteDates) return;
  els.noteDates.hidden = !note;
  els.noteDatesWarning.hidden = true;
  if (!note) { els.noteDates.textContent = ""; return; }
  const dates = state.dates?.notes?.[note.path];
  const created = dates?.created || { day: null, estimated: true };
  const modified = { day: dayFromTimestamp(state.noteFileTimes?.[note.path]?.modifiedMs), estimated: false };
  els.noteDates.textContent = `Created ${formatDateStamp(created)} · Last edited ${formatDateStamp(modified)}`;
  els.noteDates.title = `${created.estimated ? "Creation date is estimated from available file history. " : ""}Line dates retain their recorded calendar day. Last edited is the file modification date in this device's local timezone.`;
  const warning = state.datesError || getActiveWorkspace()?.dateCapacityError || getActiveWorkspace()?.dateTrackingErrors?.[note.path] || getActiveWorkspace()?.dateSaveError;
  if (warning) {
    els.noteDatesWarning.textContent = `Date metadata: ${warning}`;
    els.noteDatesWarning.hidden = false;
  }
}

function buildWorkspaceMetricsFromFiles(files = []) {
  const metrics = emptyWorkspaceMetrics();
  for (const file of files || []) {
    const raw = String(file?.raw || "");
    const byteLen = Number(file?.byteLen);
    addWorkspaceMetric(metrics, Number.isFinite(byteLen) ? byteLen : approximateRawBytes(raw), raw.length);
  }
  return finalizeWorkspaceMetrics(metrics);
}

function buildWorkspaceMetricsFromParsedNotes(notes = []) {
  const metrics = emptyWorkspaceMetrics();
  for (const note of notes || []) {
    const raw = String(note?.raw || "");
    addWorkspaceMetric(metrics, approximateRawBytes(raw), raw.length);
  }
  return finalizeWorkspaceMetrics(metrics);
}

function emptyWorkspaceMetrics() {
  return {
    noteCount: 0,
    totalBytes: 0,
    totalChars: 0,
    largestNoteBytes: 0,
    largeNoteCount: 0
  };
}

function addWorkspaceMetric(metrics, bytes, chars) {
  const byteCount = Math.max(0, Math.floor(Number(bytes) || 0));
  metrics.noteCount += 1;
  metrics.totalBytes += byteCount;
  metrics.totalChars += Math.max(0, Math.floor(Number(chars) || 0));
  metrics.largestNoteBytes = Math.max(metrics.largestNoteBytes, byteCount);
  if (byteCount >= LARGE_NOTE_BYTE_WARNING_THRESHOLD) {
    metrics.largeNoteCount += 1;
  }
}

function finalizeWorkspaceMetrics(metrics) {
  return {
    ...metrics,
    pressure: isWorkspaceUnderMemoryPressure(metrics)
  };
}

function approximateRawBytes(raw) {
  return workspaceMetricEncoder.encode(String(raw || "")).byteLength;
}

function isWorkspaceUnderMemoryPressure(metrics) {
  return Boolean(
    metrics &&
    (
      metrics.noteCount >= LARGE_FOLDER_NOTE_WARNING_THRESHOLD ||
      metrics.totalBytes >= SEARCH_BODY_TOTAL_BYTES_THRESHOLD ||
      metrics.totalChars >= SEARCH_TRIGRAM_TOTAL_CHARS_THRESHOLD ||
      metrics.totalBytes >= LARGE_FOLDER_TOTAL_BYTES_WARNING_THRESHOLD ||
      metrics.largeNoteCount > 0
    )
  );
}

function searchIndexOptionsForMetrics(metrics) {
  const noteCount = Number(metrics?.noteCount) || 0;
  const totalBytes = Number(metrics?.totalBytes) || 0;
  const totalChars = Number(metrics?.totalChars) || 0;
  const largeNoteCount = Number(metrics?.largeNoteCount) || 0;
  const includeBody =
    largeNoteCount === 0 &&
    noteCount <= SEARCH_BODY_NOTE_THRESHOLD &&
    totalBytes <= SEARCH_BODY_TOTAL_BYTES_THRESHOLD;
  const includeTrigrams =
    includeBody &&
    totalChars <= SEARCH_TRIGRAM_TOTAL_CHARS_THRESHOLD;

  return {
    includeBody,
    includeTrigrams
  };
}

function searchIndexModeForMetrics(metrics) {
  const options = searchIndexOptionsForMetrics(metrics);
  if (options.includeBody && options.includeTrigrams) return "full";
  if (options.includeBody) return "no-trigrams";
  return "title-path";
}

function workspacePressureStatus(baseMessage = "") {
  const metrics = state.workspaceMetrics;
  if (!metrics || !metrics.pressure) return baseMessage;

  const parts = [];
  if (metrics.noteCount >= LARGE_FOLDER_NOTE_WARNING_THRESHOLD) {
    parts.push(`${metrics.noteCount} notes`);
  }
  if (metrics.totalBytes >= SEARCH_BODY_TOTAL_BYTES_THRESHOLD) {
    parts.push(`${formatBytes(metrics.totalBytes)} loaded`);
  }
  if (metrics.totalChars >= SEARCH_TRIGRAM_TOTAL_CHARS_THRESHOLD && metrics.totalBytes < SEARCH_BODY_TOTAL_BYTES_THRESHOLD) {
    parts.push(`${metrics.totalChars.toLocaleString()} characters indexed`);
  }
  if (metrics.largeNoteCount) {
    parts.push(`${metrics.largeNoteCount} large note${metrics.largeNoteCount === 1 ? "" : "s"}`);
  }

  const suffix = state.searchIndexMode === "full"
    ? `Large folder: ${parts.join(", ")}`
    : `Large folder: ${parts.join(", ")}; ${searchIndexModeLabel(state.searchIndexMode)}`;
  return baseMessage ? `${baseMessage}. ${suffix}` : suffix;
}

function searchIndexModeLabel(mode) {
  if (mode === "title-path") return "search reduced to titles and paths";
  if (mode === "no-trigrams") return "fuzzy search reduced";
  return "full search enabled";
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function hasWritableWorkspace() {
  return state.source === "folder" && Boolean(state.notesPath);
}

function hasEmptyWritableWorkspace() {
  return hasWritableWorkspace() && state.notes.length === 0;
}

function snapshotWorkspaceForHistory() {
  if (!hasWritableWorkspace() || !state.activeWorkspaceId) return null;
  return {
    workspaceId: state.activeWorkspaceId,
    notes: state.notes
      .map((note) => ({ path: note.path, raw: note.raw }))
      .sort((a, b) => compareText(a.path, b.path)),
    positions: cloneHistoryPositions(state.manualPositions),
    annotations: cloneAnnotationDocument(state.annotations),
    dates: state.dates,
    selectedPath: state.selectedPath,
    selectedPaths: [...state.selectedPaths].filter((path) => state.notePaths.has(path)),
    view: { ...state.view }
  };
}

function cloneHistoryPositions(positions) {
  const next = {};
  for (const [path, position] of Object.entries(positions || {})) {
    const cloned = cloneHistoryPosition(position);
    if (cloned) next[path] = cloned;
  }
  return next;
}

function cloneHistoryPosition(position) {
  if (!position || typeof position !== "object") return null;
  if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
    return {
      x: round(position.x),
      y: round(position.y)
    };
  }
  if (Number.isFinite(position.dx) || Number.isFinite(position.dy)) {
    return {
      dx: round(Number(position.dx) || 0),
      dy: round(Number(position.dy) || 0)
    };
  }
  return null;
}

function recordWorkspaceHistory(label, before, after = snapshotWorkspaceForHistory()) {
  if (state.historyApplying) return;
  const entry = buildWorkspaceHistoryEntry(label, before, after);
  if (!entry) return;

  state.undoStack.push(entry);
  state.undoStack = trimWorkspaceHistoryStack(state.undoStack, workspaceHistoryBudgetOptions());
  state.redoStack = [];
  saveActiveWorkspaceState();
}

function workspaceHistoryBudgetOptions() {
  return {
    maxEntries: MAX_WORKSPACE_HISTORY_ENTRIES,
    maxBytes: MAX_WORKSPACE_HISTORY_BYTES
  };
}

function trimCurrentWorkspaceHistory() {
  const trimmed = trimWorkspaceHistoryStacks(
    {
      undoStack: state.undoStack,
      redoStack: state.redoStack
    },
    workspaceHistoryBudgetOptions()
  );
  state.undoStack = trimmed.undoStack;
  state.redoStack = trimmed.redoStack;
}

function buildWorkspaceHistoryEntry(label, before, after) {
  if (!before || !after || before.workspaceId !== after.workspaceId) return null;

  const beforeNotes = noteRawMap(before.notes);
  const afterNotes = noteRawMap(after.notes);
  const notePaths = new Set([...beforeNotes.keys(), ...afterNotes.keys()]);
  const notes = [];
  for (const path of [...notePaths].sort(compareText)) {
    const beforeRaw = beforeNotes.has(path) ? beforeNotes.get(path) : null;
    const afterRaw = afterNotes.has(path) ? afterNotes.get(path) : null;
    const beforeDates = before.dates?.notes?.[path] || null;
    const afterDates = after.dates?.notes?.[path] || null;
    if (beforeRaw !== afterRaw || JSON.stringify(beforeDates) !== JSON.stringify(afterDates)) {
      notes.push({ path, beforeRaw, afterRaw, beforeDates, afterDates });
    }
  }

  const beforePositions = positionMap(before.positions);
  const afterPositions = positionMap(after.positions);
  const positionPaths = new Set([...beforePositions.keys(), ...afterPositions.keys()]);
  const positions = [];
  for (const path of [...positionPaths].sort(compareText)) {
    const beforePosition = beforePositions.get(path) || null;
    const afterPosition = afterPositions.get(path) || null;
    if (!sameHistoryPosition(beforePosition, afterPosition)) {
      positions.push({ path, beforePosition, afterPosition });
    }
  }

  const annotationsChanged = JSON.stringify(before.annotations) !== JSON.stringify(after.annotations);
  if (!notes.length && !positions.length && !annotationsChanged) return null;
  return {
    label,
    workspaceId: before.workspaceId,
    notes,
    positions,
    beforeAnnotations: annotationsChanged ? before.annotations : null,
    afterAnnotations: annotationsChanged ? after.annotations : null,
    beforeSelection: {
      selectedPath: before.selectedPath,
      selectedPaths: before.selectedPaths || [],
      view: before.view || null
    },
    afterSelection: {
      selectedPath: after.selectedPath,
      selectedPaths: after.selectedPaths || [],
      view: after.view || null
    }
  };
}

function noteRawMap(notes) {
  return new Map((notes || []).map((note) => [note.path, note.raw]));
}

function positionMap(positions) {
  const map = new Map();
  for (const [path, position] of Object.entries(positions || {})) {
    const cloned = cloneHistoryPosition(position);
    if (cloned) map.set(path, cloned);
  }
  return map;
}

function sameHistoryPosition(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function clearWorkspaceHistory() {
  state.undoStack = [];
  state.redoStack = [];
  saveActiveWorkspaceState();
}

async function undoWorkspaceHistory() {
  return stepWorkspaceHistory("undo");
}

async function redoWorkspaceHistory() {
  return stepWorkspaceHistory("redo");
}

async function stepWorkspaceHistory(direction) {
  if (isAnnotationTransitionLocked()) {
    setStatus("Wait for the folder transition before undoing or redoing");
    return false;
  }
  if (!hasWritableWorkspace()) {
    setStatus(direction === "undo" ? "Open a folder to undo changes" : "Open a folder to redo changes");
    return false;
  }

  if (state.historyApplying) return false;
  const workspaceId = state.activeWorkspaceId;
  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
  }
  await awaitPendingAnnotationWrites(workspaceId);
  if (workspaceId !== state.activeWorkspaceId) return false;
  if (isAnnotationTransitionLocked(workspaceId)) {
    setStatus("Wait for the folder transition before undoing or redoing");
    return false;
  }
  if (state.historyApplying) return false;

  const undo = direction === "undo";
  const fromStack = undo ? state.undoStack : state.redoStack;
  const toStack = undo ? state.redoStack : state.undoStack;
  const entry = fromStack[fromStack.length - 1];
  if (!entry) {
    setStatus(undo ? "Nothing to undo" : "Nothing to redo");
    return false;
  }

  if (entry.workspaceId !== state.activeWorkspaceId) {
    clearWorkspaceHistory();
    setStatus("Undo history reset after switching folders");
    return false;
  }

  state.historyApplying = true;
  stopLiveSync();
  try {
    await applyWorkspaceHistoryEntry(entry, undo ? "before" : "after");
    fromStack.pop();
    toStack.push(entry);
    trimCurrentWorkspaceHistory();
    setStatus(`${undo ? "Undid" : "Redid"} ${entry.label}`);
    saveActiveWorkspaceState();
    return true;
  } catch (error) {
    setStatus(undo ? "Could not undo change" : "Could not redo change");
    console.error(error);
    return false;
  } finally {
    state.historyApplying = false;
    startLiveSync();
  }
}

async function applyWorkspaceHistoryEntry(entry, side) {
  const workspaceContext = captureWorkspaceContext();
  const selection = side === "before" ? entry.beforeSelection : entry.afterSelection;
  const noteChanges = entry.notes || [];
  const positionChanges = entry.positions || [];
  const pathsToTrash = [];
  const annotations = side === "before" ? entry.beforeAnnotations : entry.afterAnnotations;

  if (annotations) {
    await enqueueAnnotationWrite(workspaceContext, annotations);
    requireCurrentWorkspaceContext(workspaceContext);
    state.annotations = cloneAnnotationDocument(annotations);
    state.selectedAnnotationId = null;
  }

  for (const change of noteChanges) {
    const raw = side === "before" ? change.beforeRaw : change.afterRaw;
    if (raw === null || raw === undefined) {
      if (state.byPath.has(change.path)) pathsToTrash.push(change.path);
      continue;
    }
    await invokeNative("write_note", {
      notesPath: workspaceContext.notesPath,
      path: change.path,
      raw
    });
    requireCurrentWorkspaceContext(workspaceContext);
  }

  if (pathsToTrash.length) {
    await invokeNative("trash_notes", {
      notesPath: workspaceContext.notesPath,
      paths: pathsToTrash
    });
    requireCurrentWorkspaceContext(workspaceContext);
  }

  if (noteChanges.length) {
    const dates = { ...(state.dates?.notes || {}) };
    for (const change of noteChanges) {
      const restored = side === "before" ? change.beforeDates : change.afterDates;
      if (restored) dates[change.path] = restored;
      else delete dates[change.path];
    }
    setWorkspaceDates(getActiveWorkspace(), { version: 1, notes: dates });
    await queueDatePersistence(workspaceContext);
    requireCurrentWorkspaceContext(workspaceContext);
  }

  const nextNotes = new Map(state.notes.map((note) => [note.path, note]));
  for (const change of noteChanges) {
    const raw = side === "before" ? change.beforeRaw : change.afterRaw;
    if (raw === null || raw === undefined) {
      nextNotes.delete(change.path);
    } else {
      nextNotes.set(change.path, parseNote(change.path, raw));
    }
  }
  state.notes = [...nextNotes.values()].sort((a, b) => compareText(a.path, b.path));

  for (const change of positionChanges) {
    const position = side === "before" ? change.beforePosition : change.afterPosition;
    if (position) {
      state.manualPositions[change.path] = cloneHistoryPosition(position);
    } else {
      delete state.manualPositions[change.path];
    }
  }

  state.selectedPath = selection?.selectedPath || null;
  state.selectedPaths = new Set(selection?.selectedPaths || []);
  if (selection?.view) {
    state.view = { ...selection.view };
  }
  state.dirty = false;
  state.saveToken += 1;
  rebuildIndex();
  state.validation = validateNotes();
  state.manualPositions = pruneStoredPositions(state.manualPositions);
  normalizeSelectionAfterNotesChanged();

  await updateManifestFile();
  if (positionChanges.length) {
    const patch = {};
    for (const change of positionChanges) {
      patch[change.path] = side === "before"
        ? cloneHistoryPosition(change.beforePosition)
        : cloneHistoryPosition(change.afterPosition);
    }
    await savePositionPatch(patch);
  }

  renderCurrentSelection("");
  renderNewNoteParents();
  renderGraph({ preserveView: true });
  updateSourceStatus();
  renderValidationStatus();
}

function buildLayoutKey(source, rootPath, workspaceName) {
  return `${STORAGE_PREFIX}:${source}:${rootPath || workspaceName || "workspace"}`;
}

function getActiveWorkspace() {
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) || null;
}

function saveActiveWorkspaceState() {
  const workspace = getActiveWorkspace();
  if (!workspace) return;

  trimCurrentWorkspaceHistory();
  workspace.notes = state.notes;
  workspace.selectedPath = state.selectedPath;
  workspace.selectedPaths = [...state.selectedPaths].filter((path) => state.notePaths.has(path));
  workspace.rootPath = state.rootPath;
  workspace.notesPath = state.notesPath;
  workspace.source = state.source;
  workspace.workspaceName = state.workspaceName;
  workspace.workspaceMetrics = state.workspaceMetrics;
  workspace.searchIndexMode = state.searchIndexMode;
  workspace.dirty = state.dirty;
  workspace.undoStack = state.undoStack;
  workspace.redoStack = state.redoStack;
  workspace.fileSignatures = cloneFileSignatures(state.fileSignatures);
  workspace.filter = state.filter;
  workspace.layoutKey = state.layoutKey;
  workspace.manualPositions = pruneStoredPositions(state.manualPositions);
  workspace.graphHasHierarchy = state.graphHasHierarchy;
  workspace.hierarchyPromptShown = state.hierarchyPromptShown;
  workspace.hierarchyPromptText = state.hierarchyPromptText;
  workspace.view = { ...state.view };
  workspace.annotations = cloneAnnotationDocument(state.annotations);
  workspace.annotationsError = state.annotationsError;
  workspace.dates = state.dates;
  workspace.datesError = state.datesError;
  workspace.noteFileTimes = state.noteFileTimes;
  workspace.hasView = true;
}

function restoreWorkspaceState(workspace, statusMessage, { preserveView } = { preserveView: true }) {
  prepareAnnotationTransition();
  stopLiveSync();
  closeGraphProjectLauncher();
  closeGraphCreatePopover();
  cancelQueuedGraphRender();
  cancelGraphViewAnimation();
  cancelLabelVisibilityRefresh();
  cancelQueuedInteraction();
  clearResizeDebounceTimer();
  clearLargeGraphRefreshTimer();
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }

  state.activeWorkspaceId = workspace.id;
  state.notes = workspace.notes || [];
  state.annotations = cloneAnnotationDocument(workspace.annotations || emptyAnnotationDocument());
  state.annotationsError = workspace.annotationsError || "";
  state.dates = workspace.dates || emptyDateDocument();
  state.datesError = workspace.datesError || "";
  state.noteFileTimes = workspace.noteFileTimes || {};
  state.annotationTool = "select";
  state.selectedAnnotationId = null;
  state.graphIndex = null;
  state.searchIndex = null;
  state.selectedPath = workspace.selectedPath || null;
  state.selectedPaths = new Set(workspace.selectedPaths || []);
  state.rootPath = workspace.rootPath || "";
  state.notesPath = workspace.notesPath || "";
  state.source = workspace.source || "folder";
  state.workspaceName = workspace.workspaceName || workspace.rootPath || "Folder";
  state.workspaceMetrics = workspace.workspaceMetrics || buildWorkspaceMetricsFromParsedNotes(state.notes);
  state.searchIndexMode = workspace.searchIndexMode || searchIndexModeForMetrics(state.workspaceMetrics);
  state.dirty = Boolean(workspace.dirty);
  state.saveToken += 1;
  state.undoStack = workspace.undoStack || [];
  state.redoStack = workspace.redoStack || [];
  trimCurrentWorkspaceHistory();
  state.historyApplying = false;
  state.fileSignatures = cloneFileSignatures(workspace.fileSignatures);
  state.filter = workspace.filter || "";
  state.searchResults = [];
  state.searchOpen = false;
  state.searchActiveIndex = -1;
  state.layoutKey = workspace.layoutKey || buildLayoutKey(state.source, state.rootPath, state.workspaceName);
  state.manualPositions = pruneStoredPositions(
    workspace.manualPositions,
    new Set(state.notes.map((note) => note.path))
  );
  state.graphHasHierarchy = workspace.graphHasHierarchy !== false;
  state.hierarchyPromptShown = Boolean(workspace.hierarchyPromptShown);
  state.hierarchyPromptText = workspace.hierarchyPromptText || "";
  state.view = workspace.view ? { ...workspace.view } : { x: 0, y: 0, scale: 1 };
  state.pendingCreatePoint = null;
  state.activeInteraction = null;
  state.hoveredPath = null;
  state.focusedPath = null;
  state.lastNodePointerDown = null;
  state.suppressGraphCreateUntil = 0;
  state.armedRope = null;
  state.autoPositions = new Map();
  state.positions = new Map();
  state.nodeSizes = new Map();
  state.nodeElements = new Map();
  state.edgeElements = [];
  state.edgeElementsByPath = new Map();
  state.spatialIndex = null;
  state.referenceEdges = [];
  state.referenceEdgeCount = 0;
  state.largeGraphMode = false;
  state.labelStats = new Map();
  state.labelVisibilityCache = null;
  state.labelVisibility = null;
  state.labelVisibilityKey = "";
  state.renamingWorkspaceId = null;
  state.workspaceRenameDraft = "";

  rebuildIndex();
  state.validation = validateNotes();
  normalizeSelectionAfterNotesChanged();

  els.searchInput.value = state.filter;
  updateSearchResults();
  renderSearchResults();
  const annotationStatus = state.annotationsError
    ? `${statusMessage}. Canvas annotations unavailable: ${state.annotationsError}`
    : (workspace.annotationSaveError ? `${statusMessage}. ${workspace.annotationSaveError}` : statusMessage);
  renderCurrentSelection(workspacePressureStatus(annotationStatus));
  renderNewNoteParents();
  renderLaunchScreen();
  renderGraph({ preserveView });
  updateSourceStatus();
  maybeShowHierarchyPrompt();
  renderValidationStatus();
  workspace.selectedPath = state.selectedPath;
  workspace.selectedPaths = [...state.selectedPaths];
  workspace.view = { ...state.view };
  workspace.hasView = true;
  workspace.fileSignatures = cloneFileSignatures(state.fileSignatures);
  renderWorkspaceTabs();
  startLiveSync();
}

async function switchWorkspaceTab(workspaceId) {
  if (!workspaceId || workspaceId === state.activeWorkspaceId) return;
  if (state.historyApplying) return;

  prepareAnnotationTransition();

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  saveActiveWorkspaceState();
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return;
  restoreWorkspaceState(workspace, "Folder tab loaded", { preserveView: true });
}

async function closeWorkspaceTab(workspaceId) {
  const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (index === -1) return;
  if (workspaceId === state.activeWorkspaceId && state.historyApplying) return;

  const transitionLock = beginAnnotationTransitionLock(workspaceId);
  if (!transitionLock) {
    setStatus("Folder transition already in progress");
    return;
  }
  try {
    await awaitPendingAnnotationWrites(workspaceId);

    if (workspaceId === state.activeWorkspaceId && state.dirty) {
      await flushAutosave();
      if (state.dirty) return;
    }
    await awaitPendingAnnotationWrites(workspaceId);

    saveActiveWorkspaceState();
    const currentIndex = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (currentIndex === -1) return;
    state.workspaces.splice(currentIndex, 1);
    annotationWriteTailsByWorkspace.delete(workspaceId);
    pendingAnnotationWritesByWorkspace.delete(workspaceId);
    pendingAnnotationChangesByWorkspace.delete(workspaceId);
    annotationSaveTokensByWorkspace.delete(workspaceId);
    persistedAnnotationDocumentsByWorkspace.delete(workspaceId);
    deferredAnnotationHistoryByWorkspace.delete(workspaceId);

    if (workspaceId !== state.activeWorkspaceId) {
      renderWorkspaceTabs();
      return;
    }

    const nextWorkspace = state.workspaces[Math.min(currentIndex, state.workspaces.length - 1)];
    if (nextWorkspace) {
      restoreWorkspaceState(nextWorkspace, "Closed folder tab", { preserveView: true });
    } else {
      startEmpty();
    }
  } finally {
    endAnnotationTransitionLock(transitionLock);
  }
}

function renderWorkspaceTabs() {
  const activeRenameInput = document.activeElement?.closest?.("[data-rename-workspace]");
  const shouldRestoreRenameFocus = Boolean(
    activeRenameInput && state.renamingWorkspaceId === activeRenameInput.dataset.renameWorkspace
  );
  if (shouldRestoreRenameFocus) {
    state.workspaceRenameDraft = activeRenameInput.value;
  }

  const fragment = document.createDocumentFragment();

  for (const workspace of state.workspaces) {
    const isActive = workspace.id === state.activeWorkspaceId;
    const isSelected = isActive && !state.graphProjectLauncherOpen;
    const isDirty = isActive ? state.dirty : workspace.dirty;
    const isRenaming = isActive && state.renamingWorkspaceId === workspace.id;
    const tab = document.createElement("div");
    tab.className = `workspaceTab${isSelected ? " active" : ""}${isRenaming ? " renaming" : ""}`;
    tab.dataset.workspaceId = workspace.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(isSelected));
    tab.title = workspace.rootPath || workspace.workspaceName || "Folder";
    const workspaceLabel = workspace.workspaceName || "Folder";

    if (isRenaming) {
      const input = document.createElement("input");
      input.className = "workspaceTabRename";
      input.type = "text";
      input.value = state.workspaceRenameDraft || workspaceLabel;
      input.dataset.renameWorkspace = workspace.id;
      input.setAttribute("aria-label", `Rename folder: ${workspaceLabel}`);
      input.autocomplete = "off";
      input.spellcheck = false;
      tab.appendChild(input);
    } else {
      const switchButton = document.createElement("button");
      switchButton.className = "workspaceTabMain";
      switchButton.type = "button";
      switchButton.dataset.switchWorkspace = workspace.id;
      switchButton.setAttribute(
        "aria-label",
        `${isActive ? "Current folder" : "Switch to folder"}: ${workspaceLabel}${isDirty ? ", unsaved changes" : ""}`
      );
      switchButton.title = `${workspaceLabel}${isDirty ? " - unsaved changes" : ""}`;

      const title = document.createElement("span");
      title.className = "workspaceTabTitle";
      title.textContent = workspaceLabel;
      switchButton.appendChild(title);

      if (isDirty) {
        const dirty = document.createElement("span");
        dirty.className = "workspaceTabDirty";
        dirty.textContent = "*";
        dirty.setAttribute("aria-label", "Unsaved changes");
        dirty.title = "Unsaved changes";
        switchButton.appendChild(dirty);
      }

      tab.appendChild(switchButton);
    }

    const closeButton = document.createElement("button");
    closeButton.className = "workspaceTabClose";
    closeButton.type = "button";
    closeButton.dataset.closeWorkspace = workspace.id;
    closeButton.setAttribute("aria-label", `Close ${workspace.workspaceName || "folder"}`);
    closeButton.title = `Close ${workspace.workspaceName || "folder"}`;
    closeButton.appendChild(createIcon("close"));

    tab.appendChild(closeButton);
    fragment.appendChild(tab);
  }

  if (state.workspaces.length && state.graphProjectLauncherOpen) {
    const tab = document.createElement("div");
    tab.className = "workspaceTab workspaceTabTransient active";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "true");
    tab.title = "Open new";

    const openButton = document.createElement("button");
    openButton.className = "workspaceTabMain";
    openButton.type = "button";
    openButton.dataset.openWorkspace = "true";
    openButton.setAttribute("aria-label", "Open new project");
    openButton.title = "Open new project";

    const title = document.createElement("span");
    title.className = "workspaceTabTitle";
    title.textContent = "Open new";
    openButton.appendChild(title);
    tab.appendChild(openButton);

    const closeButton = document.createElement("button");
    closeButton.className = "workspaceTabClose";
    closeButton.type = "button";
    closeButton.dataset.closeProjectChooser = "true";
    closeButton.setAttribute("aria-label", "Close open new tab");
    closeButton.title = "Close open new tab";
    closeButton.appendChild(createIcon("close"));
    tab.appendChild(closeButton);

    fragment.appendChild(tab);
  } else if (state.workspaces.length) {
    const addButton = document.createElement("button");
    addButton.className = "workspaceTabAdd";
    addButton.type = "button";
    addButton.dataset.openWorkspace = "true";
    addButton.setAttribute("aria-label", "Open another notes folder");
    addButton.title = "Open another notes folder";
    addButton.appendChild(createIcon("openProject"));
    fragment.appendChild(addButton);
  }

  suppressWorkspaceRenameCommit = true;
  try {
    els.workspaceTabs.replaceChildren(fragment);
  } finally {
    suppressWorkspaceRenameCommit = false;
  }

  if (shouldRestoreRenameFocus) {
    const input = els.workspaceTabs.querySelector("[data-rename-workspace]");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function rememberWorkspaceRecent(workspace, previousRootPath) {
  if (previousRootPath && previousRootPath !== workspace.rootPath) {
    state.recentProjects = removeRecentProject(previousRootPath, state.recentProjects);
  }

  state.recentProjects = rememberRecentProject(
    {
      rootPath: workspace.rootPath,
      name: workspace.workspaceName
    },
    state.recentProjects
  );
  saveRecentProjects(state.recentProjects);
  renderLaunchScreen();
  void rememberNativeRecentProject(workspace, previousRootPath);
}

async function rememberNativeRecentProject(workspace, previousRootPath) {
  if (!isTauriApp() || !workspace.rootPath) return;

  try {
    if (previousRootPath && previousRootPath !== workspace.rootPath) {
      await invokeNative("forget_recent_project", { rootPath: previousRootPath });
    }
    state.recentProjects = normalizeRecentProjects(await invokeNative("remember_recent_project", {
      rootPath: workspace.rootPath,
      name: workspace.workspaceName
    }));
    saveRecentProjects(state.recentProjects);
    renderLaunchScreen();
  } catch (error) {
    console.error(error);
  }
}

async function forgetNativeRecentProject(rootPath) {
  if (!isTauriApp() || !rootPath) return;

  try {
    state.recentProjects = normalizeRecentProjects(await invokeNative("forget_recent_project", { rootPath }));
    saveRecentProjects(state.recentProjects);
    renderLaunchScreen();
  } catch (error) {
    console.error(error);
  }
}

function renderLaunchScreen() {
  const isLaunchVisible = state.source !== "folder";
  document.body.classList.toggle("noWorkspace", isLaunchVisible);
  els.launchScreen.setAttribute("aria-hidden", String(!isLaunchVisible));
  renderProjectList(els.launchRecentList, state.recentProjects);
  els.launchRecentEmpty.hidden = Boolean(state.recentProjects.length);
  renderGraphProjectLauncher();
}

function renderGraphProjectLauncher() {
  const isVisible = hasWritableWorkspace() && state.graphProjectLauncherOpen;
  document.body.classList.toggle("projectChooserOpen", isVisible);
  els.graphPane.classList.toggle("projectLauncherOpen", isVisible);
  els.graphProjectLauncher.hidden = !isVisible;
  els.graphProjectLauncher.setAttribute("aria-hidden", String(!isVisible));
  els.graph.setAttribute("aria-hidden", String(isVisible));
  if (isVisible) {
    renderProjectList(els.graphRecentList, state.recentProjects);
    els.graphRecentEmpty.hidden = Boolean(state.recentProjects.length);
  }
}

function renderProjectList(listElement, projects) {
  const fragment = document.createDocumentFragment();
  for (const project of projects) {
    const button = document.createElement("button");
    button.className = "recentProjectButton";
    button.type = "button";
    button.dataset.recentRootPath = project.rootPath;
    button.title = project.rootPath;
    button.setAttribute("aria-label", `Open ${project.name}`);

    const name = document.createElement("span");
    name.className = "recentProjectName";
    name.textContent = project.name;

    const location = document.createElement("span");
    location.className = "recentProjectLocation";
    location.textContent = projectLocationFromPath(project.rootPath);

    const icon = document.createElement("span");
    icon.className = "recentProjectIcon";
    icon.appendChild(createIcon("openProject"));

    const text = document.createElement("span");
    text.className = "recentProjectText";
    text.append(name, location);

    button.append(icon, text);
    fragment.appendChild(button);
  }

  listElement.replaceChildren(fragment);
}

function rebuildIndex() {
  state.byPath = new Map();
  state.byKey = new Map();
  state.notePaths = new Set();

  for (const note of state.notes) {
    state.byPath.set(note.path, note);
    state.notePaths.add(note.path);
  }

  state.workspaceMetrics = buildWorkspaceMetricsFromParsedNotes(state.notes);
  state.searchIndexMode = searchIndexModeForMetrics(state.workspaceMetrics);
  state.graphIndex = createGraphIndex(state.notes);
  applyGraphIndexToNotes(state.graphIndex);
  rebuildAliasLookup(state.graphIndex);

  for (const note of state.notes) {
    note.bodyRefNotes = note.bodyRefs
      .map((ref) => ({
        ...ref,
        note: resolveWikiNote(ref.ref)
      }))
      .filter((ref) => ref.note);
  }

  state.sortedNotes = [...state.notes].sort(compareGraphNotes);
  state.sortedParentOptions = [...state.notes].sort(compareParentOptions);
  state.graphHasHierarchy = isHierarchyComplete(state.notes);
  state.referenceEdges = collectReferenceEdges(state.sortedNotes);
  state.referenceEdgeCount = state.referenceEdges.length;
  state.largeGraphMode = detectLargeGraphMode(
    {
      noteCount: state.sortedNotes.length,
      referenceEdgeCount: state.referenceEdgeCount
    }
  );
  state.searchIndex = createSearchIndex(
    state.notes,
    searchIndexOptionsForMetrics(state.workspaceMetrics)
  );
  updateSearchResults();
  state.labelStats = computeNoteLinkStats(state.sortedNotes);
  state.labelVisibilityCache = prepareLabelVisibilityCache(state.sortedNotes, state.labelStats);
  state.labelVisibility = null;
  state.labelVisibilityKey = "";

  refreshEditorDecorations();
}

function applyGraphIndexToNotes(graphIndex) {
  for (const note of state.notes) {
    const vertex = graphIndex && graphIndex.V.get(note.path);
    note.children = [];
    note.parentNote = null;
    note.bodyRefNotes = [];
    note.derivedLevel = vertex ? vertex.derivedLevel : null;
    if (vertex && Number.isFinite(vertex.derivedLevel)) {
      note.level = vertex.derivedLevel;
    } else {
      note.level = 4;
    }
  }

  if (!graphIndex) return;

  for (const [path, parentPath] of graphIndex.parents.entries()) {
    if (!parentPath) continue;
    const note = state.byPath.get(path);
    const parent = state.byPath.get(parentPath);
    if (!note || !parent) continue;
    note.parentNote = parent;
    parent.children.push(note);
  }
}

function rebuildAliasLookup(graphIndex) {
  state.byKey = new Map();
  if (graphIndex && graphIndex.aliases) {
    for (const [key, path] of graphIndex.aliases.entries()) {
      const note = state.byPath.get(path);
      if (note) state.byKey.set(key, note);
    }
    return;
  }

  for (const note of state.notes) {
    for (const key of note.keys) {
      if (!state.byKey.has(key)) state.byKey.set(key, note);
    }
  }
}

function isHierarchyComplete(notes) {
  if (!notes.length) return true;

	for (const note of notes) {
	  if (!note.hasFrontmatter || !note.hasTitle || !note.hasParent) {
	    return false;
	  }
	}

  if (state.graphIndex && state.graphIndex.validation.length) {
    return false;
  }

  return true;
}

function isValidApex(note) {
  if (!note || !note.hasFrontmatter || !note.hasTitle || !note.hasParent || cleanWikiRef(note.parentRef)) return false;
  if (state.graphIndex && state.graphIndex.derivedLevels.has(note.path)) {
    return state.graphIndex.derivedLevels.get(note.path) === 0;
  }
  return Boolean(note.level === 0);
}

function hasValidHierarchyEdge(note) {
  const parent = note && note.parentNote;
  if (state.graphIndex && note && parent) {
    const childLevel = state.graphIndex.derivedLevels.get(note.path);
    const parentLevel = state.graphIndex.derivedLevels.get(parent.path);
    return Number.isFinite(childLevel) && Number.isFinite(parentLevel) && parentLevel === childLevel - 1;
  }
  return Boolean(
    note &&
    parent &&
    Number.isFinite(note.level) &&
    Number.isFinite(parent.level) &&
    parent.level === note.level - 1
  );
}

function hasUsableHierarchySlot(note) {
  if (!note || !Number.isFinite(note.level)) return false;
  if (isValidApex(note)) return true;
  return hasValidHierarchyEdge(note);
}

function isLooseHierarchyNote(note) {
  return isIncompleteHierarchyNote(note) || isParentlessLooseRoot(note);
}

function isIncompleteHierarchyNote(note) {
  return Boolean(
    note &&
    (
	      !note.hasFrontmatter ||
	      !note.hasTitle ||
	      !note.hasParent ||
	      !hasUsableHierarchySlot(note)
    )
  );
}

function isParentlessLooseRoot(note) {
  return Boolean(
    note &&
    isValidApex(note) &&
    !note.parentNote &&
    !(Array.isArray(note.children) && note.children.length) &&
    countParentlessHierarchyNotes() > 1
  );
}

function countParentlessHierarchyNotes() {
  return state.notes.filter((note) => isValidParentlessHierarchyNote(note)).length;
}

function isValidParentlessHierarchyNote(note) {
  return Boolean(
	    note &&
	    note.hasFrontmatter &&
	    note.hasTitle &&
	    note.hasParent &&
	    Number.isFinite(note.level) &&
    !cleanWikiRef(note.parentRef)
  );
}

function shouldCreateHierarchyConnection(note) {
  if (!note) return false;
  if (isIncompleteHierarchyNote(note)) return true;
  if (!cleanWikiRef(note.parentRef)) {
    return countParentlessHierarchyNotes() > 1;
  }
  return false;
}

function getNodeRopeMode(note) {
  return shouldCreateHierarchyConnection(note) ? "connect" : "reference";
}

function maybeShowHierarchyPrompt() {
  if (state.hierarchyPromptShown) return;
  if (state.source !== "folder") return;
  if (state.graphHasHierarchy) return;
  if (!state.notesPath) return;
  if (!state.notes.length) return;

  state.hierarchyPromptShown = true;
  const folderPath = state.notesPath;
  openHierarchyPromptDialog(buildHierarchyAgentPrompt(folderPath));
}

function buildHierarchyAgentPrompt(folderPath) {
  return `Open ${folderPath} and apply the instructions below to build the hierarchy in this note folder.\n\n${HIERARCHY_AGENT_INSTRUCTIONS}`;
}

function openHierarchyPromptDialog(promptText) {
  state.hierarchyPromptText = promptText;

  if (typeof els.hierarchyPromptDialog.showModal === "function") {
    els.hierarchyPromptDialog.showModal();
  } else {
    els.hierarchyPromptDialog.removeAttribute("hidden");
  }
}

function closeHierarchyPromptDialog() {
  if (typeof els.hierarchyPromptDialog.close === "function") {
    els.hierarchyPromptDialog.close();
  } else {
    els.hierarchyPromptDialog.setAttribute("hidden", "");
  }
}

async function copyHierarchyPrompt() {
  const text = state.hierarchyPromptText;
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    setStatus("Prompt copied");
    return;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      setStatus(copied ? "Prompt copied" : "Could not copy prompt");
    } catch {
      setStatus("Could not copy prompt");
    }
  }
}

function resolveWikiNote(ref) {
  if (state.graphIndex) {
    const path = state.graphIndex.resolvePath(ref);
    if (path) return state.byPath.get(path) || null;
  }
  return state.byKey.get(normalizeKey(ref)) || state.byKey.get(normalizeKey(slugify(ref))) || null;
}

function validateNotes() {
  return validateNoteCollection(state.notes, state.graphIndex, state.byPath);
}

async function selectNote(path, force = false) {
  if (!path) return;
  let note = state.byPath.get(path);
  if (!note) return;

  if (state.dirty && !force) {
    await flushAutosave();
    if (state.dirty) return;
  }
  note = state.byPath.get(path);
  if (!note) return;

  clearAnnotationSelection();
  const previousSelection = new Set(state.selectedPaths);
  state.selectedPath = path;
  state.selectedPaths = new Set([path]);
  state.dirty = false;
  renderSelectedNote(state.source === "folder" ? "Note loaded" : "Read-only note");
  updateGraphSelection(previousSelection, state.selectedPaths);
  scheduleLabelVisibilityRefresh({ force: true });
  if (state.largeGraphMode) {
    requestGraphRender({ preserveView: true });
  }
  updateSourceStatus();
}

async function setGraphSelection(paths, { openSingle = false, statusMessage = "" } = {}) {
  const nextSelection = new Set(
    [...paths]
      .filter((path) => state.byPath.has(path))
  );
  clearAnnotationSelection();

  if (openSingle && nextSelection.size === 1) {
    await selectNote([...nextSelection][0]);
    return true;
  }

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
  }

  const previousSelection = new Set(state.selectedPaths);
  state.selectedPaths = nextSelection;
  state.selectedPath = null;
  updateGraphSelection(previousSelection, nextSelection);
  renderCurrentSelection(statusMessage || selectionStatus(nextSelection.size));
  scheduleLabelVisibilityRefresh({ force: true });
  scheduleLargeGraphRefresh();
  updateSourceStatus();
  return true;
}

function renderCurrentSelection(statusMessage) {
  if (state.selectedPath) {
    renderSelectedNote(statusMessage);
    return;
  }

  if (state.selectedPaths.size) {
    renderGraphSelectionSummary(statusMessage);
    return;
  }

  renderSelectedNote(statusMessage);
}

function renderGraphSelectionSummary(statusMessage) {
  const count = state.selectedPaths.size;
  els.noteTitle.textContent = `${count} note${count === 1 ? "" : "s"} selected`;
  const onlyPath = count === 1 ? [...state.selectedPaths][0] : "";
  els.notePath.textContent = onlyPath || "";
  setEditorPlaceholder(false);
  setEditorBody("");
  renderNoteDates(null);
  renderInfoPanel(null);
  setStatus(statusMessage || selectionStatus(count));
}

function selectionStatus(count) {
  if (!count) return "No notes selected";
  return `${count} note${count === 1 ? "" : "s"} selected`;
}

function getGraphSelectedNotes() {
  return [...state.selectedPaths]
    .map((path) => state.byPath.get(path))
    .filter(Boolean);
}

function getOnlyGraphSelectedNote() {
  const notes = getGraphSelectedNotes();
  return notes.length === 1 ? notes[0] : null;
}

function renderSelectedNote(statusMessage) {
  const note = getSelectedNote();
  renderNoteDates(note);

  if (!note) {
    els.noteTitle.textContent = "Select a note";
    els.notePath.textContent = "";
    setEditorPlaceholder(false);
    setEditorBody("");
    renderInfoPanel(null);
    setStatus(statusMessage || "Select a note");
    return;
  }

  els.noteTitle.textContent = note.title;
  els.notePath.textContent = note.path;
  setEditorPlaceholder(true);
  setEditorBody(note.body);
  renderInfoPanel(note);
  setStatus(statusMessage);
}

function getSelectedNote() {
  return state.byPath.get(state.selectedPath) || null;
}

function setEditorBody(body) {
  const view = state.editorView;
  const note = getSelectedNote();
  const nextKey = note ? `${state.activeWorkspaceId}:${editorHydrationEpoch}:${note.path}` : "";
  const dates = note ? state.dates?.notes?.[note.path] || null : null;
  state.editorHydrating = true;
  if (editorNoteKey === nextKey && view.state.doc.toString() === (body || "")) {
    view.dispatch({ effects: [setNoteDates.of(dates), wikiLinkRefreshEffect.of(null)], annotations: Transaction.addToHistory.of(false) });
    state.editorHydrating = false;
    return;
  }
  // Never let editor undo cross note boundaries or an external rehydrate.
  view.dispatch({ effects: editorDateHistory.reconfigure([]), annotations: Transaction.addToHistory.of(false) });
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: body || ""
    },
    effects: [wikiLinkRefreshEffect.of(null), setNoteDates.of(dates), editorDateHistory.reconfigure(history())],
    annotations: Transaction.addToHistory.of(false)
  });
  editorNoteKey = nextKey;
  state.editorHydrating = false;
}

function getEditorBody() {
  return state.editorView ? state.editorView.state.doc.toString() : "";
}

function refreshEditorDecorations() {
  if (!state.editorView) return;
  state.editorView.dispatch({ effects: wikiLinkRefreshEffect.of(null) });
}

function setEditorPlaceholder(isVisible) {
  if (!state.editorView) return;
  state.editorView.dispatch({
    effects: editorPlaceholder.reconfigure(isVisible ? placeholder(EMPTY_NOTE_PLACEHOLDER) : [])
  });
}

function renderInfoPanel(note) {
  state.infoHydrating = true;

  if (!note) {
    els.notePath.textContent = "";
    els.infoParent.innerHTML = "";
    els.deleteNoteButton.disabled = !canDeleteCurrentSelection();
    els.noteInfo.open = false;
    state.infoHydrating = false;
    return;
  }

  els.notePath.textContent = note.path;
  els.deleteNoteButton.disabled = !canDeleteCurrentSelection();
  renderInfoParents(note);
  state.infoHydrating = false;
}

function renderInfoParents(note) {
  const fragment = document.createDocumentFragment();
  const rootOption = document.createElement("option");
  rootOption.value = "";
  rootOption.textContent = "No parent (root or loose)";
  fragment.appendChild(rootOption);

  for (const parent of state.sortedParentOptions) {
    if (parent.path === note.path || isDescendant(parent, note)) continue;
    const option = document.createElement("option");
    option.value = parent.path;
    option.textContent = parentOptionLabel(parent);
    fragment.appendChild(option);
  }

  els.infoParent.replaceChildren(fragment);
  els.infoParent.value = note.parentNote ? note.parentNote.path : "";
}

function isDescendant(candidate, parent) {
  let current = candidate.parentNote;
  const seen = new Set();
  while (current) {
    if (current.path === parent.path) return true;
    if (seen.has(current.path)) return false;
    seen.add(current.path);
    current = current.parentNote;
  }
  return false;
}

function onInfoChanged() {
  if (state.infoHydrating) return;
  markSelectedDirty();
}

function getInfoValues(note) {
  const parent = state.byPath.get(els.infoParent.value) || null;
  return {
    title: getHeaderTitleValue(note),
    parentRef: parent ? `[[${parent.basename}]]` : null
  };
}

function getHeaderTitleValue(note) {
  return normalizeHeaderTitleText(els.noteTitle.textContent) || note.title;
}

function markSelectedDirty() {
  if (!state.selectedPath || state.source !== "folder") return;
  state.dirty = true;
  state.saveToken += 1;
  setStatus("Autosaving...");
  updateSourceStatus();
  scheduleAutosave();
}

async function deleteSelectedNote() {
  await deleteGraphSelection();
}

function confirmDeleteNotes(notes, childCount) {
  if (deleteConfirmResolver) {
    settleDeleteConfirm(false);
  }

  const count = notes.length;
  const isSingle = count === 1;
  const title = isSingle ? notes[0].title : `${count} selected notes`;
  els.deleteConfirmTitle.textContent = isSingle
    ? `Move "${title}" to Trash?`
    : `Move ${title} to Trash?`;
  els.deleteConfirmMessage.textContent = isSingle
    ? "This note will leave the current graph and move to the system Trash."
    : "These notes will leave the current graph and move to the system Trash.";
  els.deleteConfirmDetail.textContent = childCount
    ? `${childCount} child note${childCount === 1 ? "" : "s"} will keep their Markdown and show broken parents until reconnected.`
    : "";
  els.deleteConfirmDetail.hidden = childCount === 0;
  els.confirmDeleteButton.textContent = isSingle ? "Move to Trash" : `Move ${count} notes`;

  return new Promise((resolve) => {
    deleteConfirmResolver = resolve;
    els.deleteConfirmDialog.removeAttribute("hidden");
    if (typeof els.deleteConfirmDialog.showModal === "function") {
      els.deleteConfirmDialog.showModal();
    } else {
      els.deleteConfirmDialog.removeAttribute("hidden");
    }
    els.confirmDeleteButton.focus({ preventScroll: true });
  });
}

function settleDeleteConfirm(confirmed) {
  const resolve = deleteConfirmResolver;
  if (!resolve) return;

  deleteConfirmResolver = null;
  if (typeof els.deleteConfirmDialog.showModal === "function") {
    if (els.deleteConfirmDialog.open) {
      els.deleteConfirmDialog.close();
    }
  } else {
    els.deleteConfirmDialog.setAttribute("hidden", "");
  }
  resolve(Boolean(confirmed));
}

async function deleteGraphSelection() {
  const selectedNotes = getGraphSelectedNotes();
  const notes = selectedNotes.length ? selectedNotes : [getSelectedNote()].filter(Boolean);

  if (!notes.length || !hasWritableWorkspace()) {
    setStatus("Open a folder to move notes to Trash");
    return false;
  }

  const deleting = new Set(notes.map((note) => note.path));
  const childCount = state.notes.filter((note) => note.parentNote && deleting.has(note.parentNote.path) && !deleting.has(note.path)).length;
  if (!(await confirmDeleteNotes(notes, childCount))) return false;

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
  }

  const historyBefore = snapshotWorkspaceForHistory();
  const layoutSnapshot = snapshotGraphPositions();
  const previousGraphIndex = state.graphIndex;

  try {
    await invokeNative("trash_notes", {
      notesPath: state.notesPath,
      paths: notes.map((note) => note.path)
    });

    const deletedPaths = new Set(notes.map((note) => note.path));
    const deletedParent = notes.length === 1 ? notes[0].parentNote : null;
    state.notes = state.notes.filter((item) => !deletedPaths.has(item.path));
    for (const path of deletedPaths) {
      delete state.manualPositions[path];
    }
    const cleanedLinks = await removeDeletedNoteLinks(notes, previousGraphIndex);
    const parentStillExists = deletedParent && state.notes.some((item) => item.path === deletedParent.path);
    const nextPath = notes.length === 1
      ? ((parentStillExists && deletedParent.path) || (state.notes[0] && state.notes[0].path) || null)
      : null;
    state.selectedPath = nextPath;
    state.selectedPaths = nextPath ? new Set([nextPath]) : new Set();
    state.dirty = false;
    rebuildIndex();
    state.validation = validateNotes();
    freezeGraphPositions(layoutSnapshot, { excludePaths: deletedPaths });
    await updateManifestFile();
    renderCurrentSelection(
      cleanedLinks
        ? `Moved ${notes.length} note${notes.length === 1 ? "" : "s"} to Trash and cleaned links`
        : `Moved ${notes.length} note${notes.length === 1 ? "" : "s"} to Trash`
    );
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch({
      ...positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot)),
      ...positionRemovalPatch(deletedPaths)
    });
    updateSourceStatus();
    renderValidationStatus();
    recordWorkspaceHistory("note deletion", historyBefore);
    return true;
  } catch (error) {
    setStatus("Could not move note to Trash");
    console.error(error);
    return false;
  }
}

function scheduleAutosave() {
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
  }
  state.saveTimer = window.setTimeout(() => {
    state.saveTimer = null;
    void autosaveSelectedNote();
  }, 450);
}

async function flushAutosave() {
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  if (state.dirty) {
    await autosaveSelectedNote();
  }
}

async function autosaveSelectedNote() {
  const note = getSelectedNote();
  if (!note) return;

  if (!hasWritableWorkspace()) {
    setStatus("Open a folder to edit notes");
    return;
  }

  const historyBefore = snapshotWorkspaceForHistory();
  const raw = composeRaw(note, getEditorBody(), getInfoValues(note));
  const path = note.path;
  const token = ++state.saveToken;
  const workspaceContext = captureWorkspaceContext();
  const layoutSnapshot = snapshotGraphPositions();
  const previousGraphIndex = state.graphIndex;
  setStatus("Saving...");

  try {
    await invokeNative("write_note", {
      notesPath: state.notesPath,
      path,
      raw
    });
    if (token !== state.saveToken || !isCurrentWorkspaceContext(workspaceContext)) return;

    const updated = parseNote(path, raw);
    const needsFullRefresh = noteNeedsFullRefresh(note, updated);
    state.dirty = false;

    if (needsFullRefresh) {
      const index = state.notes.findIndex((item) => item.path === path);
      if (index !== -1) {
        state.notes.splice(index, 1, updated);
      }

      rebuildIndex();
      state.validation = validateNotes();
      state.selectedPath = updated.path;
      freezeGraphPositions(layoutSnapshot);

      els.noteTitle.textContent = updated.title;
      els.notePath.textContent = updated.path;
      renderInfoPanel(updated);
      renderNewNoteParents();
      renderGraph({ preserveView: true });
      void savePositionPatch(positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot)));
      renderValidationStatus();
    } else {
      patchBodyOnlyNote(note, updated);
    }

    const updatedLinkCount = await updateRenamedNoteLinks(note, updated, previousGraphIndex);
    const latestNote = state.byPath.get(path) || updated;
    const createdLinkedNotes = await createMissingWikiLinkNotes(latestNote, note, layoutSnapshot);
    updateSourceStatus();
    recordWorkspaceHistory("note edit", historyBefore);
    renderNoteDates();
    setStatus(saveStatusMessage({ createdLinkedNotes, updatedLinkCount }));
  } catch (error) {
    if (token !== state.saveToken || !isCurrentWorkspaceContext(workspaceContext)) return;
    state.dirty = true;
    setStatus("Autosave failed");
    console.error(error);
  }
}

function noteNeedsFullRefresh(current, updated) {
  return (
    current.title !== updated.title ||
    current.parentRef !== updated.parentRef ||
    current.hasFrontmatter !== updated.hasFrontmatter ||
    current.hasTitle !== updated.hasTitle ||
    current.hasParent !== updated.hasParent ||
    !sameWikiRefs(current.bodyRefs, updated.bodyRefs)
  );
}

function sameWikiRefs(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (normalizeKey(a[index].ref) !== normalizeKey(b[index].ref)) return false;
  }
  return true;
}

function patchBodyOnlyNote(note, updated) {
  note.raw = updated.raw;
  note.frontmatterRaw = updated.frontmatterRaw;
  note.frontmatterEntries = updated.frontmatterEntries;
  note.frontmatterValues = updated.frontmatterValues;
  note.derivedLevel = updated.derivedLevel;
  note.hasFrontmatter = updated.hasFrontmatter;
  note.hasTitle = updated.hasTitle;
  note.hasParent = updated.hasParent;
  note.body = updated.body;
  note.bodyRefs = updated.bodyRefs;
  note.searchText = updated.searchText;
  state.workspaceMetrics = buildWorkspaceMetricsFromParsedNotes(state.notes);
  state.searchIndexMode = searchIndexModeForMetrics(state.workspaceMetrics);
  state.searchIndex = createSearchIndex(
    state.notes,
    searchIndexOptionsForMetrics(state.workspaceMetrics)
  );
  updateSearchResults();
}

function saveStatusMessage({ createdLinkedNotes = 0, updatedLinkCount = 0 } = {}) {
  if (createdLinkedNotes > 0) {
    return `Created ${createdLinkedNotes} linked note${createdLinkedNotes === 1 ? "" : "s"}`;
  }
  if (updatedLinkCount > 0) {
    return `Updated ${updatedLinkCount} wiki link${updatedLinkCount === 1 ? "" : "s"}`;
  }
  return "Saved automatically";
}

async function updateRenamedNoteLinks(previousNote, updatedNote, previousGraphIndex) {
  if (!previousNote || !updatedNote || previousNote.title === updatedNote.title) return 0;
  const targetPath = previousNote.path;
  let updatedLinkCount = 0;
  const writes = [];

  for (const note of state.notes) {
    const rewrite = rewriteBodyWikiLinks(note.body, ({ parsed, inner }) => {
      if (previousGraphIndex?.resolvePath(parsed.ref) !== targetPath) return null;
      return wikiLinkMarkup(updatedNote.title, wikiAliasFromInner(inner));
    });

    if (!rewrite.changed) continue;
    updatedLinkCount += rewrite.count;
    writes.push({
      path: note.path,
      raw: composeRaw(note, rewrite.body, frontmatterValuesForNote(note))
    });
  }

  if (!writes.length) return 0;
  await writeNoteUpdates(writes);
  rebuildIndex();
  state.validation = validateNotes();
  renderSelectedNote();
  renderNewNoteParents();
  renderGraph({ preserveView: true });
  renderValidationStatus();
  refreshEditorDecorations();
  saveActiveWorkspaceState();
  return updatedLinkCount;
}

async function removeDeletedNoteLinks(deletedNotes, previousGraphIndex) {
  const deletedByPath = new Map((deletedNotes || []).map((note) => [note.path, note]));
  let cleanedLinkCount = 0;
  const writes = [];

  for (const note of state.notes) {
    const rewrite = rewriteBodyWikiLinks(note.body, ({ parsed }) => {
      const targetPath = previousGraphIndex?.resolvePath(parsed.ref);
      if (!deletedByPath.has(targetPath)) return null;
      return parsed.label || parsed.ref;
    });
    const nextParentRef = deletedByPath.has(previousGraphIndex?.parents?.get(note.path))
      ? null
      : frontmatterValuesForNote(note).parentRef;
    const raw = composeRaw(note, rewrite.body, {
      title: note.title,
      parentRef: nextParentRef
    });

    if (raw === note.raw) continue;
    cleanedLinkCount += rewrite.count;
    writes.push({ path: note.path, raw });
  }

  if (writes.length) {
    await writeNoteUpdates(writes);
  }
  return cleanedLinkCount;
}

async function writeNoteUpdates(writes) {
  for (const write of writes) {
    await invokeNative("write_note", {
      notesPath: state.notesPath,
      path: write.path,
      raw: write.raw
    });
    replaceNoteInState(parseNote(write.path, write.raw));
  }
  state.notes.sort((a, b) => compareText(a.path, b.path));
}

function rewriteBodyWikiLinks(body, transform) {
  const original = String(body || "");
  const masked = replaceFencedCodeWithSpaces(original);
  const regex = /\[\[([^\]\n]{1,240})\]\]/g;
  let rewritten = "";
  let lastIndex = 0;
  let count = 0;
  let match;

  while ((match = regex.exec(masked)) !== null) {
    if (original[match.index - 1] === "!") continue;
    const originalMarkup = original.slice(match.index, match.index + match[0].length);
    const inner = original.slice(match.index + 2, match.index + match[0].length - 2);
    const parsed = parseWikiTarget(inner);
    const replacement = transform({ parsed, inner, originalMarkup });
    if (replacement === null || replacement === undefined || replacement === originalMarkup) continue;

    rewritten += original.slice(lastIndex, match.index) + replacement;
    lastIndex = match.index + match[0].length;
    count += 1;
  }

  if (!count) return { body: original, changed: false, count: 0 };
  return {
    body: `${rewritten}${original.slice(lastIndex)}`,
    changed: true,
    count
  };
}

function wikiAliasFromInner(inner) {
  const parts = String(inner || "").split("|");
  return parts.length > 1 ? parts.slice(1).join("|").trim() : "";
}

function wikiLinkMarkup(target, alias = "") {
  const cleanTarget = String(target || "").trim();
  const cleanAlias = String(alias || "").trim();
  return cleanAlias ? `[[${cleanTarget}|${cleanAlias}]]` : `[[${cleanTarget}]]`;
}

async function createMissingWikiLinkNotes(sourceNote, previousNote, layoutSnapshot) {
  const specs = missingWikiLinkNoteSpecs(sourceNote, previousNote);
  if (!specs.length) return 0;

  const createdPaths = specs.map((spec) => spec.path);

  try {
    await invokeNative("create_notes", {
      notesPath: state.notesPath,
      notes: specs.map((spec) => ({
        path: spec.path,
        raw: spec.raw
      }))
    });

    for (const spec of specs) {
      state.notes.push(parseNote(spec.path, spec.raw));
    }

    state.notes.sort((a, b) => compareText(a.path, b.path));
    state.selectedPath = sourceNote.path;
    state.selectedPaths = new Set([sourceNote.path]);
    rebuildIndex();
    state.validation = validateNotes();
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    seedLinkedNotePositions(createdPaths, sourceNote.path, layoutSnapshot);
    await updateManifestFile();
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot, createdPaths)));
    renderValidationStatus();
    refreshEditorDecorations();
    saveActiveWorkspaceState();
    return createdPaths.length;
  } catch (error) {
    setStatus("Could not create linked note");
    console.error(error);
    return 0;
  }
}

function missingWikiLinkNoteSpecs(sourceNote, previousNote) {
  const reservedPaths = new Set(state.notePaths);
  const reservedTitles = new Set(state.notes.map((note) => normalizeKey(note.title)));
  const seenRefs = new Set();
  const specs = [];
  const previousRefs = new Set(autoCreateWikiRefs(previousNote ? previousNote.body : "").map((ref) => normalizeKey(ref.ref)));

  for (const ref of autoCreateWikiRefs(sourceNote.body || "")) {
    const key = normalizeKey(ref.ref);
    if (!key || seenRefs.has(key) || previousRefs.has(key)) continue;
    seenRefs.add(key);
    if (resolveWikiNote(ref.ref)) continue;

    const title = getAvailableDisplayTitle(titleFromWikiRef(ref.ref), reservedTitles);
    const path = getAvailableWikiLinkNotePath(ref.ref, title, reservedPaths);
    const raw = createNoteRaw({
      title,
      parent: null
    });

    reservedPaths.add(path);
    reservedTitles.add(normalizeKey(title));
    specs.push({ path, raw });
  }

  return specs;
}

function autoCreateWikiRefs(body) {
  const text = replaceFencedCodeWithSpaces(String(body || ""));
  const refs = [];
  const seen = new Set();
  const regex = /\[\[([^\]\n]{1,120})\]\]/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (text[match.index - 1] === "!") continue;
    const parsed = parseWikiTarget(match[1]);
    const key = normalizeKey(parsed.ref);
    if (!key || seen.has(key) || !isAutoCreatableWikiTarget(parsed.ref)) continue;
    seen.add(key);
    refs.push(parsed);
  }

  return refs;
}

function replaceFencedCodeWithSpaces(text) {
  return text.replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length));
}

function isAutoCreatableWikiTarget(ref) {
  const target = String(ref || "").trim();
  if (!target || target.length > 120) return false;
  if (target.startsWith("/") || target.startsWith("../") || target.startsWith("./")) return false;
  if (target.includes("\\") || target.includes("#") || target.includes("`")) return false;
  if (/^attachments\//i.test(target)) return false;
  if (/\.(avif|gif|jpe?g|md|mp3|mp4|pdf|png|wav|webm)$/i.test(target)) return false;
  return true;
}

function titleFromWikiRef(ref) {
  const target = String(ref || "")
    .replace(/^notes\//i, "")
    .replace(/\.md$/i, "")
    .split("/")
    .pop();
  return String(target || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Untitled note";
}

function getAvailableWikiLinkNotePath(ref, title, reservedPaths) {
  const candidate = markdownPathFromWikiRef(ref);
  if (candidate) return getAvailableMarkdownPath(candidate, reservedPaths);
  return getAvailableNewNotePath(title, reservedPaths);
}

function markdownPathFromWikiRef(ref) {
  const clean = String(ref || "")
    .replace(/^notes\//i, "")
    .replace(/\.md$/i, "")
    .trim();
  if (!clean || clean.startsWith("/") || clean.includes("\\")) return "";

  const rawSegments = clean.split("/");
  if (rawSegments.some((segment) => !segment || segment === "." || segment === "..")) return "";

  const segments = rawSegments.map((segment) => slugify(segment)).filter(Boolean);
  return segments.length ? `${segments.join("/")}.md` : "";
}

function getAvailableMarkdownPath(candidate, reservedPaths) {
  const existing = new Set([...reservedPaths].map((path) => path.toLowerCase()));
  const normalized = String(candidate || "").replace(/^notes\//i, "").replace(/\.md$/i, "");
  const parts = normalized.split("/");
  const stem = parts.pop() || "untitled";
  const directory = parts.length ? `${parts.join("/")}/` : "";
  let suffix = 0;

  while (true) {
    const path = `${directory}${stem}${suffix ? `-${suffix + 1}` : ""}.md`;
    if (!existing.has(path.toLowerCase())) return path;
    suffix += 1;
  }
}

function renderGraph({ preserveView } = { preserveView: true }) {
  const perf = startPerfMeasure("renderGraph");
  cancelQueuedGraphRender();
  const focusedAnnotationId = document.activeElement instanceof Element && els.graph.contains(document.activeElement)
    ? document.activeElement.closest(".annotationItem")?.dataset.annotationId || null
    : null;
  const viewport = measureGraphViewport({ allowFallback: !hasWritableWorkspace() });
  if (!viewport) {
    requestGraphRender({ preserveView });
    finishPerfMeasure(perf);
    return;
  }

  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;
  const previousViewport = state.graphViewport;
  state.graphViewport = {
    width: viewportWidth,
    height: viewportHeight
  };

  els.graph.setAttribute("width", String(viewportWidth));
  els.graph.setAttribute("height", String(viewportHeight));
  els.graph.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);
  els.graph.replaceChildren();

  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "g");
  canvas.setAttribute("class", "graphCanvas");
  els.graphCanvas = canvas;
  state.nodeElements = new Map();
  state.edgeElements = [];
  state.edgeElementsByPath = new Map();
  state.ropeElement = null;
  state.ropeTargetPath = null;
  state.armedRope = state.armedRope && state.byPath.has(state.armedRope.sourcePath)
    ? state.armedRope
    : null;
  state.selectionRectElement = null;

  const notes = getRenderableNotes();
  state.positions = buildPositions(notes);
  state.nodeSizes = buildNodeSizes(notes);
  state.graphBounds = combineGraphBounds(notes.length ? getGraphBounds(state.positions) : null, documentBounds(state.annotations));
  state.spatialIndex = buildSpatialIndex(notes);
  state.labelVisibilityKey = "";

  const annotationLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  annotationLayer.setAttribute("class", "annotationLayer");
  renderAnnotations(annotationLayer);
  canvas.appendChild(annotationLayer);

  if (!notes.length) {
    els.graph.appendChild(canvas);
    const visibleViewport = measureVisibleGraphViewport({ allowFallback: true }) || viewport;
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "text");
    empty.setAttribute("class", "emptyGraphText");
    empty.setAttribute("x", String(visibleViewport.left + visibleViewport.width / 2));
    empty.setAttribute("y", String(viewportHeight / 2));
    empty.textContent = hasEmptyWritableWorkspace()
      ? (state.annotations.items.length ? "Use the toolbar to draw, or switch to Select" : "Click the graph to create the first note")
      : "Open or create a folder to begin";
    if (!state.annotations.items.length || !hasWritableWorkspace()) els.graph.appendChild(empty);
    applyViewTransform();
    updateLabelVisibility({ force: true });
    syncFitViewButton();
    restoreRenderedAnnotationFocus(focusedAnnotationId);
    finishPerfMeasure(perf);
    return;
  }

  if (!preserveView) {
    fitGraphView(false);
  } else {
    preserveGraphViewportCenter(previousViewport, state.graphViewport);
  }

  const fragment = document.createDocumentFragment();

  for (const note of notes) {
    if (!hasValidHierarchyEdge(note)) continue;
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
    edge.setAttribute("class", "edge hierarchyEdge");
    edge.setAttribute("aria-hidden", "true");
    edge.style.setProperty("--level-color", getLevelColor(note.level));
    fragment.appendChild(edge);
    registerGraphEdge({ path: edge, from: note.parentNote.path, to: note.path, type: "hierarchy" });
  }

  for (const referenceEdge of getRenderableReferenceEdges(notes)) {
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
    edge.setAttribute(
      "class",
      `edge referenceEdge${isReferenceEdgeSelected(referenceEdge, state.selectedPaths) ? " selectedReferenceEdge" : ""}`
    );
    edge.setAttribute("aria-hidden", "true");
    edge.style.setProperty("--level-color", getLevelColor(referenceEdge.level));
    fragment.appendChild(edge);
    registerGraphEdge({ path: edge, from: referenceEdge.from, to: referenceEdge.to, type: "reference" });
  }

  state.labelVisibility = state.largeGraphMode ? computeLargeGraphLabelVisibility() : null;

  for (const note of notes) {
    renderGraphNode(fragment, note);
  }

  canvas.appendChild(fragment);
  els.graph.appendChild(canvas);
  applyViewTransform();
  updateGraphGeometry();
  updateLabelVisibility({ force: true });
  syncFitViewButton();
  restoreRenderedAnnotationFocus(focusedAnnotationId);
  finishPerfMeasure(perf);
}

function restoreRenderedAnnotationFocus(annotationId) {
  if (!annotationId) return;
  const annotation = els.graphCanvas?.querySelector(`.annotationItem[data-annotation-id="${CSS.escape(annotationId)}"]`);
  annotation?.focus({ preventScroll: true });
}

function combineGraphBounds(first, second) {
  if (!first) return second || { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  if (!second) return first;
  const minX = Math.min(first.minX, second.minX);
  const minY = Math.min(first.minY, second.minY);
  const maxX = Math.max(first.maxX, second.maxX);
  const maxY = Math.max(first.maxY, second.maxY);
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function renderAnnotations(layer) {
  for (const item of state.annotations.items) {
    layer.appendChild(createAnnotationGroup(item));
  }
  syncAnnotationControls();
}

function createAnnotationGroup(item) {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", `annotationItem${state.selectedAnnotationId === item.id ? " selected" : ""}`);
    group.dataset.annotationId = item.id;
    group.dataset.annotationType = item.type;
    group.setAttribute("role", "graphics-symbol");
    group.setAttribute("tabindex", "0");
    group.setAttribute("aria-label", `${item.type} annotation${item.name ? `: ${item.name}` : ""}`);

    const shape = document.createElementNS("http://www.w3.org/2000/svg", item.type === "circle" ? "circle" : item.type === "square" ? "rect" : item.type === "text" ? "text" : "path");
    shape.setAttribute("class", item.type === "text" ? "annotationText" : "annotationShape");
    setAnnotationShapeGeometry(shape, item);
    group.appendChild(shape);
    if (item.type !== "text") {
      const hit = shape.cloneNode(false);
      hit.setAttribute("class", "annotationHit");
      group.insertBefore(hit, shape);
    } else {
      const itemBounds = annotationBounds(item);
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      hit.setAttribute("class", "annotationTextHit");
      hit.setAttribute("x", String(itemBounds.minX));
      hit.setAttribute("y", String(itemBounds.minY));
      hit.setAttribute("width", String(itemBounds.width));
      hit.setAttribute("height", String(itemBounds.height));
      group.insertBefore(hit, shape);
    }

    if (item.name && (item.type === "line" || item.type === "square" || item.type === "circle")) {
      const labelPoint = annotationLabelPoint(item);
      const labelHit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const labelWidth = Math.max(24, [...item.name].length * 7.5 + 12);
      labelHit.setAttribute("class", "annotationLabelHit");
      labelHit.setAttribute("x", String(round(labelPoint.x - labelWidth / 2)));
      labelHit.setAttribute("y", String(round(labelPoint.y - 17)));
      labelHit.setAttribute("width", String(round(labelWidth)));
      labelHit.setAttribute("height", "22");
      group.appendChild(labelHit);
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "annotationLabel");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("x", String(round(labelPoint.x)));
      label.setAttribute("y", String(round(labelPoint.y)));
      label.textContent = item.name;
      group.appendChild(label);
    }
    if (state.selectedAnnotationId === item.id) appendAnnotationHandles(group, item);
    return group;
}

function refreshAnnotationElement(item) {
  const current = els.graphCanvas?.querySelector(`.annotationItem[data-annotation-id="${CSS.escape(item.id)}"]`);
  if (!current) return;
  const replacement = createAnnotationGroup(item);
  current.replaceWith(replacement);
}

function setAnnotationShapeGeometry(element, item) {
  if (item.type === "line") element.setAttribute("d", `M ${item.x1} ${item.y1} L ${item.x2} ${item.y2}`);
  else if (item.type === "stroke") element.setAttribute("d", item.points.map((point, index) => `${index ? "L" : "M"} ${round(point.x)} ${round(point.y)}`).join(" "));
  else if (item.type === "square") {
    element.setAttribute("x", String(item.x)); element.setAttribute("y", String(item.y)); element.setAttribute("width", String(item.size)); element.setAttribute("height", String(item.size));
  } else if (item.type === "circle") {
    element.setAttribute("cx", String(item.cx)); element.setAttribute("cy", String(item.cy)); element.setAttribute("r", String(item.radius));
  } else {
    element.setAttribute("x", String(item.x)); element.setAttribute("y", String(item.y));
    item.text.split("\n").forEach((line, index) => {
      const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      span.setAttribute("x", String(item.x)); span.setAttribute("dy", index ? "1.3em" : "0"); span.textContent = line || " "; element.appendChild(span);
    });
  }
}

function appendAnnotationHandles(group, item) {
  if (item.type === "stroke" || item.type === "text") return;
  const points = item.type === "line"
    ? [{ key: "start", x: item.x1, y: item.y1 }, { key: "end", x: item.x2, y: item.y2 }]
    : item.type === "square"
      ? [{ key: "size", x: item.x + item.size, y: item.y + item.size }]
      : [{ key: "radius", x: item.cx + item.radius, y: item.cy }];
  for (const point of points) {
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hit.setAttribute("class", "annotationHandleHit");
    hit.setAttribute("r", String(10 / Math.max(state.view.scale, MIN_ZOOM)));
    hit.setAttribute("cx", String(point.x)); hit.setAttribute("cy", String(point.y));
    hit.dataset.annotationHandle = point.key;
    group.appendChild(hit);
    const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    handle.setAttribute("class", "annotationHandle");
    handle.setAttribute("r", String(5 / Math.max(state.view.scale, MIN_ZOOM)));
    handle.style.strokeWidth = String(1.5 / Math.max(state.view.scale, MIN_ZOOM));
    handle.setAttribute("cx", String(point.x)); handle.setAttribute("cy", String(point.y));
    handle.dataset.annotationHandle = point.key;
    group.appendChild(handle);
  }
}

function requestGraphRender(options = { preserveView: true }) {
  const preserveView = options.preserveView !== false;
  state.queuedGraphRender = {
    preserveView: state.queuedGraphRender ? state.queuedGraphRender.preserveView && preserveView : preserveView
  };

  if (state.graphRenderFrame) return;
  state.graphRenderFrame = window.requestAnimationFrame(() => {
    state.graphRenderFrame = 0;
    const queued = state.queuedGraphRender || { preserveView: true };
    state.queuedGraphRender = null;
    renderGraph(queued);
  });
}

function cancelQueuedGraphRender() {
  if (!state.graphRenderFrame) return;
  window.cancelAnimationFrame(state.graphRenderFrame);
  state.graphRenderFrame = 0;
  state.queuedGraphRender = null;
}

function measureGraphViewport({ allowFallback = false } = {}) {
  const width = els.graphScroller.clientWidth || 0;
  const height = els.graphScroller.clientHeight || 0;

  if (width > 0 && height > 0) {
    return {
      width,
      height
    };
  }

  if (allowFallback) {
    return {
      width: 320,
      height: 320
    };
  }

  return null;
}

function measureVisibleGraphViewport({ allowFallback = false } = {}) {
  const viewport = measureGraphViewport({ allowFallback });
  if (!viewport) return null;
  const overlayWidth = getGraphOverlayWidth();
  return {
    left: 0,
    top: 0,
    width: Math.max(1, viewport.width - overlayWidth),
    height: viewport.height
  };
}

function getGraphOverlayWidth() {
  if (document.body.classList.contains("graphFullscreen")) return 0;
  if (!els.layout || !els.editorPane) return 0;
  const editorStyle = window.getComputedStyle(els.editorPane);
  if (editorStyle.display === "none" || editorStyle.visibility === "hidden") return 0;

  const layoutRect = els.layout.getBoundingClientRect();
  const editorRect = els.editorPane.getBoundingClientRect();
  const handleRect = els.editorResizeHandle?.getBoundingClientRect();
  if (layoutRect.width <= 0 || editorRect.width <= 0) return 0;

  const overlayLeft = Math.min(
    editorRect.left,
    handleRect && handleRect.width > 0 ? handleRect.left : editorRect.left
  );
  return Math.max(0, layoutRect.right - Math.max(layoutRect.left, overlayLeft));
}

function scheduleResizeRender() {
  if (resizeDebounceTimer) {
    window.clearTimeout(resizeDebounceTimer);
  }
  resizeDebounceTimer = window.setTimeout(() => {
    resizeDebounceTimer = 0;
    syncEditorPaneWidthForViewport();
    requestGraphRender({ preserveView: true });
  }, 120);
}

function clearResizeDebounceTimer() {
  if (!resizeDebounceTimer) return;
  window.clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = 0;
}

function syncGraphViewportToLayout() {
  const viewport = measureGraphViewport();
  if (!viewport || !state.graphViewport) return false;
  if (
    Math.abs(viewport.width - state.graphViewport.width) <= 1 &&
    Math.abs(viewport.height - state.graphViewport.height) <= 1
  ) {
    return false;
  }

  renderGraph({ preserveView: true });
  return true;
}

function preserveGraphViewportCenter(previousViewport, nextViewport) {
  if (!previousViewport || !nextViewport) return;
  if (previousViewport.width === nextViewport.width && previousViewport.height === nextViewport.height) return;
  if (!Number.isFinite(state.view.scale) || state.view.scale === 0) return;

  const centerGraphX = (previousViewport.width / 2 - state.view.x) / state.view.scale;
  const centerGraphY = (previousViewport.height / 2 - state.view.y) / state.view.scale;
  state.view.x = nextViewport.width / 2 - centerGraphX * state.view.scale;
  state.view.y = nextViewport.height / 2 - centerGraphY * state.view.scale;
}

function scheduleLargeGraphRefresh() {
  if (!state.largeGraphMode) return;
  if (largeGraphRefreshTimer) {
    window.clearTimeout(largeGraphRefreshTimer);
  }
  largeGraphRefreshTimer = window.setTimeout(() => {
    largeGraphRefreshTimer = 0;
    if (state.largeGraphMode) {
      requestGraphRender({ preserveView: true });
    }
  }, 90);
}

function clearLargeGraphRefreshTimer() {
  if (!largeGraphRefreshTimer) return;
  window.clearTimeout(largeGraphRefreshTimer);
  largeGraphRefreshTimer = 0;
}

function registerGraphEdge(edge) {
  state.edgeElements.push(edge);
  addIncidentGraphEdge(edge.from, edge);
  addIncidentGraphEdge(edge.to, edge);
}

function addIncidentGraphEdge(path, edge) {
  if (!path) return;
  if (!state.edgeElementsByPath.has(path)) {
    state.edgeElementsByPath.set(path, []);
  }
  state.edgeElementsByPath.get(path).push(edge);
}

function updateGraphSelection(previousPaths, nextPaths) {
  const previous = previousPaths instanceof Set ? previousPaths : new Set([previousPaths].filter(Boolean));
  const next = nextPaths instanceof Set ? nextPaths : new Set([nextPaths].filter(Boolean));
  const changedPaths = new Set([...previous, ...next]);
  for (const path of changedPaths) {
    const group = state.nodeElements.get(path);
    if (!group) continue;
    const isSelected = next.has(path);
    group.classList.toggle("selected", isSelected);
    group.setAttribute("aria-pressed", String(isSelected));
    const dot = group.querySelector(".nodeDot");
    if (dot) {
      dot.setAttribute("r", String(getNodeSize(path).radius));
    }
  }
  updateReferenceEdgeSelection(changedPaths, next);
}

function updateReferenceEdgeSelection(changedPaths, selectedPaths = state.selectedPaths) {
  const edges = new Set();
  for (const path of changedPaths) {
    for (const edge of state.edgeElementsByPath.get(path) || []) {
      if (edge.type === "reference") edges.add(edge);
    }
  }
  for (const edge of edges) {
    edge.path.classList.toggle("selectedReferenceEdge", isReferenceEdgeSelected(edge, selectedPaths));
  }
}

function isReferenceEdgeSelected(edge, selectedPaths = state.selectedPaths) {
  return Boolean(edge && (selectedPaths.has(edge.from) || selectedPaths.has(edge.to)));
}

function getRenderableNotes() {
  return state.sortedNotes;
}

function compareGraphNotes(a, b) {
  if (a.level !== b.level) return a.level - b.level;
  const parentA = a.parentNote ? a.parentNote.title : "";
  const parentB = b.parentNote ? b.parentNote.title : "";
  return compareText(parentA, parentB) || compareText(a.title, b.title) || compareText(a.path, b.path);
}

function compareParentOptions(a, b) {
  return a.level - b.level || compareText(a.title, b.title) || compareText(a.path, b.path);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collectReferenceEdges(notes) {
  const renderable = new Set(notes.map((note) => note.path));
  const hierarchyPairs = new Set();
  const referenceEdges = new Map();

  for (const note of notes) {
    if (!hasValidHierarchyEdge(note)) continue;
    hierarchyPairs.add(undirectedPairKey(note.path, note.parentNote.path));
  }

  if (state.graphIndex && Array.isArray(state.graphIndex.E_ref)) {
    for (const graphEdge of state.graphIndex.E_ref) {
      if (!renderable.has(graphEdge.from) || !renderable.has(graphEdge.to)) continue;
      const pairKey = undirectedPairKey(graphEdge.from, graphEdge.to);
      if (hierarchyPairs.has(pairKey)) continue;
      const existing = referenceEdges.get(pairKey);
      const target = state.byPath.get(graphEdge.to);
      if (existing) {
        existing.weight += graphEdge.weight || 1;
        continue;
      }
      referenceEdges.set(pairKey, {
        key: pairKey,
        from: graphEdge.from,
        to: graphEdge.to,
        level: target ? target.level : 0,
        weight: graphEdge.weight || 1
      });
    }
  } else {
    for (const note of notes) {
      for (const ref of note.bodyRefNotes) {
        const target = ref.note;
        if (!target || target.path === note.path) continue;
        if (!renderable.has(target.path)) continue;
        const pairKey = undirectedPairKey(note.path, target.path);
        if (hierarchyPairs.has(pairKey)) continue;
        if (referenceEdges.has(pairKey)) continue;
        referenceEdges.set(pairKey, {
          key: pairKey,
          from: note.path,
          to: target.path,
          level: target.level,
          weight: 1
        });
      }
    }
  }

  return [...referenceEdges.values()];
}

function getRenderableReferenceEdges(notes) {
  const renderable = new Set(notes.map((note) => note.path));
  let edges = state.referenceEdges.filter((edge) => renderable.has(edge.from) && renderable.has(edge.to));

  if (state.largeGraphMode) {
    edges = selectLargeModeReferenceEdges(
      edges,
      {
        selectedPath: state.selectedPath,
        selectedPaths: state.selectedPaths,
        hoveredPath: state.hoveredPath,
        focusedPath: state.focusedPath
      },
      {
        maxEdgeCount: LARGE_GRAPH_CONFIG.referenceEdgeLimit
      }
    );
  }

  return edges;
}

function undirectedPairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function renderGraphNode(canvas, note) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const classes = ["node"];
  const loose = isLooseHierarchyNote(note);
  const nodeSize = getNodeSize(note.path);
  if (state.selectedPaths.has(note.path)) classes.push("selected");
  if (loose) classes.push("looseNode");
  if (state.armedRope && state.armedRope.sourcePath === note.path) classes.push("ropeArmed");
  group.setAttribute("class", classes.join(" "));
  group.style.setProperty("--level-color", getLevelColor(note.level));
  group.style.setProperty("--node-scale", String(nodeSize.scale));
  group.setAttribute("tabindex", "0");
  group.setAttribute("role", "button");
  group.setAttribute("aria-pressed", String(state.selectedPaths.has(note.path)));
  group.setAttribute("aria-label", graphNodeAriaLabel(note, { loose, nodeSize }));
  group.setAttribute(
    "title",
    graphNodeTitle(note, { loose, nodeSize })
  );
  group.setAttribute("data-path", note.path);
  group.setAttribute("data-connection-count", String(nodeSize.connectionCount));

  const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hit.setAttribute("class", "nodeHit");
  hit.setAttribute("r", String(nodeSize.hitRadius));
  group.appendChild(hit);

  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("class", "nodeDot");
  dot.setAttribute("r", String(nodeSize.radius));
  group.appendChild(dot);

  if (shouldRenderInitialNodeLabel(note)) {
    appendNodeLabel(group, note.title, "nodeLabel", nodeSize);
  }
  canvas.appendChild(group);
  state.nodeElements.set(note.path, group);
}

function graphNodeAriaLabel(note, { loose = false, nodeSize = getNodeSize(note.path) } = {}) {
  const parts = [note.title];
  parts.push(`${nodeSize.connectionCount} connection${nodeSize.connectionCount === 1 ? "" : "s"}`);
  if (loose) parts.push("loose note");
  if (state.armedRope && state.armedRope.sourcePath === note.path) parts.push("connection ready");
  if (state.selectedPaths.has(note.path)) parts.push("selected");
  return parts.join(", ");
}

function graphNodeTitle(note, { loose = false, nodeSize = getNodeSize(note.path) } = {}) {
  const connectionSummary = `${nodeSize.connectionCount} connection${nodeSize.connectionCount === 1 ? "" : "s"}`;
  if (state.armedRope && state.armedRope.sourcePath === note.path) {
    return `${note.title} - ${connectionSummary}. Drag from this node to connect.`;
  }
  if (loose) {
    return `${note.title} - ${connectionSummary}. Loose note. Click to open, Shift-click to select, drag to move, double-click to connect.`;
  }
  return `${note.title} - ${connectionSummary}. Click to open, Shift-click to select, drag to move.`;
}

function appendNodeLabel(group, title, className, nodeSize = getNodeSize(group.dataset.path)) {
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("class", className);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("y", String(round(NODE_LABEL_Y * nodeSize.scale)));
  label.style.fontSize = `${round(NODE_LABEL_FONT_SIZE * nodeSize.scale)}px`;
  const lines = wrapTitle(title);
  lines.forEach((line, index) => {
    const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
    tspan.setAttribute("x", "0");
    tspan.setAttribute("dy", index === 0 ? "0" : String(round(NODE_LABEL_LINE_HEIGHT * nodeSize.scale)));
    tspan.textContent = line;
    label.appendChild(tspan);
  });
  group.appendChild(label);
}

function shouldRenderInitialNodeLabel(note) {
  if (!state.largeGraphMode) return true;
  return Boolean(state.labelVisibility && state.labelVisibility.visiblePaths.has(note.path));
}

function ensureGraphNodeLabel(group, path) {
  if (group.querySelector(".nodeLabel")) return;
  const note = state.byPath.get(path);
  if (!note) return;
  appendNodeLabel(group, note.title, "nodeLabel", getNodeSize(path));
}

function removeGraphNodeLabel(group) {
  const label = group.querySelector(".nodeLabel");
  if (label) label.remove();
}

function buildNodeSizes(notes) {
  const sizes = new Map();

  for (const note of notes) {
    const connectionCount = getNodeConnectionCount(note);
    const scale = connectionCountToNodeScale(connectionCount);
    const radius = round(DOT_RADIUS * scale);
    sizes.set(note.path, {
      connectionCount,
      scale: round(scale),
      radius,
      hitRadius: round(Math.max(HIT_RADIUS, radius + 10))
    });
  }

  return sizes;
}

function getNodeConnectionCount(note) {
  const stats = state.labelStats.get(note.path);
  const count = stats ? Number(stats.uniqueNeighborCount) : 0;
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function getNodeSize(path) {
  return state.nodeSizes.get(path) || {
    connectionCount: 0,
    scale: 1,
    radius: DOT_RADIUS,
    hitRadius: HIT_RADIUS
  };
}

function buildPositions(notes) {
  const graph = state.graphIndex
    ? { referenceEdges: state.graphIndex.E_ref }
    : { referenceEdges: state.referenceEdges };
  const autoPositions = buildGraphLayout(graph, notes, {
    levelGap: LEVEL_GAP,
    nodeGap: NODE_GAP,
    subtreeGap: NODE_GAP,
    rootGap: NODE_GAP + 56,
    collisionGap: NODE_GAP,
    looseGapX: NODE_GAP,
    looseGapY: LEVEL_GAP,
    looseMarginX: NODE_GAP * 2,
    looseColumns: Math.max(1, Math.ceil(Math.sqrt(notes.filter(isIncompleteHierarchyNote).length || 1))),
    barycentricSweeps: 3,
    referenceRelaxation: true,
    referenceIterations: state.largeGraphMode ? 4 : 6,
    referenceStrength: state.largeGraphMode ? 0.1 : 0.16
  });
  const positions = offsetPositions(autoPositions, GRAPH_PAD, GRAPH_PAD);
  state.autoPositions = new Map(positions);
  applyManualPositions(positions);

  return positions;
}

function offsetPositions(positions, offsetX, offsetY) {
  const shifted = new Map();
  for (const [path, position] of positions.entries()) {
    shifted.set(path, {
      x: position.x + offsetX,
      y: position.y + offsetY
    });
  }
  return shifted;
}

function applyManualPositions(positions) {
  for (const [path, position] of Object.entries(state.manualPositions)) {
    if (!state.notePaths.has(path)) continue;
    const resolved = resolveStoredPosition(path, position, positions);
    if (resolved) positions.set(path, resolved);
  }
}

function resolveStoredPosition(path, stored, autoPositions = state.autoPositions) {
  return resolveStoredGraphPosition(path, stored, autoPositions, POSITIONING_OPTIONS);
}

function snapshotGraphPositions(paths = state.notePaths) {
  const snapshot = new Map();
  const targetPaths = paths instanceof Set ? paths : new Set(paths || []);

  for (const path of targetPaths) {
    const position = state.positions.get(path);
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    snapshot.set(path, absolutePosition(position));
  }

  return snapshot;
}

function freezeGraphPositions(snapshot, { excludePaths = new Set() } = {}) {
  for (const [path, position] of snapshot.entries()) {
    if (!state.notePaths.has(path) || excludePaths.has(path)) continue;
    state.manualPositions[path] = absolutePosition(position);
  }
}

function seedAddedNotePositions(paths, layoutSnapshot = new Map()) {
  const addedPaths = paths instanceof Set ? [...paths] : [...(paths || [])];
  if (!addedPaths.length) return;

  const occupied = occupiedPositionsFromSnapshot(layoutSnapshot);

  const sortedAddedPaths = addedPaths
    .filter((path) => state.notePaths.has(path))
    .sort((a, b) => {
      const noteA = state.byPath.get(a);
      const noteB = state.byPath.get(b);
      const levelA = noteA && Number.isFinite(noteA.level) ? noteA.level : Number.MAX_SAFE_INTEGER;
      const levelB = noteB && Number.isFinite(noteB.level) ? noteB.level : Number.MAX_SAFE_INTEGER;
      return levelA - levelB || compareText(a, b);
    });

  const loosePaths = [];

  for (const path of sortedAddedPaths) {
    if (occupied.has(path)) continue;
    const note = state.byPath.get(path);
    if (!note) continue;
    const parentPath = note.parentNote && note.parentNote.path;
    if (!parentPath || !occupied.has(parentPath)) {
      loosePaths.push(path);
      continue;
    }

    const position = positionForAddedNote(note, occupied);
    state.manualPositions[path] = position;
    occupied.set(path, position);
  }

  const loosePatch = findLooseGridPositions(loosePaths, occupied, POSITIONING_OPTIONS);
  for (const path of loosePaths) {
    const position = loosePatch[path] || absolutePosition({ x: GRAPH_PAD, y: GRAPH_PAD });
    state.manualPositions[path] = position;
    occupied.set(path, position);
  }
}

function seedLinkedNotePositions(paths, sourcePath, layoutSnapshot = new Map()) {
  const addedPaths = (paths instanceof Set ? [...paths] : [...(paths || [])])
    .filter((path) => state.notePaths.has(path))
    .sort(compareText);
  if (!addedPaths.length) return;

  const occupied = occupiedPositionsFromSnapshot(layoutSnapshot);
  const sourcePosition = occupied.get(sourcePath);
  if (!sourcePosition) {
    seedAddedNotePositions(addedPaths, layoutSnapshot);
    return;
  }

  for (let index = 0; index < addedPaths.length; index += 1) {
    const path = addedPaths[index];
    if (occupied.has(path)) continue;
    const position = nearestOpenLinkedNotePosition(
      linkedNoteBasePosition(sourcePosition, index, addedPaths.length),
      occupied
    );
    state.manualPositions[path] = position;
    occupied.set(path, position);
  }
}

function occupiedPositionsFromSnapshot(layoutSnapshot = new Map()) {
  const occupied = new Map();
  for (const [path, position] of layoutSnapshot.entries()) {
    if (state.notePaths.has(path)) {
      occupied.set(path, absolutePosition(position));
    }
  }

  for (const [path, stored] of Object.entries(state.manualPositions)) {
    const resolved = resolveStoredPosition(path, stored, state.autoPositions);
    if (resolved && state.notePaths.has(path)) {
      occupied.set(path, absolutePosition(resolved));
    }
  }

  return occupied;
}

function linkedNoteBasePosition(sourcePosition, index, count) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const row = Math.floor(index / columns);
  const column = index % columns;
  return absolutePosition({
    x: sourcePosition.x + POSITIONING_OPTIONS.looseMarginX / 2 + column * POSITIONING_OPTIONS.looseGapX,
    y: sourcePosition.y + row * POSITIONING_OPTIONS.looseGapY
  });
}

function nearestOpenLinkedNotePosition(base, occupied) {
  if (!hasPositionCollision(base, occupied)) return base;

  const stepX = POSITIONING_OPTIONS.collisionGap;
  const stepY = Math.min(POSITIONING_OPTIONS.levelGap, POSITIONING_OPTIONS.collisionGap);
  const limit = Math.max(8, occupied.size + 2);

  for (let radius = 1; radius <= limit; radius += 1) {
    for (const candidate of linkedNoteCandidatePositions(base, radius, stepX, stepY)) {
      if (!hasPositionCollision(candidate, occupied)) return candidate;
    }
  }

  return absolutePosition({
    x: base.x + (limit + 1) * stepX,
    y: base.y
  });
}

function linkedNoteCandidatePositions(base, radius, stepX, stepY) {
  const x = radius * stepX;
  const y = radius * stepY;
  return [
    { x: base.x + x, y: base.y },
    { x: base.x, y: base.y + y },
    { x: base.x, y: base.y - y },
    { x: base.x + x, y: base.y + y },
    { x: base.x + x, y: base.y - y },
    { x: base.x - x, y: base.y + y },
    { x: base.x - x, y: base.y - y },
    { x: base.x - x, y: base.y }
  ].map(absolutePosition);
}

function hasPositionCollision(candidate, occupied) {
  const gapX = POSITIONING_OPTIONS.collisionGap;
  const gapY = Math.min(POSITIONING_OPTIONS.levelGap, POSITIONING_OPTIONS.collisionGap);
  for (const position of occupied.values()) {
    if (
      Math.abs(position.x - candidate.x) < gapX &&
      Math.abs(position.y - candidate.y) < gapY
    ) {
      return true;
    }
  }
  return false;
}

function positionForAddedNote(note, occupied) {
  const parentPath = note.parentNote && note.parentNote.path;
  const childPosition = parentPath
    ? findChildPosition(parentPath, occupied, POSITIONING_OPTIONS)
    : null;

  if (childPosition) {
    return childPosition;
  }

  const loosePatch = findLooseGridPositions([note.path], occupied, POSITIONING_OPTIONS);
  return loosePatch[note.path] || absolutePosition({ x: GRAPH_PAD, y: GRAPH_PAD });
}

function layoutPathsFromSnapshot(snapshot, extraPaths = []) {
  return [
    ...new Set([
      ...snapshot.keys(),
      ...(extraPaths instanceof Set ? extraPaths : extraPaths || [])
    ])
  ].filter((path) => state.notePaths.has(path));
}

function absolutePosition(position) {
  return {
    x: round(position.x),
    y: round(position.y)
  };
}

function getGraphBounds(positions) {
  let count = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const [path, position] of positions.entries()) {
    const nodeSize = getNodeSize(path);
    count += 1;
    minX = Math.min(minX, position.x - NODE_BOUND_X * nodeSize.scale);
    maxX = Math.max(maxX, position.x + NODE_BOUND_X * nodeSize.scale);
    minY = Math.min(minY, position.y - NODE_BOUND_TOP * nodeSize.scale);
    maxY = Math.max(maxY, position.y + NODE_BOUND_BOTTOM * nodeSize.scale);
  }

  if (!count) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function getRenderedGraphContentBounds() {
  if (!els.graph || !Number.isFinite(state.view.scale) || state.view.scale === 0) return null;
  const elements = els.graph.querySelectorAll(".nodeDot, .nodeLabel, .annotationShape, .annotationLabel, .annotationText");
  let count = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const element of elements) {
    const style = window.getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    if (style.display === "none" || style.visibility === "hidden" || (Number.isFinite(opacity) && opacity === 0)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const topLeft = clientPointToGraphCanvasPoint(rect.left, rect.top);
    const bottomRight = clientPointToGraphCanvasPoint(rect.right, rect.bottom);
    if (!topLeft || !bottomRight) continue;

    count += 1;
    minX = Math.min(minX, topLeft.x, bottomRight.x);
    maxX = Math.max(maxX, topLeft.x, bottomRight.x);
    minY = Math.min(minY, topLeft.y, bottomRight.y);
    maxY = Math.max(maxY, topLeft.y, bottomRight.y);
  }

  if (!count) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function buildSpatialIndex(notes) {
  const index = {
    cellSize: SPATIAL_CELL_SIZE,
    cells: new Map(),
    pathCells: new Map()
  };

  for (const note of notes) {
    addPathToSpatialIndex(index, note.path);
  }

  return index;
}

function addPathToSpatialIndex(index, path) {
  const position = state.positions.get(path);
  if (!index || !path || !position) return;

  const cellKey = getSpatialCellKey(position.x, position.y, index.cellSize);
  if (!index.cells.has(cellKey)) index.cells.set(cellKey, new Set());
  index.cells.get(cellKey).add(path);
  index.pathCells.set(path, cellKey);
}

function removePathFromSpatialIndex(index, path) {
  if (!index || !path) return;

  const cellKey = index.pathCells.get(path);
  if (!cellKey) return;

  const cell = index.cells.get(cellKey);
  if (cell) {
    cell.delete(path);
    if (!cell.size) index.cells.delete(cellKey);
  }
  index.pathCells.delete(path);
}

function updateSpatialIndexForPaths(paths) {
  if (!state.spatialIndex || !paths || !paths.size) return;

  for (const path of paths) {
    removePathFromSpatialIndex(state.spatialIndex, path);
    if (state.byPath.has(path)) addPathToSpatialIndex(state.spatialIndex, path);
  }
}

function getSpatialCellKey(x, y, cellSize = SPATIAL_CELL_SIZE) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

function querySpatialRect(rect, pad = 0) {
  const index = state.spatialIndex;
  if (!index) return null;

  const paths = new Set();
  const cellSize = index.cellSize;
  const minCellX = Math.floor((rect.minX - pad) / cellSize);
  const maxCellX = Math.floor((rect.maxX + pad) / cellSize);
  const minCellY = Math.floor((rect.minY - pad) / cellSize);
  const maxCellY = Math.floor((rect.maxY + pad) / cellSize);

  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      const cell = index.cells.get(`${cellX}:${cellY}`);
      if (!cell) continue;
      for (const path of cell) {
        const position = state.positions.get(path);
        if (!position) continue;
        if (
          position.x >= rect.minX - pad &&
          position.x <= rect.maxX + pad &&
          position.y >= rect.minY - pad &&
          position.y <= rect.maxY + pad
        ) {
          paths.add(path);
        }
      }
    }
  }

  return paths;
}

function queryNearestSpatialNote(point, radius, excludedPaths = new Set()) {
  const index = state.spatialIndex;
  if (!index) return null;

  const cellSize = index.cellSize;
  const cellRadius = Math.max(1, Math.ceil(radius / cellSize));
  const centerX = Math.floor(point.x / cellSize);
  const centerY = Math.floor(point.y / cellSize);
  const maxDistanceSq = radius * radius;
  let bestPath = null;
  let bestDistanceSq = maxDistanceSq;

  for (let cellX = centerX - cellRadius; cellX <= centerX + cellRadius; cellX += 1) {
    for (let cellY = centerY - cellRadius; cellY <= centerY + cellRadius; cellY += 1) {
      const cell = index.cells.get(`${cellX}:${cellY}`);
      if (!cell) continue;
      for (const path of cell) {
        if (excludedPaths.has(path)) continue;
        const position = state.positions.get(path);
        if (!position) continue;
        const dx = point.x - position.x;
        const dy = point.y - position.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq <= bestDistanceSq) {
          bestPath = path;
          bestDistanceSq = distanceSq;
        }
      }
    }
  }

  return bestPath ? state.byPath.get(bestPath) || null : null;
}

function updateGraphGeometry() {
  for (const edge of state.edgeElements) {
    updateGraphEdgeGeometry(edge);
  }

  for (const [path, group] of state.nodeElements.entries()) {
    const position = state.positions.get(path);
    if (!position) continue;
    group.setAttribute("transform", `translate(${position.x} ${position.y})`);
  }
}

function updateGraphGeometryForPaths(changedPaths) {
  if (!changedPaths || !changedPaths.size) return;
  const perf = startPerfMeasure("updateGraphGeometryForPaths");

  const changedEdges = new Set();
  for (const changedPath of changedPaths) {
    for (const edge of state.edgeElementsByPath.get(changedPath) || []) {
      changedEdges.add(edge);
    }
  }

  for (const edge of changedEdges) {
    updateGraphEdgeGeometry(edge);
  }

  for (const changedPath of changedPaths) {
    const group = state.nodeElements.get(changedPath);
    const position = state.positions.get(changedPath);
    if (group && position) {
      group.setAttribute("transform", `translate(${position.x} ${position.y})`);
    }
  }

  updateSpatialIndexForPaths(changedPaths);
  finishPerfMeasure(perf);
}

function updateGraphEdgeGeometry({ path, from, to, type }) {
  const fromPosition = state.positions.get(from);
  const toPosition = state.positions.get(to);
  if (!fromPosition || !toPosition) return;
  const fromRadius = getNodeSize(from).radius;
  const toRadius = getNodeSize(to).radius;
  path.setAttribute(
    "d",
    type === "reference"
      ? referenceEdgePath(fromPosition, toPosition, fromRadius, toRadius)
      : edgePath(fromPosition, toPosition, fromRadius, toRadius)
  );
}

function edgePath(from, to, fromRadius = DOT_RADIUS, toRadius = DOT_RADIUS) {
  const midY = from.y + (to.y - from.y) / 2;
  return [
    `M ${round(from.x)} ${round(from.y + fromRadius + 3)}`,
    `C ${round(from.x)} ${round(midY)}`,
    `${round(to.x)} ${round(midY)}`,
    `${round(to.x)} ${round(to.y - toRadius - 3)}`
  ].join(" ");
}

function referenceEdgePath(from, to, fromRadius = DOT_RADIUS, toRadius = DOT_RADIUS) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const lift = clamp(distance * 0.18, 30, 92);
  const start = endpointToward(from, to, fromRadius + 9);
  const end = endpointToward(to, from, toRadius + 9);
  const control = {
    x: (from.x + to.x) / 2 + normalX * lift,
    y: (from.y + to.y) / 2 + normalY * lift
  };
  return `M ${round(start.x)} ${round(start.y)} Q ${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`;
}

function endpointToward(from, to, offset) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  return {
    x: from.x + (dx / distance) * offset,
    y: from.y + (dy / distance) * offset
  };
}

function setSearchFilter(value) {
  state.filter = String(value || "").trim();
  state.searchActiveIndex = -1;
  updateSearchResults();
}

function updateSearchResults() {
  const searchOptions = searchIndexOptionsForMetrics(state.workspaceMetrics);
  state.searchResults = buildSearchResults(state.notes, state.searchIndex, state.filter, {
    limit: 12,
    includeBody: searchOptions.includeBody
  });
  if (state.searchActiveIndex >= state.searchResults.length) {
    state.searchActiveIndex = state.searchResults.length ? state.searchResults.length - 1 : -1;
  }
  if (state.searchOpen) renderSearchResults();
}

function onSearchInput() {
  setSearchFilter(els.searchInput.value);
  openSearchResults();
}

function openSearchResults() {
  if (!state.searchOpen) {
    state.searchOpen = true;
  }
  updateSearchResults();
  renderSearchResults();
}

function closeSearchResults() {
  if (!state.searchOpen && els.searchResults.hidden) return;
  state.searchOpen = false;
  state.searchActiveIndex = -1;
  renderSearchResults();
}

function renderSearchResults() {
  els.searchInput.setAttribute("aria-expanded", String(state.searchOpen));
  els.searchInput.removeAttribute("aria-activedescendant");

  if (!state.searchOpen) {
    els.searchResults.hidden = true;
    els.searchResults.replaceChildren();
    return;
  }

  els.searchResults.hidden = false;
  const fragment = document.createDocumentFragment();

  if (!state.notes.length) {
    fragment.appendChild(renderSearchEmpty("Open a folder to search notes"));
  } else if (!state.searchResults.length) {
    fragment.appendChild(renderSearchEmpty("No matching notes"));
  } else {
    state.searchResults.forEach((result, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `searchResult-${index}`;
      button.className = "searchResultButton";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === state.searchActiveIndex));
      button.dataset.searchResultPath = result.path;

      const title = document.createElement("span");
      title.className = "searchResultTitle";
      title.textContent = result.title;
      button.appendChild(title);

      const path = document.createElement("span");
      path.className = "searchResultPath";
      path.textContent = result.path;
      button.appendChild(path);

      if (index === state.searchActiveIndex) {
        els.searchInput.setAttribute("aria-activedescendant", button.id);
      }
      fragment.appendChild(button);
    });
  }

  els.searchResults.replaceChildren(fragment);
}

function renderSearchEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "searchResultsEmpty";
  empty.setAttribute("role", "option");
  empty.setAttribute("aria-disabled", "true");
  empty.textContent = message;
  return empty;
}

function onSearchKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!state.searchOpen) openSearchResults();
    moveSearchActive(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!state.searchOpen) openSearchResults();
    moveSearchActive(-1);
    return;
  }

  if (event.key === "Enter" && state.searchOpen) {
    const result = state.searchResults[state.searchActiveIndex] || state.searchResults[0];
    if (!result) return;
    event.preventDefault();
    void chooseSearchResult(result.path);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeSearchResults();
    els.searchInput.blur();
  }
}

function moveSearchActive(delta) {
  if (!state.searchResults.length) return;
  const current = state.searchActiveIndex < 0
    ? (delta > 0 ? -1 : 0)
    : state.searchActiveIndex;
  state.searchActiveIndex = (current + delta + state.searchResults.length) % state.searchResults.length;
  renderSearchResults();
}

function onSearchResultsClick(event) {
  const resultButton = event.target.closest("[data-search-result-path]");
  if (!resultButton || !els.searchResults.contains(resultButton)) return;
  void chooseSearchResult(resultButton.dataset.searchResultPath);
}

async function chooseSearchResult(path) {
  if (!path || !state.byPath.has(path)) return;
  closeSearchResults();
  els.searchInput.blur();
  await selectNote(path);
  flyToGraphPath(path);
}

function onSearchFocusOut() {
  window.setTimeout(() => {
    if (!els.searchField.contains(document.activeElement)) closeSearchResults();
  }, 0);
}

function onDocumentSearchPointerDown(event) {
  if (els.searchField.contains(event.target)) return;
  closeSearchResults();
}

function scheduleLabelVisibilityRefresh({ force = false } = {}) {
  if (force) state.labelVisibilityKey = "";
  if (!state.nodeElements.size || state.labelRefreshFrame) return;

  state.labelRefreshFrame = window.requestAnimationFrame(() => {
    state.labelRefreshFrame = 0;
    updateLabelVisibility();
  });
}

function cancelLabelVisibilityRefresh() {
  if (!state.labelRefreshFrame) return;
  window.cancelAnimationFrame(state.labelRefreshFrame);
  state.labelRefreshFrame = 0;
}

function updateLabelVisibility({ force = false } = {}) {
  if (!state.nodeElements.size) {
    state.labelVisibility = null;
    state.labelVisibilityKey = "";
    return;
  }

  const cacheKey = getLabelVisibilityKey();
  if (!force && cacheKey === state.labelVisibilityKey) return;

  const perf = startPerfMeasure("updateLabelVisibility");

  if (!state.largeGraphMode) {
    for (const [path, group] of state.nodeElements.entries()) {
      ensureGraphNodeLabel(group, path);
      group.classList.toggle("label-hidden", false);
      group.classList.toggle("label-visible", true);
    }
    state.labelVisibility = null;
    state.labelVisibilityKey = cacheKey;
    finishPerfMeasure(perf);
    return;
  }

  const labelVisibility = computeLargeGraphLabelVisibility();
  state.labelVisibility = labelVisibility;
  state.labelVisibilityKey = cacheKey;

  for (const [path, group] of state.nodeElements.entries()) {
    const visible = labelVisibility.visiblePaths.has(path);
    if (visible) {
      ensureGraphNodeLabel(group, path);
    } else {
      removeGraphNodeLabel(group);
    }
    group.classList.toggle("label-hidden", !visible);
    group.classList.toggle("label-visible", visible);
  }

  finishPerfMeasure(perf);
}

function computeLargeGraphLabelVisibility() {
  return decideVisibleLabels(state.sortedNotes, {
    cache: state.labelVisibilityCache,
    stats: state.labelStats,
    zoom: state.view.scale,
    selectedPath: state.selectedPath,
    selectedPaths: state.selectedPaths,
    hoveredPath: state.hoveredPath,
    focusedPath: state.focusedPath,
    labelRectangles: buildApproxLabelRectangles(state.sortedNotes),
    labelOverlapPadding: 6
  });
}

function buildApproxLabelRectangles(notes) {
  const rectangles = new Map();
  for (const note of notes) {
    const position = state.positions.get(note.path);
    if (!position) continue;
    const nodeSize = getNodeSize(note.path);
    const lines = wrapTitle(note.title);
    const width = Math.max(44 * nodeSize.scale, ...lines.map((line) => line.length * 7.2 * nodeSize.scale));
    const height = Math.max(18 * nodeSize.scale, lines.length * NODE_LABEL_LINE_HEIGHT * nodeSize.scale);
    rectangles.set(note.path, {
      left: position.x - width / 2,
      top: position.y + (NODE_LABEL_Y - NODE_LABEL_FONT_SIZE) * nodeSize.scale,
      width,
      height
    });
  }
  return rectangles;
}

function getLabelVisibilityKey() {
  const sizeKey = `${state.nodeElements.size}:${state.sortedNotes.length}`;
  if (!state.largeGraphMode) return `small:${sizeKey}`;

  const policy = getLabelVisibilityPolicy(state.view.scale);
  return [
    "large",
    sizeKey,
    policy.name,
    state.selectedPath || "",
    [...state.selectedPaths].sort(compareText).join("\u001f"),
    state.hoveredPath || "",
    state.focusedPath || ""
  ].join("|");
}

function refreshLabelsAfterZoom(previousScale) {
  if (!state.largeGraphMode) return;
  const previousPolicy = getLabelVisibilityPolicy(previousScale).name;
  const nextPolicy = getLabelVisibilityPolicy(state.view.scale).name;
  if (previousPolicy !== nextPolicy) {
    scheduleLabelVisibilityRefresh({ force: true });
  }
}

function buildWikiLinkDecorations(doc) {
  const builder = new RangeSetBuilder();
  const regex = /\[\[([^\]]+)\]\]/g;
  const text = doc.toString();
  let match;

  while ((match = regex.exec(text)) !== null) {
    const parsed = parseWikiTarget(match[1]);
    const note = resolveWikiNote(parsed.ref);
    const label = note && !match[1].includes("|") ? note.title : parsed.label;
    builder.add(
      match.index,
      match.index + match[0].length,
      Decoration.replace({
        widget: new WikiLinkWidget(parsed.ref, label, note),
        inclusive: false
      })
    );
  }

  return builder.finish();
}

function wrapTitle(title) {
  const words = title.split(/\s+/);
  const lines = [""];

  for (const word of words) {
    const current = lines[lines.length - 1];
    const next = current ? `${current} ${word}` : word;
    if (next.length > 18 && lines.length < 2) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = next;
    }
  }

  return lines.map((line) => (line.length > 22 ? `${line.slice(0, 21)}...` : line));
}

function onGraphWheel(event) {
  if (graphPinch) { event.preventDefault(); return; }
  if (state.activeInteraction || shouldIgnoreGraphWheelTarget(event.target)) return;
  const factor = getGraphWheelZoomFactor({
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    ctrlKey: event.ctrlKey,
    pageHeight: els.graph.getBoundingClientRect().height
  });
  if (factor === null) return;

  event.preventDefault();
  closeGraphCreatePopover();
  zoomAtPoint(event.clientX, event.clientY, factor);
}

function onGraphPinchStart(event) {
  graphPinch = null;
  if (state.activeInteraction || shouldIgnoreGraphWheelTarget(event.target)) return;
  if (!Number.isFinite(event.scale) || event.scale <= 0) return;
  event.preventDefault();
  graphPinch = { scale: event.scale, workspaceId: state.activeWorkspaceId };
  closeGraphCreatePopover();
}

function onGraphPinchChange(event) {
  if (!graphPinch) return;
  event.preventDefault();
  if (state.activeInteraction || graphPinch.workspaceId !== state.activeWorkspaceId) {
    graphPinch = null;
    return;
  }
  if (!Number.isFinite(event.scale) || event.scale <= 0) return;
  const factor = event.scale / graphPinch.scale;
  graphPinch.scale = event.scale;
  if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    zoomAtPoint(event.clientX, event.clientY, factor);
  } else {
    zoomAtCenter(factor);
  }
}

function onGraphPinchEnd(event) {
  if (graphPinch) event.preventDefault();
  graphPinch = null;
}

function shouldIgnoreGraphWheelTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    "input, textarea, select, [contenteditable], .cm-editor, .graphCreatePopover, " +
    ".annotationToolbar, .annotationEditor, [data-graph-wheel-ignore]"
  ));
}

function zoomAtCenter(factor) {
  const viewport = measureVisibleGraphViewport();
  const rect = els.graph.getBoundingClientRect();
  if (!viewport || rect.width <= 0 || rect.height <= 0) {
    requestGraphRender({ preserveView: true });
    return;
  }

  zoomAtPoint(rect.left + viewport.left + viewport.width / 2, rect.top + viewport.top + viewport.height / 2, factor);
}

function zoomAtPoint(clientX, clientY, factor) {
  cancelGraphViewAnimation();
  const previousScale = state.view.scale;
  const point = clientToSvgPoint(clientX, clientY);
  const nextScale = clamp(state.view.scale * factor, MIN_ZOOM, MAX_ZOOM);
  const graphX = (point.x - state.view.x) / state.view.scale;
  const graphY = (point.y - state.view.y) / state.view.scale;
  state.view.x = point.x - graphX * nextScale;
  state.view.y = point.y - graphY * nextScale;
  state.view.scale = nextScale;
  applyViewTransform();
  refreshLabelsAfterZoom(previousScale);
}

function fitGraphViewFromControl() {
  if (!state.notes.length && !state.annotations.items.length) {
    setStatus(hasWritableWorkspace() ? "Create a note or annotation to fit the graph" : "Open or create a folder to fit the graph");
    return;
  }

  if (fitGraphView()) {
    setStatus("Graph fitted to view");
  } else {
    setStatus("Preparing graph view");
  }
}

function fitGraphView(animate = true) {
  cancelGraphViewAnimation();
  if (!isValidGraphBounds(state.graphBounds) || !els.graphCanvas) return false;
  syncGraphViewportToLayout();
  const viewport = measureVisibleGraphViewport();
  if (!viewport) {
    requestGraphRender({ preserveView: true });
    return false;
  }

  const previousScale = state.view.scale;
  const fitBounds = getRenderedGraphContentBounds() || state.graphBounds;
  if (!isValidGraphBounds(fitBounds)) return false;
  const availableWidth = Math.max(1, viewport.width - FIT_VIEW_PADDING * 2);
  const availableHeight = Math.max(1, viewport.height - FIT_VIEW_PADDING * 2);
  const scale = clamp(
    Math.min(1.08, availableWidth / fitBounds.width, availableHeight / fitBounds.height),
    MIN_ZOOM,
    MAX_ZOOM
  );
  if (!Number.isFinite(scale)) return false;

  const targetView = {
    x: viewport.left + (viewport.width - fitBounds.width * scale) / 2 - fitBounds.minX * scale,
    y: viewport.top + (viewport.height - fitBounds.height * scale) / 2 - fitBounds.minY * scale,
    scale
  };
  if (animate) {
    return animateGraphViewTo(targetView, {
      duration: GRAPH_FLY_TO_DURATION_MS
    });
  }

  state.view = targetView;
  applyViewTransform(false);
  refreshLabelsAfterZoom(previousScale);
  return true;
}

function flyToGraphPath(path) {
  const position = state.positions.get(path);
  const viewport = measureVisibleGraphViewport();
  if (!position || !viewport) return false;

  const targetScale = clamp(
    Math.max(state.view.scale * SEARCH_FLY_TO_ZOOM_FACTOR, SEARCH_FLY_TO_MIN_ZOOM),
    MIN_ZOOM,
    MAX_ZOOM
  );
  return animateGraphViewTo({
    x: viewport.left + viewport.width / 2 - position.x * targetScale,
    y: viewport.top + viewport.height / 2 - position.y * targetScale,
    scale: targetScale
  }, {
    duration: GRAPH_FLY_TO_DURATION_MS
  });
}

function isValidGraphBounds(bounds) {
  return Boolean(
    bounds &&
    Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.minY) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function applyViewTransform(animate = false) {
  if (!els.graphCanvas) return;
  const perf = startPerfMeasure("applyViewTransform");
  els.graphCanvas.style.transition = animate ? "transform 120ms ease" : "";
  els.graphCanvas.setAttribute(
    "transform",
    `translate(${round(state.view.x)} ${round(state.view.y)}) scale(${round(state.view.scale)})`
  );
  updateAnnotationHandleScale();
  finishPerfMeasure(perf);
}

function updateAnnotationHandleScale() {
  const scale = Math.max(state.view.scale, MIN_ZOOM);
  for (const handle of els.graphCanvas?.querySelectorAll(".annotationHandle") || []) {
    handle.setAttribute("r", String(5 / scale));
    handle.style.strokeWidth = String(1.5 / scale);
  }
  for (const hit of els.graphCanvas?.querySelectorAll(".annotationHandleHit") || []) {
    hit.setAttribute("r", String(10 / scale));
  }
}

function animateGraphViewTo(targetView, { duration = 360 } = {}) {
  if (!targetView || !els.graphCanvas) return false;

  cancelGraphViewAnimation();
  const fromView = { ...state.view };
  const previousScale = fromView.scale;
  const target = {
    x: Number(targetView.x),
    y: Number(targetView.y),
    scale: Number(targetView.scale)
  };
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.scale)) {
    return false;
  }

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (reducedMotion || duration <= 0) {
    state.view = target;
    applyViewTransform(false);
    refreshLabelsAfterZoom(previousScale);
    return true;
  }

  const start = performance.now();
  const step = (time) => {
    const progress = clamp((time - start) / duration, 0, 1);
    const eased = easeInOutCubic(progress);
    state.view.x = lerp(fromView.x, target.x, eased);
    state.view.y = lerp(fromView.y, target.y, eased);
    state.view.scale = lerp(fromView.scale, target.scale, eased);
    applyViewTransform(false);

    if (progress < 1) {
      state.viewAnimationFrame = window.requestAnimationFrame(step);
      return;
    }

    state.viewAnimationFrame = 0;
    state.view = target;
    applyViewTransform(false);
    refreshLabelsAfterZoom(previousScale);
  };

  state.viewAnimationFrame = window.requestAnimationFrame(step);
  return true;
}

function cancelGraphViewAnimation() {
  if (!state.viewAnimationFrame) return;
  window.cancelAnimationFrame(state.viewAnimationFrame);
  state.viewAnimationFrame = 0;
}

function easeInOutCubic(value) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function syncFitViewButton() {
  const hasGraphContent = state.notes.length > 0 || state.annotations.items.length > 0;
  const label = hasGraphContent
    ? "Fit graph to view"
    : (hasWritableWorkspace() ? "Create a note or annotation before fitting the graph" : "Open or create a folder before fitting the graph");
  els.resetViewButton.disabled = !hasGraphContent;
  els.resetViewButton.setAttribute("aria-label", label);
  els.resetViewButton.title = label;
}

function onGraphPointerOver(event) {
  const path = getNodePathFromEvent(event);
  if (!path || path === state.hoveredPath) return;
  state.hoveredPath = path;
  scheduleLabelVisibilityRefresh({ force: true });
  scheduleLargeGraphRefresh();
}

function onGraphPointerOut(event) {
  const group = event.target.closest ? event.target.closest(".node") : null;
  if (!group || !els.graph.contains(group)) return;
  const relatedGroup = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest(".node") : null;
  if (relatedGroup === group) return;
  const path = group.getAttribute("data-path");
  if (!path || path !== state.hoveredPath) return;
  state.hoveredPath = null;
  scheduleLabelVisibilityRefresh({ force: true });
  scheduleLargeGraphRefresh();
}

function onGraphFocusIn(event) {
  const path = getNodePathFromEvent(event);
  if (!path || path === state.focusedPath) return;
  state.focusedPath = path;
  scheduleLabelVisibilityRefresh({ force: true });
  scheduleLargeGraphRefresh();
}

function onGraphFocusOut(event) {
  const path = getNodePathFromEvent(event);
  if (!path || path !== state.focusedPath) return;
  state.focusedPath = null;
  scheduleLabelVisibilityRefresh({ force: true });
  scheduleLargeGraphRefresh();
}

function getNodePathFromEvent(event) {
  const group = event.target.closest ? event.target.closest(".node") : null;
  if (!group || !els.graph.contains(group)) return null;
  return group.getAttribute("data-path");
}

function getNodePathAtEvent(event) {
  const path = getNodePathFromEvent(event);
  if (path && state.byPath.has(path)) return path;

  const recent = state.lastNodePointerDown;
  if (
    recent &&
    Date.now() - recent.time < 650 &&
    Math.hypot(event.clientX - recent.clientX, event.clientY - recent.clientY) <= HIT_RADIUS + 18 &&
    state.byPath.has(recent.path)
  ) {
    return recent.path;
  }

  const target = findRopeTarget(eventToGraphPoint(event));
  return target ? target.path : null;
}

function onGraphDoubleClick(event) {
  if (state.annotationTool !== "select") {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const annotationGroup = event.target.closest?.(".annotationItem");
  if (annotationGroup && els.graph.contains(annotationGroup)) {
    event.preventDefault();
    event.stopPropagation();
    if (isAnnotationTransitionLocked()) {
      setStatus("Folder transition in progress");
      return;
    }
    const item = findAnnotation(annotationGroup.dataset.annotationId);
    if (item && item.type !== "stroke") openAnnotationEditor(item);
    return;
  }
  const nodePath = getNodePathAtEvent(event);
  if (nodePath) {
    event.preventDefault();
    event.stopPropagation();
    state.suppressGraphCreateUntil = Date.now() + 650;
    const note = state.byPath.get(nodePath);
    if (!state.activeInteraction && note) {
      armNodeRope(note);
    }
    return;
  }

  if (Date.now() < state.suppressGraphCreateUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  void openGraphCreatePopover(event);
}

function focusGraph() {
  if (document.activeElement === els.graph) return;
  els.graph.focus({ preventScroll: true });
}

function onAnnotationToolbarClick(event) {
  const button = event.target.closest?.("[data-annotation-tool]");
  if (!button || button.disabled || !els.annotationToolbar.contains(button)) return;
  setAnnotationTool(button.dataset.annotationTool);
}

function setAnnotationTool(tool) {
  if (isAnnotationTransitionLocked()) {
    state.annotationTool = "select";
    syncAnnotationControls();
    setStatus("Folder transition in progress");
    return;
  }
  if (!hasWritableWorkspace() || state.annotationsError) tool = "select";
  state.annotationTool = ["select", "pen", "line", "square", "circle", "text"].includes(tool) ? tool : "select";
  if (state.annotationTool !== "select") state.selectedAnnotationId = null;
  syncAnnotationControls();
  renderGraph({ preserveView: true });
  setStatus(state.annotationTool === "select" ? "Select canvas annotations" : `${state.annotationTool[0].toUpperCase()}${state.annotationTool.slice(1)} tool active`);
}

function syncAnnotationControls() {
  if (!els.annotationToolbar) return;
  const unavailable = !hasWritableWorkspace() || Boolean(state.annotationsError);
  const transitionLocked = isAnnotationTransitionLocked();
  for (const button of els.annotationToolbar.querySelectorAll("[data-annotation-tool]")) {
    const selected = button.dataset.annotationTool === state.annotationTool;
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = transitionLocked || (unavailable && button.dataset.annotationTool !== "select");
  }
  els.graph.classList.toggle("annotationToolActive", state.annotationTool !== "select");
  els.graph.classList.toggle("annotationSelectActive", state.annotationTool === "select");
  els.annotationToolbar.title = transitionLocked
    ? "Canvas tools unavailable while the folder changes"
    : (state.annotationsError ? `Annotations unavailable: ${state.annotationsError}` : "Canvas drawing tools");
}

function findAnnotation(id) {
  return state.annotations.items.find((item) => item.id === id) || null;
}

function captureWorkspaceContext() {
  return {
    workspaceId: state.activeWorkspaceId,
    notesPath: state.notesPath
  };
}

function beginAnnotationTransitionLock(workspaceId) {
  if (!workspaceId || annotationTransitionLocksByWorkspace.has(workspaceId)) return null;
  const token = Symbol(workspaceId);
  const lock = { workspaceId, token };
  annotationTransitionLocksByWorkspace.set(workspaceId, token);
  if (workspaceId === state.activeWorkspaceId) {
    prepareAnnotationTransition();
    state.annotationTool = "select";
    state.selectedAnnotationId = null;
    syncAnnotationControls();
    renderGraph({ preserveView: true });
  }
  return lock;
}

function endAnnotationTransitionLock(lock) {
  if (!lock) return;
  if (annotationTransitionLocksByWorkspace.get(lock.workspaceId) !== lock.token) return;
  annotationTransitionLocksByWorkspace.delete(lock.workspaceId);
  if (lock.workspaceId === state.activeWorkspaceId) syncAnnotationControls();
}

function isAnnotationTransitionLocked(workspaceId = state.activeWorkspaceId) {
  return Boolean(workspaceId && annotationTransitionLocksByWorkspace.has(workspaceId));
}

function isCurrentWorkspaceContext(context) {
  return Boolean(
    context?.workspaceId &&
    context.workspaceId === state.activeWorkspaceId &&
    context.notesPath === state.notesPath
  );
}

function requireCurrentWorkspaceContext(context) {
  if (!isCurrentWorkspaceContext(context)) throw new Error("Workspace changed while saving");
}

function enqueueAnnotationWrite(workspaceContext, annotations) {
  const document = cloneAnnotationDocument(annotations);
  const previous = annotationWriteTailsByWorkspace.get(workspaceContext.workspaceId) || Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    await invokeNative("write_annotations", {
      notesPath: workspaceContext.notesPath,
      annotations: document
    });
    markAnnotationDocumentPersisted(workspaceContext.workspaceId, document);
  });
  annotationWriteTailsByWorkspace.set(workspaceContext.workspaceId, write);
  const pendingWrites = pendingAnnotationWritesByWorkspace.get(workspaceContext.workspaceId) || new Set();
  pendingWrites.add(write);
  pendingAnnotationWritesByWorkspace.set(workspaceContext.workspaceId, pendingWrites);
  void write.finally(() => {
    if (annotationWriteTailsByWorkspace.get(workspaceContext.workspaceId) === write) {
      annotationWriteTailsByWorkspace.delete(workspaceContext.workspaceId);
    }
    pendingWrites.delete(write);
    if (!pendingWrites.size) pendingAnnotationWritesByWorkspace.delete(workspaceContext.workspaceId);
  }).catch(() => undefined);
  return write;
}

function markAnnotationDocumentPersisted(workspaceId, annotations) {
  const document = cloneAnnotationDocument(annotations);
  persistedAnnotationDocumentsByWorkspace.set(workspaceId, document);
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (workspace) {
    workspace.persistedAnnotations = cloneAnnotationDocument(document);
    workspace.annotationSaveError = "";
  }
}

function getPersistedAnnotationDocument(workspaceId) {
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  const document = persistedAnnotationDocumentsByWorkspace.get(workspaceId) || workspace?.persistedAnnotations;
  return cloneAnnotationDocument(document || emptyAnnotationDocument());
}

function beginPendingAnnotationChange(workspaceId) {
  let resolve;
  const pending = new Promise((complete) => { resolve = complete; });
  const changes = pendingAnnotationChangesByWorkspace.get(workspaceId) || new Set();
  changes.add(pending);
  pendingAnnotationChangesByWorkspace.set(workspaceId, changes);
  return () => {
    resolve();
    changes.delete(pending);
    if (!changes.size) pendingAnnotationChangesByWorkspace.delete(workspaceId);
  };
}

async function awaitPendingAnnotationWrites(workspaceId) {
  if (!workspaceId) return;
  while (pendingAnnotationChangesByWorkspace.get(workspaceId)?.size || pendingAnnotationWritesByWorkspace.get(workspaceId)?.size || dateWriteTailsByWorkspace.has(workspaceId)) {
    const pending = [
      ...(pendingAnnotationChangesByWorkspace.get(workspaceId) || []),
      ...(pendingAnnotationWritesByWorkspace.get(workspaceId) || []),
      ...(dateWriteTailsByWorkspace.has(workspaceId) ? [dateWriteTailsByWorkspace.get(workspaceId)] : [])
    ];
    await Promise.all(pending.map((operation) => operation.catch(() => undefined)));
  }
}

async function awaitPendingAnnotationWritesForRoot(rootPath) {
  const workspace = state.workspaces.find((item) => item.rootPath === rootPath);
  if (workspace) await awaitPendingAnnotationWrites(workspace.id);
}

function prepareAnnotationTransition() {
  graphPinch = null;
  const editorState = state.annotationEditorState;
  if (editorState?.isNew && editorState.workspaceId === state.activeWorkspaceId) {
    state.annotations = cloneAnnotationDocument(editorState.historyBefore.annotations);
  }
  state.annotationEditorState = null;
  if (els.annotationEditor) els.annotationEditor.hidden = true;

  const interaction = state.activeInteraction;
  if (interaction?.type?.startsWith?.("annotation-") && interaction.historyBefore?.workspaceId === state.activeWorkspaceId) {
    state.annotations = cloneAnnotationDocument(interaction.historyBefore.annotations);
    releaseGraphPointer(interaction.pointerId);
    state.activeInteraction = null;
    cancelQueuedInteraction();
  }
}

function clearAnnotationSelection({ render = false } = {}) {
  if (!state.selectedAnnotationId) return;
  state.selectedAnnotationId = null;
  for (const group of els.graphCanvas?.querySelectorAll(".annotationItem.selected") || []) {
    group.classList.remove("selected");
    group.querySelectorAll(".annotationHandle, .annotationHandleHit").forEach((handle) => handle.remove());
  }
  if (render) renderGraph({ preserveView: true });
}

function clearNodeSelectionForAnnotation() {
  const previousSelection = new Set(state.selectedPaths);
  state.selectedPaths = new Set();
  updateGraphSelection(previousSelection, state.selectedPaths);
  setStatus("Canvas annotation selected");
  updateSourceStatus();
}

function startAnnotationDrawing(event) {
  if (isAnnotationTransitionLocked()) {
    event.preventDefault();
    event.stopPropagation();
    setStatus("Folder transition in progress");
    return;
  }
  if (!hasWritableWorkspace() || state.annotationsError || state.annotations.items.length >= MAX_ANNOTATION_ITEMS) {
    setStatus(state.annotationsError ? `Annotations unavailable: ${state.annotationsError}` : "Annotation limit reached");
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  closeGraphCreatePopover();
  clearNodeSelectionForAnnotation();
  const point = eventToGraphPoint(event);
  const historyBefore = snapshotWorkspaceForHistory();
  const id = createAnnotationId();
  let item;
  if (state.annotationTool === "line") item = { id, type: "line", x1: point.x, y1: point.y, x2: point.x, y2: point.y };
  else if (state.annotationTool === "square") item = { id, type: "square", x: point.x, y: point.y, size: 1 };
  else if (state.annotationTool === "circle") item = { id, type: "circle", cx: point.x, cy: point.y, radius: 1 };
  else if (state.annotationTool === "pen") item = { id, type: "stroke", points: [point, { ...point }] };
  else item = { id, type: "text", x: point.x, y: point.y, text: "" };
  state.annotations.items.push(item);
  state.selectedAnnotationId = id;
  renderGraph({ preserveView: true });
  if (item.type === "text") {
    openAnnotationEditor(item, { historyBefore, isNew: true });
    return;
  }
  state.activeInteraction = { type: "annotation-draw", pointerId: event.pointerId, annotationId: id, start: point, current: point, historyBefore, moved: false };
  els.graph.setPointerCapture(event.pointerId);
}

function startAnnotationSelectionInteraction(event, group) {
  if (isAnnotationTransitionLocked()) {
    event.preventDefault();
    event.stopPropagation();
    setStatus("Folder transition in progress");
    return;
  }
  const item = findAnnotation(group.dataset.annotationId);
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  clearNodeSelectionForAnnotation();
  state.selectedAnnotationId = item.id;
  const handle = event.target.closest?.("[data-annotation-handle]")?.dataset.annotationHandle || null;
  state.activeInteraction = {
    type: handle ? "annotation-resize" : "annotation-move",
    pointerId: event.pointerId,
    annotationId: item.id,
    handle,
    start: eventToGraphPoint(event),
    initial: structuredClone(item),
    historyBefore: snapshotWorkspaceForHistory(),
    moved: false
  };
  renderGraph({ preserveView: true });
  els.graph.setPointerCapture(event.pointerId);
}

async function finishAnnotationChange(label, historyBefore) {
  const workspaceContext = captureWorkspaceContext();
  if (isAnnotationTransitionLocked(workspaceContext.workspaceId)) {
    if (historyBefore?.annotations && isCurrentWorkspaceContext(workspaceContext)) {
      state.annotations = cloneAnnotationDocument(historyBefore.annotations);
      renderGraph({ preserveView: true });
    }
    setStatus("Folder transition in progress");
    return false;
  }
  const saveToken = (annotationSaveTokensByWorkspace.get(workspaceContext.workspaceId) || 0) + 1;
  annotationSaveTokensByWorkspace.set(workspaceContext.workspaceId, saveToken);
  const completePendingChange = beginPendingAnnotationChange(workspaceContext.workspaceId);
  let historyEntry = null;
  try {
    const normalized = normalizeAnnotationDocument(state.annotations);
    const savedDocument = cloneAnnotationDocument(normalized);
    const historyAfter = snapshotWorkspaceForHistory();
    if (historyAfter) historyAfter.annotations = savedDocument;
    historyEntry = buildWorkspaceHistoryEntry(label, historyBefore, historyAfter);
    await enqueueAnnotationWrite(workspaceContext, savedDocument);
    recordPersistedAnnotationHistory(historyEntry, workspaceContext, savedDocument);
    if (saveToken !== annotationSaveTokensByWorkspace.get(workspaceContext.workspaceId)) return false;
    if (!isCurrentWorkspaceContext(workspaceContext)) {
      const workspace = state.workspaces.find((item) => item.id === workspaceContext.workspaceId);
      if (workspace) workspace.annotations = savedDocument;
      return false;
    }
    const activeEditor = state.annotationEditorState?.workspaceId === workspaceContext.workspaceId
      ? state.annotationEditorState
      : null;
    const activeInteraction = state.activeInteraction?.type?.startsWith?.("annotation-") &&
      state.activeInteraction.historyBefore?.workspaceId === workspaceContext.workspaceId
      ? state.activeInteraction
      : null;
    if (activeEditor || activeInteraction) {
      const liveDocument = cloneAnnotationDocument(state.annotations);
      if (activeEditor?.historyBefore) {
        activeEditor.historyBefore.annotations = cloneAnnotationDocument(savedDocument);
      }
      if (activeInteraction?.historyBefore) {
        activeInteraction.historyBefore.annotations = cloneAnnotationDocument(savedDocument);
      }
      state.annotations = liveDocument;
    } else {
      state.annotations = normalized;
    }
    saveActiveWorkspaceState();
    renderGraph({ preserveView: true });
    setStatus(`${label[0].toUpperCase()}${label.slice(1)}`);
    return true;
  } catch (error) {
    if (saveToken !== annotationSaveTokensByWorkspace.get(workspaceContext.workspaceId)) {
      deferAnnotationHistory(workspaceContext.workspaceId, historyEntry);
      return false;
    }
    deferredAnnotationHistoryByWorkspace.delete(workspaceContext.workspaceId);
    restoreLastPersistedAnnotationDocument(workspaceContext, error);
    return false;
  } finally {
    completePendingChange();
  }
}

function deferAnnotationHistory(workspaceId, entry) {
  if (!entry) return;
  const deferred = deferredAnnotationHistoryByWorkspace.get(workspaceId) || [];
  deferred.push(entry);
  deferredAnnotationHistoryByWorkspace.set(workspaceId, deferred);
}

function recordPersistedAnnotationHistory(entry, workspaceContext, persistedDocument) {
  const deferred = deferredAnnotationHistoryByWorkspace.get(workspaceContext.workspaceId) || [];
  deferredAnnotationHistoryByWorkspace.delete(workspaceContext.workspaceId);
  const candidates = [...deferred, entry].filter(Boolean);
  if (!candidates.length) return;

  const chainIsContiguous = candidates.every((candidate, index) => (
    index === 0 || sameAnnotationDocument(candidates[index - 1].afterAnnotations, candidate.beforeAnnotations)
  ));
  const chainReachedPersistedDocument = sameAnnotationDocument(
    candidates[candidates.length - 1].afterAnnotations,
    persistedDocument
  );
  const entries = chainIsContiguous && chainReachedPersistedDocument
    ? candidates
    : (entry && sameAnnotationDocument(entry.afterAnnotations, persistedDocument) ? [entry] : []);
  recordCapturedAnnotationHistoryEntries(entries, workspaceContext);
}

function sameAnnotationDocument(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function recordCapturedAnnotationHistoryEntries(entries, workspaceContext) {
  if (!entries.length) return;
  if (isCurrentWorkspaceContext(workspaceContext)) {
    if (state.historyApplying) return;
    state.undoStack.push(...entries);
    state.undoStack = trimWorkspaceHistoryStack(state.undoStack, workspaceHistoryBudgetOptions());
    state.redoStack = [];
    saveActiveWorkspaceState();
    return;
  }
  const workspace = state.workspaces.find((item) => item.id === workspaceContext.workspaceId);
  if (!workspace) return;
  workspace.undoStack = trimWorkspaceHistoryStack([...(workspace.undoStack || []), ...entries], workspaceHistoryBudgetOptions());
  workspace.redoStack = [];
}

function restoreLastPersistedAnnotationDocument(workspaceContext, error) {
  const persisted = getPersistedAnnotationDocument(workspaceContext.workspaceId);
  const message = `Could not save annotation: ${error?.message || error}`;
  const workspace = state.workspaces.find((item) => item.id === workspaceContext.workspaceId);
  if (workspace) {
    workspace.annotations = cloneAnnotationDocument(persisted);
    workspace.annotationSaveError = message;
  }
  if (!isCurrentWorkspaceContext(workspaceContext)) return;
  prepareAnnotationTransition();
  state.annotations = cloneAnnotationDocument(persisted);
  state.selectedAnnotationId = null;
  saveActiveWorkspaceState();
  renderGraph({ preserveView: true });
  setStatus(message);
}

function openAnnotationEditor(item, options = {}) {
  if (!item || item.type === "stroke" || state.annotationsError || isAnnotationTransitionLocked()) return;
  const point = item.type === "text" ? { x: item.x, y: item.y } : annotationLabelPoint(item);
  const svgPoint = { x: point.x * state.view.scale + state.view.x, y: point.y * state.view.scale + state.view.y };
  els.annotationEditor.style.left = "0px";
  els.annotationEditor.style.top = "0px";
  els.annotationEditor.rows = item.type === "text" ? 4 : 1;
  els.annotationEditor.value = item.type === "text" ? item.text : (item.name || "");
  els.annotationEditor.hidden = false;
  const editorRect = els.annotationEditor.getBoundingClientRect();
  const viewport = {
    left: 0,
    top: 40,
    right: els.graphScroller.clientWidth,
    bottom: els.graphScroller.clientHeight
  };
  const editorPosition = getClampedPopoverPosition(svgPoint, editorRect, viewport, { margin: 8, gap: 0 });
  els.annotationEditor.style.left = `${editorPosition.left}px`;
  els.annotationEditor.style.top = `${editorPosition.top}px`;
  els.annotationEditor.style.maxWidth = `${editorPosition.maxWidth}px`;
  els.annotationEditor.style.maxHeight = `${editorPosition.maxHeight}px`;
  const editorState = {
    annotationId: item.id,
    historyBefore: options.historyBefore || snapshotWorkspaceForHistory(),
    isNew: Boolean(options.isNew),
    ...captureWorkspaceContext()
  };
  state.annotationEditorState = editorState;
  window.setTimeout(() => {
    if (state.annotationEditorState !== editorState || !isCurrentWorkspaceContext(editorState)) return;
    els.annotationEditor.focus();
    els.annotationEditor.select();
  }, 0);
}

function onAnnotationEditorKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    cancelAnnotationEditor();
    return;
  }
  const item = findAnnotation(state.annotationEditorState?.annotationId);
  if (event.key === "Enter" && item?.type !== "text") {
    event.preventDefault();
    els.annotationEditor.blur();
  } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    els.annotationEditor.blur();
  }
}

function cancelAnnotationEditor({ render = true, focus = true } = {}) {
  const editorState = state.annotationEditorState;
  if (!editorState) return;
  if (editorState.isNew && isCurrentWorkspaceContext(editorState)) state.annotations = cloneAnnotationDocument(editorState.historyBefore.annotations);
  state.annotationEditorState = null;
  els.annotationEditor.hidden = true;
  if (render) renderGraph({ preserveView: true });
  if (focus) focusGraph();
}

async function commitAnnotationEditor() {
  const editorState = state.annotationEditorState;
  if (!editorState) return;
  state.annotationEditorState = null;
  els.annotationEditor.hidden = true;
  if (!isCurrentWorkspaceContext(editorState)) return;
  if (isAnnotationTransitionLocked(editorState.workspaceId)) {
    if (editorState.isNew) state.annotations = cloneAnnotationDocument(editorState.historyBefore.annotations);
    renderGraph({ preserveView: true });
    setStatus("Folder transition in progress");
    return;
  }
  const item = findAnnotation(editorState.annotationId);
  if (!item) return;
  const value = els.annotationEditor.value;
  if (item.type === "text") {
    if (!value.trim() && editorState.isNew) {
      state.annotations = cloneAnnotationDocument(editorState.historyBefore.annotations);
      renderGraph({ preserveView: true });
      return;
    }
    item.text = truncateCodePoints(value, MAX_ANNOTATION_TEXT_LENGTH);
  } else {
    item.name = truncateCodePoints(value.trim(), MAX_ANNOTATION_NAME_LENGTH) || undefined;
  }
  await finishAnnotationChange(editorState.isNew ? "write annotation" : "rename annotation", editorState.historyBefore);
  focusGraph();
}

function truncateCodePoints(value, limit) {
  return [...String(value)].slice(0, limit).join("");
}

function startGraphPointerDown(event) {
  if (event.button !== 0 && event.button !== 1) return;
  cancelGraphViewAnimation();
  focusGraph();
  state.lastGraphPoint = eventToGraphPoint(event);

  if (wantsGraphPan(event)) {
    startPan(event);
    return;
  }

  if (event.button === 0 && state.annotationTool !== "select") {
    startAnnotationDrawing(event);
    return;
  }

  const group = event.target.closest ? event.target.closest(".node") : null;
  if (group && els.graph.contains(group)) {
    clearAnnotationSelection();
    const path = group.getAttribute("data-path");
    const note = state.byPath.get(path);
    if (note) {
      state.lastNodePointerDown = {
        path: note.path,
        time: Date.now(),
        clientX: event.clientX,
        clientY: event.clientY
      };
      if (state.armedRope) {
        if (state.armedRope.sourcePath === note.path) {
          startArmedRope(event, note, group);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        clearArmedRope("Connection canceled");
        return;
      }
      if (isNodeConnectionGesture(event)) {
        event.preventDefault();
        event.stopPropagation();
        state.suppressGraphCreateUntil = Date.now() + 650;
        return;
      }
      // Loose and connected nodes share drag behavior; double-click arms rope mode.
      startNodeDrag(event, note, group);
      return;
    }
  }

  if (state.armedRope && event.button === 0) {
    event.preventDefault();
    event.stopPropagation();
    clearArmedRope("Connection canceled");
    return;
  }

  const annotationGroup = event.target.closest?.(".annotationItem");
  if (event.button === 0 && annotationGroup && els.graph.contains(annotationGroup)) {
    if (event.target.closest?.(".annotationLabelHit")) {
      event.preventDefault();
      event.stopPropagation();
      clearNodeSelectionForAnnotation();
      clearAnnotationSelection();
      state.selectedAnnotationId = annotationGroup.dataset.annotationId;
      annotationGroup.classList.add("selected");
      const item = findAnnotation(state.selectedAnnotationId);
      if (item) appendAnnotationHandles(annotationGroup, item);
      return;
    }
    startAnnotationSelectionInteraction(event, annotationGroup);
    return;
  }

  if (shouldStartMarqueeSelection(event)) {
    clearAnnotationSelection();
    startMarqueeSelection(event);
    return;
  }

  clearAnnotationSelection({ render: true });
  startPan(event);
}

function onGraphKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const annotationGroup = event.target.closest?.(".annotationItem");
  if (annotationGroup && els.graph.contains(annotationGroup)) {
    const item = findAnnotation(annotationGroup.dataset.annotationId);
    if (!item) return;
    event.preventDefault();
    clearNodeSelectionForAnnotation();
    state.selectedAnnotationId = item.id;
    renderGraph({ preserveView: true });
    const selected = els.graphCanvas?.querySelector(`.annotationItem[data-annotation-id="${CSS.escape(item.id)}"]`);
    selected?.focus({ preventScroll: true });
    if (event.key === "Enter" && item.type !== "stroke") openAnnotationEditor(item);
    return;
  }
  const group = event.target.closest ? event.target.closest(".node") : null;
  if (!group || !els.graph.contains(group)) return;
  const path = group.getAttribute("data-path");
  if (!path) return;
  event.preventDefault();
  selectNote(path);
}

function startPan(event) {
  if (event.button !== 0 && event.button !== 1) return;
  event.preventDefault();
  closeGraphCreatePopover();
  state.activeInteraction = {
    type: "pan",
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    viewX: state.view.x,
    viewY: state.view.y,
    moved: false
  };
  els.graph.classList.add("isPanning");
  els.graph.setPointerCapture(event.pointerId);
}

function shouldStartMarqueeSelection(event) {
  return event.button === 0 && event.shiftKey;
}

function isAdditiveSelectionEvent(event) {
  return event.shiftKey;
}

function wantsGraphPan(event) {
  return event.button === 1 || (event.button === 0 && event.altKey);
}

function isNodeConnectionGesture(event) {
  return event.button === 0 && event.detail >= 2;
}

function startNodeDrag(event, note, group) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  closeGraphCreatePopover();

  const point = eventToGraphPoint(event);
  const baseSelection = new Set(state.selectedPaths);
  const additiveSelection = isAdditiveSelectionEvent(event);
  const dragPaths = baseSelection.has(note.path) ? [...baseSelection] : [note.path];
  const initialPositions = new Map();
  for (const path of dragPaths) {
    const position = state.positions.get(path);
    if (position) {
      initialPositions.set(path, { ...position });
    }
  }
  if (!initialPositions.size) return;

  state.activeInteraction = {
    type: "node",
    pointerId: event.pointerId,
    primaryPath: note.path,
    paths: [...initialPositions.keys()],
    startX: event.clientX,
    startY: event.clientY,
    startPoint: point,
    initialPositions,
    additiveSelection,
    baseSelection,
    historyBefore: snapshotWorkspaceForHistory(),
    moved: false
  };
  group.classList.add("dragging");
  els.graph.classList.add("isDraggingNodes");
  els.graph.setPointerCapture(event.pointerId);
}

function startMarqueeSelection(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  closeGraphCreatePopover();

  const start = eventToGraphPoint(event);
  state.activeInteraction = {
    type: "marquee",
    pointerId: event.pointerId,
    start,
    current: start,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    additive: isAdditiveSelectionEvent(event),
    baseSelection: new Set(state.selectedPaths),
    previewSelection: new Set(state.selectedPaths)
  };
  els.graph.classList.add("isSelecting");
  els.graph.setPointerCapture(event.pointerId);
}

function startArmedRope(event, note, group) {
  if (event.button !== 0 || !state.armedRope || state.armedRope.sourcePath !== note.path) return;
  const mode = state.armedRope.mode || getNodeRopeMode(note);
  clearArmedRope();
  startNodeRope(event, note, group, mode);
}

function startNodeRope(event, note, group, mode) {
  event.preventDefault();
  event.stopPropagation();
  closeGraphCreatePopover();

  const start = state.positions.get(note.path);
  if (!start) return;

  state.activeInteraction = {
    type: "rope",
    mode,
    pointerId: event.pointerId,
    sourcePath: note.path,
    start,
    current: start,
    targetPath: null,
    startX: event.clientX,
    startY: event.clientY,
    moved: false
  };
  group.classList.add("ropeSource");
  els.graph.setPointerCapture(event.pointerId);
  setStatus(mode === "connect" ? "Drag to a note to set it as parent" : "Drag to a note to add a body link");
}

function armNodeRope(note) {
  if (!note) return;
  clearArmedRope();
  const mode = getNodeRopeMode(note);
  state.armedRope = {
    sourcePath: note.path,
    mode
  };
  const group = state.nodeElements.get(note.path);
  if (group) group.classList.add("ropeArmed");
  void selectNote(note.path);
  setStatus(mode === "connect"
    ? `Drag from ${note.title} to a note to set it as parent`
    : `Drag from ${note.title} to a note to add a body link`);
}

function clearArmedRope(statusMessage = "") {
  const path = state.armedRope && state.armedRope.sourcePath;
  if (path) {
    const group = state.nodeElements.get(path);
    if (group) group.classList.remove("ropeArmed");
  }
  state.armedRope = null;
  if (statusMessage) setStatus(statusMessage);
}

function queueInteraction(event) {
  if (!state.activeInteraction || state.activeInteraction.pointerId !== event.pointerId) return;

  state.queuedInteractionEvent = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    graphPoint: eventToGraphPoint(event)
  };

  if (state.interactionFrame) return;
  state.interactionFrame = window.requestAnimationFrame(() => {
    const queued = state.queuedInteractionEvent;
    state.interactionFrame = 0;
    state.queuedInteractionEvent = null;
    if (queued) continueInteraction(queued);
  });
}

function flushQueuedInteraction(pointerId) {
  const queued = state.queuedInteractionEvent;
  if (!queued || (pointerId !== undefined && queued.pointerId !== pointerId)) return;
  if (state.interactionFrame) {
    window.cancelAnimationFrame(state.interactionFrame);
  }
  state.interactionFrame = 0;
  state.queuedInteractionEvent = null;
  continueInteraction(queued);
}

function cancelQueuedInteraction() {
  if (state.interactionFrame) {
    window.cancelAnimationFrame(state.interactionFrame);
  }
  state.interactionFrame = 0;
  state.queuedInteractionEvent = null;
}

function getInteractionGraphPoint(event) {
  return event.graphPoint || eventToGraphPoint(event);
}

function continueInteraction(event) {
  state.lastGraphPoint = getInteractionGraphPoint(event);
  const interaction = state.activeInteraction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;

  if (interaction.type === "annotation-draw") {
    const point = getInteractionGraphPoint(event);
    interaction.current = point;
    interaction.moved = interaction.moved || Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y) > 1;
    const item = findAnnotation(interaction.annotationId);
    if (!item) return;
    if (item.type === "line") { item.x2 = point.x; item.y2 = point.y; }
    else if (item.type === "square") { item.size = Math.max(1, Math.max(Math.abs(point.x - interaction.start.x), Math.abs(point.y - interaction.start.y))); item.x = point.x < interaction.start.x ? interaction.start.x - item.size : interaction.start.x; item.y = point.y < interaction.start.y ? interaction.start.y - item.size : interaction.start.y; }
    else if (item.type === "circle") item.radius = Math.max(1, Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y));
    else if (item.type === "stroke" && item.points.length < 4096 && Math.hypot(point.x - item.points[item.points.length - 1].x, point.y - item.points[item.points.length - 1].y) > 0.75) item.points.push(point);
    refreshAnnotationElement(item);
    return;
  }

  if (interaction.type === "annotation-move" || interaction.type === "annotation-resize") {
    const point = getInteractionGraphPoint(event);
    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    interaction.moved = interaction.moved || Math.hypot(dx, dy) > 1;
    const index = state.annotations.items.findIndex((item) => item.id === interaction.annotationId);
    if (index < 0) return;
    state.annotations.items[index] = interaction.type === "annotation-move"
      ? translateAnnotation(interaction.initial, dx, dy)
      : resizeAnnotation(interaction.initial, interaction.handle, point);
    refreshAnnotationElement(state.annotations.items[index]);
    return;
  }

  if (interaction.type === "pan") {
    const distance = Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY);
    if (distance > 3) interaction.moved = true;
    state.view.x = interaction.viewX + event.clientX - interaction.startX;
    state.view.y = interaction.viewY + event.clientY - interaction.startY;
    applyViewTransform();
    return;
  }

  if (interaction.type === "node") {
    const point = getInteractionGraphPoint(event);
    const distance = Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY);
    if (distance > 3) interaction.moved = true;

    const deltaX = point.x - interaction.startPoint.x;
    const deltaY = point.y - interaction.startPoint.y;
    const changedPaths = new Set();
    for (const path of interaction.paths) {
      const startPosition = interaction.initialPositions.get(path);
      if (!startPosition) continue;
      const position = {
        x: round(startPosition.x + deltaX),
        y: round(startPosition.y + deltaY)
      };
      state.positions.set(path, position);
      state.manualPositions[path] = absolutePosition(position);
      changedPaths.add(path);
    }
    updateGraphGeometryForPaths(changedPaths);
    return;
  }

  if (interaction.type === "marquee") {
    const point = getInteractionGraphPoint(event);
    const distance = Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY);
    if (distance <= 3) return;
    if (!interaction.moved) {
      interaction.moved = true;
      ensureSelectionRectElement();
    }
    interaction.current = point;
    updateSelectionRect(interaction.start, point);

    const rect = normalizedRect(interaction.start, point);
    const paths = pathsInRect(rect);
    const nextSelection = interaction.additive
      ? new Set([...interaction.baseSelection, ...paths])
      : paths;
    updateGraphSelection(interaction.previewSelection, nextSelection);
    interaction.previewSelection = nextSelection;
    return;
  }

  if (interaction.type === "rope") {
    const point = getInteractionGraphPoint(event);
    const distance = Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY);
    if (distance > 3) interaction.moved = true;
    if (!interaction.moved) return;

    interaction.current = point;
    const target = findRopeTarget(point, interaction.sourcePath);
    interaction.targetPath = target && canUseRopeTarget(interaction, target) ? target.path : null;
    setRopeTarget(interaction.targetPath);
    updateRopePath(interaction.start, point);
  }
}

async function endInteraction(event) {
  flushQueuedInteraction(event.pointerId);
  const interaction = state.activeInteraction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;
  releaseGraphPointer(interaction.pointerId);

  if (interaction.type === "annotation-draw") {
    state.activeInteraction = null;
    const item = findAnnotation(interaction.annotationId);
    if (!item || !interaction.moved) {
      state.annotations = interaction.historyBefore.annotations;
      renderGraph({ preserveView: true });
      return;
    }
    if (item.type === "stroke") item.points = simplifyStroke(item.points, 1.5 / Math.max(state.view.scale, 0.1));
    const saved = await finishAnnotationChange("draw annotation", interaction.historyBefore);
    const currentItem = findAnnotation(interaction.annotationId);
    if (saved && currentItem && (currentItem.type === "line" || currentItem.type === "square" || currentItem.type === "circle")) openAnnotationEditor(currentItem);
    return;
  }

  if (interaction.type === "annotation-move" || interaction.type === "annotation-resize") {
    state.activeInteraction = null;
    if (interaction.moved) await finishAnnotationChange(interaction.type === "annotation-move" ? "move annotation" : "resize annotation", interaction.historyBefore);
    else renderGraph({ preserveView: true });
    return;
  }

  if (interaction.type === "node") {
    clearNodeDragClasses(interaction);
    if (interaction.moved) {
      await savePositionPatch(positionPatchForPaths(interaction.paths));
    }
    if (!interaction.moved) {
      if (interaction.additiveSelection) {
        const nextSelection = new Set(interaction.baseSelection || state.selectedPaths);
        if (nextSelection.has(interaction.primaryPath)) {
          nextSelection.delete(interaction.primaryPath);
        } else {
          nextSelection.add(interaction.primaryPath);
        }
        await setGraphSelection(nextSelection, {
          openSingle: false,
          statusMessage: selectionStatus(nextSelection.size)
        });
      } else {
        await selectNote(interaction.primaryPath);
      }
    } else {
      await setGraphSelection(interaction.paths, {
        openSingle: false,
        statusMessage: `Moved ${interaction.paths.length} note${interaction.paths.length === 1 ? "" : "s"}`
      });
      recordWorkspaceHistory("graph move", interaction.historyBefore);
    }
    state.activeInteraction = null;
    return;
  }

  if (interaction.type === "marquee") {
    removeSelectionRectElement();
    els.graph.classList.remove("isSelecting");
    const nextSelection = interaction.moved ? interaction.previewSelection : new Set();
    await setGraphSelection(nextSelection, {
      openSingle: nextSelection.size === 1,
      statusMessage: selectionStatus(nextSelection.size)
    });
    state.activeInteraction = null;
    return;
  }

  if (interaction.type === "rope") {
    const target = state.byPath.get(interaction.targetPath) || null;
    const source = state.byPath.get(interaction.sourcePath) || null;
    const wasClick = !interaction.moved;

    if (wasClick) {
      state.activeInteraction = null;
      clearRopeSource(interaction);
      clearRopeTarget();
      if (source) await selectNote(source.path);
      return;
    }

    if (target) {
      state.activeInteraction = null;
      clearRopeSource(interaction);
      clearRopeTarget();
      if (source) {
        if (interaction.mode === "reference") {
          await connectNoteReference(source, target);
        } else {
          await connectLooseNoteToParent(source, target);
        }
      }
      return;
    }

    animateRopeBack(interaction);
    state.activeInteraction = null;
    clearRopeSource(interaction);
    clearRopeTarget();
    setStatus(interaction.mode === "reference" ? "Drop the rope on a note" : "Drop the rope on a parent node");
    return;
  }

  if (interaction.type === "pan") {
    if (!interaction.moved) {
      if (hasEmptyWritableWorkspace() && event.button === 0) {
        state.activeInteraction = null;
        els.graph.classList.remove("isPanning");
        await openGraphCreatePopover(event);
        return;
      }
      await setGraphSelection(new Set(), {
        openSingle: false,
        statusMessage: selectionStatus(0)
      });
    }
    state.activeInteraction = null;
    els.graph.classList.remove("isPanning");
    return;
  }

  state.activeInteraction = null;
  els.graph.classList.remove("isPanning");
}

function cancelInteraction() {
  cancelQueuedInteraction();
  const interaction = state.activeInteraction;
  if (interaction) {
    releaseGraphPointer(interaction.pointerId);
  }
  if (interaction && interaction.type.startsWith("annotation-")) {
    state.annotations = cloneAnnotationDocument(interaction.historyBefore.annotations);
    renderGraph({ preserveView: true });
  }
  if (state.activeInteraction && state.activeInteraction.type === "rope") {
    animateRopeBack(state.activeInteraction);
    clearRopeSource(state.activeInteraction);
  }
  if (state.activeInteraction && state.activeInteraction.type === "marquee") {
    updateGraphSelection(state.activeInteraction.previewSelection, state.selectedPaths);
    removeSelectionRectElement();
  }
  if (state.activeInteraction && state.activeInteraction.type === "node") {
    clearNodeDragClasses(state.activeInteraction);
  }
  state.activeInteraction = null;
  els.graph.classList.remove("isPanning", "isSelecting", "isDraggingNodes");
  clearRopeTarget();
}

function onDocumentPointerDown(event) {
  if (!state.armedRope) return;
  if (els.graph.contains(event.target)) return;
  clearArmedRope("Connection canceled");
}

function releaseGraphPointer(pointerId) {
  if (pointerId === undefined || pointerId === null) return;
  try {
    if (els.graph.hasPointerCapture(pointerId)) {
      els.graph.releasePointerCapture(pointerId);
    }
  } catch {
    // Pointer capture may already be gone after a canceled browser gesture.
  }
}

function clearNodeDragClasses(interaction) {
  els.graph.classList.remove("isDraggingNodes");
  for (const path of interaction.paths || []) {
    const group = state.nodeElements.get(path);
    if (group) group.classList.remove("dragging");
  }
  const primary = interaction.primaryPath && state.nodeElements.get(interaction.primaryPath);
  if (primary) primary.classList.remove("dragging");
}

function clearRopeSource(interaction) {
  const path = interaction && interaction.sourcePath;
  if (!path) return;
  const group = state.nodeElements.get(path);
  if (group) group.classList.remove("ropeSource");
}

function ensureSelectionRectElement() {
  if (state.selectionRectElement) return state.selectionRectElement;
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("class", "selectionRect");
  rect.setAttribute("aria-hidden", "true");
  els.graphCanvas.appendChild(rect);
  state.selectionRectElement = rect;
  return rect;
}

function updateSelectionRect(from, to) {
  const rect = ensureSelectionRectElement();
  const bounds = normalizedRect(from, to);
  rect.setAttribute("x", String(bounds.minX));
  rect.setAttribute("y", String(bounds.minY));
  rect.setAttribute("width", String(bounds.width));
  rect.setAttribute("height", String(bounds.height));
}

function removeSelectionRectElement() {
  const rect = state.selectionRectElement;
  if (rect && rect.parentNode) {
    rect.parentNode.removeChild(rect);
  }
  state.selectionRectElement = null;
}

function normalizedRect(from, to) {
  const minX = Math.min(from.x, to.x);
  const maxX = Math.max(from.x, to.x);
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function pathsInRect(rect) {
  const indexedPaths = querySpatialRect(rect, HIT_RADIUS / 2);
  if (indexedPaths) return indexedPaths;

  const paths = new Set();
  const pad = HIT_RADIUS / 2;
  for (const note of state.notes) {
    const position = state.positions.get(note.path);
    if (!position) continue;
    if (
      position.x >= rect.minX - pad &&
      position.x <= rect.maxX + pad &&
      position.y >= rect.minY - pad &&
      position.y <= rect.maxY + pad
    ) {
      paths.add(note.path);
    }
  }
  return paths;
}

function ensureRopeElement() {
  if (state.ropeElement) return state.ropeElement;
  const rope = document.createElementNS("http://www.w3.org/2000/svg", "path");
  rope.setAttribute("class", "connectionRope");
  rope.setAttribute("aria-hidden", "true");
  els.graphCanvas.appendChild(rope);
  state.ropeElement = rope;
  return rope;
}

function updateRopePath(from, to) {
  const rope = ensureRopeElement();
  rope.setAttribute("d", ropePath(from, to));
}

function ropePath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const slack = clamp(distance * 0.16, 18, 74);
  return [
    `M ${round(from.x)} ${round(from.y)}`,
    `C ${round(from.x + dx * 0.22)} ${round(from.y + dy * 0.12 + slack)}`,
    `${round(from.x + dx * 0.78)} ${round(from.y + dy * 0.88 + slack)}`,
    `${round(to.x)} ${round(to.y)}`
  ].join(" ");
}

function animateRopeBack(interaction) {
  const rope = state.ropeElement;
  if (!rope) return;
  rope.classList.add("returning");
  window.requestAnimationFrame(() => {
    rope.setAttribute("d", ropePath(interaction.current || interaction.start, interaction.start));
  });
  window.setTimeout(() => {
    if (rope.parentNode) rope.parentNode.removeChild(rope);
    if (state.ropeElement === rope) state.ropeElement = null;
  }, 220);
}

function findRopeTarget(point, sourcePath = "") {
  const excludedPaths = new Set([sourcePath].filter(Boolean));

  if (state.spatialIndex) {
    return queryNearestSpatialNote(point, HIT_RADIUS + 14, excludedPaths);
  }

  let best = null;
  let bestDistance = Infinity;
  for (const note of state.notes) {
    if (excludedPaths.has(note.path)) continue;
    const position = state.positions.get(note.path);
    if (!position) continue;
    const distance = Math.hypot(point.x - position.x, point.y - position.y);
    if (distance < bestDistance && distance <= HIT_RADIUS + 14) {
      best = note;
      bestDistance = distance;
    }
  }
  return best;
}

function canUseRopeTarget(interaction, target) {
  if (!target || target.path === interaction.sourcePath) return false;
  if (interaction.mode !== "connect") return true;

  const child = state.byPath.get(interaction.sourcePath);
  return Boolean(child && !isDescendant(target, child));
}

function setRopeTarget(path) {
  if (state.ropeTargetPath === path) return;
  clearRopeTarget();
  state.ropeTargetPath = path;
  if (!path) return;
  const group = state.nodeElements.get(path);
  if (group) group.classList.add("ropeTarget");
}

function clearRopeTarget() {
  if (!state.ropeTargetPath) return;
  const group = state.nodeElements.get(state.ropeTargetPath);
  if (group) group.classList.remove("ropeTarget");
  state.ropeTargetPath = null;
}

function eventToGraphPoint(event) {
  const point = clientToSvgPoint(event.clientX, event.clientY);
  return svgPointToGraphPoint(point);
}

function clientPointToGraphPoint(clientX, clientY) {
  const point = clientToSvgPoint(clientX, clientY);
  return svgPointToGraphPoint(point);
}

function clientPointToGraphCanvasPoint(clientX, clientY) {
  if (
    !els.graph ||
    !els.graphCanvas ||
    typeof els.graph.createSVGPoint !== "function" ||
    typeof els.graphCanvas.getScreenCTM !== "function"
  ) {
    return null;
  }

  const matrix = els.graphCanvas.getScreenCTM();
  if (!matrix || typeof matrix.inverse !== "function") return null;

  try {
    const point = els.graph.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    if (Number.isFinite(transformed.x) && Number.isFinite(transformed.y)) {
      return {
        x: transformed.x,
        y: transformed.y
      };
    }
  } catch {
    return null;
  }

  return null;
}

function svgPointToGraphPoint(point) {
  if (!point || !Number.isFinite(state.view.scale) || state.view.scale === 0) return null;
  return {
    x: (point.x - state.view.x) / state.view.scale,
    y: (point.y - state.view.y) / state.view.scale
  };
}

function clientToSvgPoint(clientX, clientY) {
  if (
    els.graph &&
    typeof els.graph.createSVGPoint === "function" &&
    typeof els.graph.getScreenCTM === "function"
  ) {
    const matrix = els.graph.getScreenCTM();
    if (matrix && typeof matrix.inverse === "function") {
      try {
        const point = els.graph.createSVGPoint();
        point.x = clientX;
        point.y = clientY;
        const transformed = point.matrixTransform(matrix.inverse());
        if (Number.isFinite(transformed.x) && Number.isFinite(transformed.y)) {
          return {
            x: transformed.x,
            y: transformed.y
          };
        }
      } catch {
        // Fall back to rect math if the SVG matrix is temporarily unavailable.
      }
    }
  }

  const rect = els.graph.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

async function openGraphCreatePopover(event) {
  if (event.target.closest && event.target.closest(".node")) return;
  if (!hasWritableWorkspace()) {
    setStatus("Open a folder to create notes");
    return;
  }
  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  event.preventDefault();
  state.pendingCreatePoint = eventToGraphPoint(event);
  els.graphNewTitle.value = "";
  els.graphCreatePopover.style.left = "0px";
  els.graphCreatePopover.style.top = "0px";
  els.graphCreatePopover.hidden = false;
  positionGraphCreatePopover(event.clientX, event.clientY);
  els.graphNewTitle.focus();
}

function positionGraphCreatePopover(clientX, clientY) {
  const bounds = els.graphScroller.getBoundingClientRect();
  const popover = els.graphCreatePopover;
  popover.style.maxWidth = `${Math.max(1, Math.round(bounds.width - 24))}px`;
  popover.style.maxHeight = `${Math.max(1, Math.round(bounds.height - 24))}px`;
  const position = getClampedPopoverPosition(
    { x: clientX, y: clientY },
    popover.getBoundingClientRect(),
    bounds
  );
  popover.style.left = `${position.left}px`;
  popover.style.top = `${position.top}px`;
}

function closeGraphCreatePopover() {
  els.graphCreatePopover.hidden = true;
  state.pendingCreatePoint = null;
}

async function createGraphNoteFromPopover(event) {
  event.preventDefault();
  const title = els.graphNewTitle.value.trim();
  if (!title || !state.pendingCreatePoint) return;
  const position = {
    x: round(state.pendingCreatePoint.x),
    y: round(state.pendingCreatePoint.y)
  };
  if (!state.notes.length) {
    closeGraphCreatePopover();
    await createFirstNote(title, position);
    return;
  }
  closeGraphCreatePopover();
  await createLooseGraphNote(title, position);
}

async function createLooseGraphNote(title, position) {
  if (!title || !hasWritableWorkspace()) return false;
  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
  }

  const historyBefore = snapshotWorkspaceForHistory();
  const layoutSnapshot = snapshotGraphPositions();
  const path = getAvailableNewNotePath(title);
  const raw = createNoteRaw({
    title,
    parent: null
  });

  try {
    await invokeNative("create_note", {
      notesPath: state.notesPath,
      path,
      raw
    });

    const note = parseNote(path, raw);
    state.notes.push(note);
    state.notes.sort((a, b) => compareText(a.path, b.path));
    state.selectedPath = note.path;
    state.selectedPaths = new Set([note.path]);
    state.dirty = false;
    state.manualPositions[path] = {
      x: round(position.x),
      y: round(position.y)
    };
    rebuildIndex();
    state.validation = validateNotes();
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    freezeGraphPositions(layoutSnapshot);
    await updateManifestFile();
    renderSelectedNote("Loose note created");
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot, [path])));
    updateSourceStatus();
    renderValidationStatus();
    saveActiveWorkspaceState();
    recordWorkspaceHistory("note creation", historyBefore);
    return true;
  } catch (error) {
    setStatus("Could not create note");
    console.error(error);
    return false;
  }
}

async function connectLooseNoteToParent(child, parent) {
  if (!child || !parent || child.path === parent.path || !hasWritableWorkspace()) return false;
  if (isDescendant(parent, child)) {
    setStatus("Choose a parent outside this note's child chain");
    return false;
  }

  let layoutSnapshot = snapshotGraphPositions();

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
    child = state.byPath.get(child.path);
    parent = state.byPath.get(parent.path);
    if (!child || !parent) return false;
    layoutSnapshot = snapshotGraphPositions();
  }

  const historyBefore = snapshotWorkspaceForHistory();
  const parentPlan = getParentConnectionPlan(parent, child);
  const childRaw = composeRaw(child, child.body, {
    title: child.title,
    parentRef: `[[${parent.basename}]]`
  });

  const writes = [];
  if (parentPlan.raw !== parent.raw) {
    writes.push({ path: parent.path, raw: parentPlan.raw });
  }
  if (childRaw !== child.raw) {
    writes.push({ path: child.path, raw: childRaw });
  }

  if (!writes.length) {
    setStatus(`${child.title} is already connected to ${parent.title}`);
    return true;
  }

  try {
    for (const write of writes) {
      await invokeNative("write_note", {
        notesPath: state.notesPath,
        path: write.path,
        raw: write.raw
      });
    }

    for (const write of writes) {
      replaceNoteInState(parseNote(write.path, write.raw));
    }
    state.notes.sort((a, b) => compareText(a.path, b.path));
    state.selectedPath = child.path;
    state.selectedPaths = new Set([child.path]);
    state.dirty = false;
    rebuildIndex();
    state.validation = validateNotes();
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    freezeGraphPositions(layoutSnapshot);
    renderSelectedNote(`Connected ${child.title} under ${parent.title}`);
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot)));
    updateSourceStatus();
    renderValidationStatus();
    saveActiveWorkspaceState();
    recordWorkspaceHistory("hierarchy change", historyBefore);
    return true;
  } catch (error) {
    setStatus("Could not connect note");
    console.error(error);
    return false;
  }
}

async function connectNoteReference(source, target) {
  if (!source || !target || source.path === target.path || !hasWritableWorkspace()) return false;

  let layoutSnapshot = snapshotGraphPositions();

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
    source = state.byPath.get(source.path);
    target = state.byPath.get(target.path);
    if (!source || !target) return false;
    layoutSnapshot = snapshotGraphPositions();
  }

  const historyBefore = snapshotWorkspaceForHistory();
  if (hasBodyReference(source, target)) {
    state.selectedPath = source.path;
    state.selectedPaths = new Set([source.path]);
    renderSelectedNote(`${source.title} already links to ${target.title}`);
    renderGraph({ preserveView: true });
    saveActiveWorkspaceState();
    return true;
  }

  const body = appendBodyReference(source.body, target);
  const raw = composeRaw(source, body, frontmatterValuesForNote(source));

  try {
    await invokeNative("write_note", {
      notesPath: state.notesPath,
      path: source.path,
      raw
    });

    replaceNoteInState(parseNote(source.path, raw));
    state.notes.sort((a, b) => compareText(a.path, b.path));
    state.selectedPath = source.path;
    state.selectedPaths = new Set([source.path]);
    state.dirty = false;
    rebuildIndex();
    state.validation = validateNotes();
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    freezeGraphPositions(layoutSnapshot);
    renderSelectedNote(`Linked ${source.title} to ${target.title}`);
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot)));
    updateSourceStatus();
    renderValidationStatus();
    saveActiveWorkspaceState();
    recordWorkspaceHistory("body link", historyBefore);
    return true;
  } catch (error) {
    setStatus("Could not add body link");
    console.error(error);
    return false;
  }
}

function hasBodyReference(source, target) {
  return source.bodyRefs.some((ref) => {
    const note = resolveWikiNote(ref.ref);
    return Boolean(note && note.path === target.path);
  });
}

function appendBodyReference(body, target) {
  const ref = `[[${target.basename}]]`;
  const trimmed = String(body || "").replace(/\s+$/g, "");
  return `${trimmed}${trimmed ? "\n\n" : ""}${ref}\n`;
}

function frontmatterValuesForNote(note) {
  const parentRef = note.parentNote
    ? `[[${note.parentNote.basename}]]`
    : cleanWikiRef(note.parentRef);
  return {
    title: note.title,
    parentRef: parentRef ? (parentRef.startsWith("[[") ? parentRef : `[[${parentRef}]]`) : null
  };
}

function replaceNoteInState(note) {
  const index = state.notes.findIndex((item) => item.path === note.path);
  if (index === -1) {
    state.notes.push(note);
  } else {
    state.notes.splice(index, 1, note);
  }
}

function getParentConnectionPlan(parent, child) {
  const values = getParentConnectionValues(parent, child);
  return {
    ...values,
    raw: composeRaw(parent, parent.body, values)
  };
}

function getParentConnectionValues(parent, child) {
  if (hasUsableHierarchySlot(parent)) {
    return {
      title: parent.title,
      parentRef: parent.parentNote ? `[[${parent.parentNote.basename}]]` : null
    };
  }

  const apex = findFallbackApex(parent, child);
  if (apex) {
    return {
      title: parent.title,
      parentRef: `[[${apex.basename}]]`
    };
  }

  return {
    title: parent.title,
    parentRef: null
  };
}

function findFallbackApex(parent, child) {
  for (const note of state.sortedNotes) {
    if (note.path === parent.path || (child && note.path === child.path)) continue;
    if (isValidApex(note)) return note;
  }
  return null;
}

async function onDocumentKeydown(event) {
  const isShortcut = (event.metaKey || event.ctrlKey) && !event.altKey;
  const key = event.key.toLowerCase();
  const isTextEntry = isTextEntryTarget(event.target);

  if (!isTextEntry && isShortcut && key === "z") {
    event.preventDefault();
    if (event.shiftKey) {
      await redoWorkspaceHistory();
    } else {
      await undoWorkspaceHistory();
    }
    return;
  }

  if (!isTextEntry && isShortcut && key === "y") {
    event.preventDefault();
    await redoWorkspaceHistory();
    return;
  }

  if (isTextEntry) return;

  const hasGraphFocus = document.activeElement === els.graph || els.graph.contains(document.activeElement);
  const hasSelection = state.selectedPaths.size > 0;
  if (!hasGraphFocus) return;

  if ((event.key === "Backspace" || event.key === "Delete") && state.selectedAnnotationId) {
    event.preventDefault();
    if (isAnnotationTransitionLocked()) {
      setStatus("Folder transition in progress");
      return;
    }
    const historyBefore = snapshotWorkspaceForHistory();
    state.annotations.items = state.annotations.items.filter((item) => item.id !== state.selectedAnnotationId);
    state.selectedAnnotationId = null;
    await finishAnnotationChange("delete annotation", historyBefore);
    return;
  }

  if ((event.key === "Backspace" || event.key === "Delete") && hasSelection) {
    event.preventDefault();
    await deleteGraphSelection();
    return;
  }

  if (!isShortcut) return;

  if (key === "c" && hasSelection) {
    event.preventDefault();
    await copySelectedNodes("copy");
    return;
  }

  if (key === "x" && hasSelection) {
    event.preventDefault();
    await cutSelectedNodes();
    return;
  }

  if (key === "v" && hasGraphFocus) {
    event.preventDefault();
    await pasteClipboardIntoGraph();
  }
}

function isTextEntryTarget(target) {
  if (!(target instanceof Element)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable ||
    Boolean(target.closest(".cm-editor"))
  );
}

async function copySelectedNodes(mode = "copy") {
  const notes = getGraphSelectedNotes();
  if (!notes.length) return false;

  const clipboardNotes = notes.map((note) => ({
    path: note.path,
    title: note.title,
    level: note.level,
    parentPath: note.parentNote ? note.parentNote.path : null,
    body: note.body,
    raw: note.raw,
    position: state.positions.get(note.path) || null
  }));
  const text = notes.map((note) => note.raw.trim()).join("\n\n");
  state.nodeClipboard = {
    mode,
    notes: clipboardNotes,
    text
  };

  await writeClipboardText(text);
  setStatus(`${notes.length} note${notes.length === 1 ? "" : "s"} copied`);
  return true;
}

async function cutSelectedNodes() {
  const notes = getGraphSelectedNotes();
  if (!notes.length) return false;

  await copySelectedNodes("copy");
  const deleted = await deleteGraphSelection();
  if (deleted && state.nodeClipboard) {
    state.nodeClipboard.mode = "cut";
  }
  return deleted;
}

async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    focusGraph();
  }
}

async function pasteClipboardIntoGraph(point = state.lastGraphPoint || getViewportCenterGraphPoint()) {
  if (!hasWritableWorkspace()) {
    setStatus("Open a folder to paste notes");
    return false;
  }

  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    setStatus("Could not read clipboard");
    return false;
  }

  return pasteTextIntoGraph(text, point);
}

async function pasteTextIntoGraph(text, point = getViewportCenterGraphPoint()) {
  const clipboard = state.nodeClipboard;
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return false;

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
  }

  if (clipboard && clipboard.text.trim() === normalizedText && clipboard.notes.length) {
    return pasteCopiedNodes(clipboard, point);
  }

  return createNoteFromPastedText(normalizedText, point);
}

async function pasteCopiedNodes(clipboard, point) {
  const parent = getPasteParent();
  if (!parent) {
    setStatus("Select a parent note before pasting nodes");
    return false;
  }

  const ordered = [...clipboard.notes].sort((a, b) => a.level - b.level || compareText(a.path, b.path));
  const positions = positionsAroundPoint(point, ordered.length);
  const reservedPaths = new Set(state.notePaths);
  const reservedTitles = new Set(state.notes.map((note) => normalizeKey(note.title)));
  const createdBySource = new Map();
  const specs = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const source = ordered[index];
    const copiedParent = source.parentPath ? createdBySource.get(source.parentPath) : null;
    const nextParent = copiedParent || parent;
    const requestedTitle = clipboard.mode === "copy" ? `${source.title} copy` : source.title;
    const title = getAvailableDisplayTitle(requestedTitle, reservedTitles);
    const level = nextParent.level + 1;
    const path = getAvailableNewNotePath(title, reservedPaths);
    const raw = createNoteRaw({
      title,
      parent: nextParent,
      body: source.body || ""
    });

    reservedPaths.add(path);
    reservedTitles.add(normalizeKey(title));
    const created = {
      path,
      basename: basenameFromPath(path),
      title,
      level
    };
    createdBySource.set(source.path, created);
    specs.push({
      path,
      raw,
      position: positions[index]
    });
  }

  return createNotesBatch(specs, `Pasted ${specs.length} note${specs.length === 1 ? "" : "s"}`);
}

async function createNoteFromPastedText(text, point) {
  const reservedTitles = new Set(state.notes.map((note) => normalizeKey(note.title)));
  const title = getAvailableDisplayTitle(titleFromText(text), reservedTitles);
  const path = getAvailableNewNotePath(title);
  const raw = createNoteRaw({
    title,
    parent: null,
    body: bodyFromText(text, title)
  });

  return createNotesBatch([
    {
      path,
      raw,
      position: point
    }
  ], "Pasted text as note");
}

async function createNotesBatch(specs, statusMessage) {
  if (!specs.length) return false;
  if (!hasWritableWorkspace()) {
    setStatus("Open a folder to create notes");
    return false;
  }

  const historyBefore = snapshotWorkspaceForHistory();
  const layoutSnapshot = snapshotGraphPositions();
  const createdPaths = specs.map((spec) => spec.path);

  try {
    await invokeNative("create_notes", {
      notesPath: state.notesPath,
      notes: specs.map((spec) => ({
        path: spec.path,
        raw: spec.raw
      }))
    });

    for (const spec of specs) {
      const note = parseNote(spec.path, spec.raw);
      state.notes.push(note);
      if (spec.position) {
        state.manualPositions[spec.path] = {
          x: round(spec.position.x),
          y: round(spec.position.y)
        };
      }
    }

    state.notes.sort((a, b) => compareText(a.path, b.path));
    state.selectedPaths = new Set(specs.map((spec) => spec.path));
    state.selectedPath = specs.length === 1 ? specs[0].path : null;
    state.dirty = false;
    rebuildIndex();
    state.validation = validateNotes();
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    freezeGraphPositions(layoutSnapshot);
    seedAddedNotePositions(createdPaths, layoutSnapshot);
    await updateManifestFile();
    renderCurrentSelection(statusMessage);
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot, createdPaths)));
    updateSourceStatus();
    renderValidationStatus();
    recordWorkspaceHistory("note creation", historyBefore);
    return true;
  } catch (error) {
    setStatus("Could not create note");
    console.error(error);
    return false;
  }
}

function getPasteParent() {
  return (
    getOnlyGraphSelectedNote() ||
    getSelectedNote() ||
    state.notes.find((note) => note.level === 0) ||
    state.notes[0] ||
    null
  );
}

function getViewportCenterGraphPoint() {
  const viewport = measureVisibleGraphViewport({ allowFallback: true }) || { width: 320, height: 320 };
  const viewportLeft = Number.isFinite(viewport.left) ? viewport.left : 0;
  const viewportTop = Number.isFinite(viewport.top) ? viewport.top : 0;
  const viewportWidth = Math.max(320, viewport.width);
  const viewportHeight = Math.max(320, viewport.height);
  return {
    x: round((viewportLeft + viewportWidth / 2 - state.view.x) / state.view.scale),
    y: round((viewportTop + viewportHeight / 2 - state.view.y) / state.view.scale)
  };
}

function positionsAroundPoint(point, count) {
  const origin = point || getViewportCenterGraphPoint();
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const gapX = 132;
  const gapY = 86;
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const rowCount = Math.min(columns, count - row * columns);
    return {
      x: round(origin.x + (col - (rowCount - 1) / 2) * gapX),
      y: round(origin.y + row * gapY)
    };
  });
}

function basenameFromPath(path) {
  return path.replace(/\.md$/i, "").split("/").pop();
}

function onGraphDragOver(event) {
  if (!hasMarkdownDrop(event)) return;
  event.preventDefault();
  focusGraph();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  els.graph.classList.add("isDropTarget");
  state.lastGraphPoint = eventToGraphPoint(event);
}

function onGraphDragLeave(event) {
  if (event.relatedTarget && els.graph.contains(event.relatedTarget)) return;
  els.graph.classList.remove("isDropTarget");
}

async function onGraphDrop(event) {
  if (!hasMarkdownDrop(event)) return;
  event.preventDefault();
  els.graph.classList.remove("isDropTarget");
  focusGraph();

  const files = [...(event.dataTransfer ? event.dataTransfer.files : [])]
    .filter((file) => file.name.toLowerCase().endsWith(".md"));
  if (!files.length) return;

  const point = eventToGraphPoint(event);
  await importMarkdownFiles(files, point);
}

function hasMarkdownDrop(event) {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  if ([...transfer.types].includes("Files")) return true;
  return [...transfer.items].some((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? file.name.toLowerCase().endsWith(".md") : item.type === "text/markdown";
  });
}

async function importMarkdownFiles(files, point) {
  if (!hasWritableWorkspace()) {
    setStatus("Open a folder to drop Markdown files");
    return false;
  }

  const parent = getPasteParent();
  if (!parent) {
    setStatus("Select a parent note before dropping Markdown files");
    return false;
  }

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
  }

  const reservedPaths = new Set(state.notePaths);
  const reservedTitles = new Set(state.notes.map((note) => normalizeKey(note.title)));
  const positions = positionsAroundPoint(point, files.length);
  const specs = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const text = await file.text();
    const fallbackTitle = file.name.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
    const title = getAvailableDisplayTitle(titleFromText(text, fallbackTitle), reservedTitles);
    const path = getAvailableNewNotePath(title, reservedPaths);
    const raw = createNoteRaw({
      title,
      parent,
      body: bodyFromText(text, title)
    });

    reservedPaths.add(path);
    reservedTitles.add(normalizeKey(title));
    specs.push({
      path,
      raw,
      position: positions[index]
    });
  }

  return createNotesBatch(specs, `Imported ${specs.length} Markdown file${specs.length === 1 ? "" : "s"}`);
}

function readStoredPositions(stored, layoutKey = state.layoutKey, allowedPaths = state.notePaths) {
  if (stored && typeof stored === "object") {
    return pruneStoredPositions(stored, allowedPaths);
  }

  try {
    const stored = window.localStorage.getItem(layoutKey);
    if (!stored) return {};
    return pruneStoredPositions(JSON.parse(stored), allowedPaths);
  } catch {
    return {};
  }
}

async function savePositionPatch(patch) {
  const entries = Object.entries(patch || {});
  if (!entries.length) return;

  try {
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    if (hasWritableWorkspace()) {
      await invokeNative("write_layout_patch", {
        notesPath: state.notesPath,
        updates: patch
      });
      return;
    }

    window.localStorage.setItem(state.layoutKey, JSON.stringify(state.manualPositions));
  } catch {
    setStatus("Could not save layout");
  }
}

function positionPatchForPaths(paths) {
  return createAbsolutePositionPatch(paths, state.positions, POSITIONING_OPTIONS);
}

function positionRemovalPatch(paths) {
  const patch = {};
  for (const path of paths || []) {
    patch[path] = null;
  }
  return patch;
}

function pruneStoredPositions(positions, allowedPaths = state.notePaths) {
  const next = {};
  for (const [path, position] of Object.entries(positions || {})) {
    if (!allowedPaths.has(path)) continue;
    if (Number.isFinite(position.dx) || Number.isFinite(position.dy)) {
      next[path] = {
        dx: round(Number(position.dx) || 0),
        dy: round(Number(position.dy) || 0)
      };
      continue;
    }
    if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
      next[path] = {
        x: round(position.x),
        y: round(position.y)
      };
    }
  }
  return next;
}

function renderValidationStatus() {
  if (state.source !== "folder") {
    els.validationStatus.textContent = "No folder";
    els.validationStatus.title = "Open or create a folder to validate notes";
    return;
  }

  if (!state.notes.length) {
    els.validationStatus.textContent = "No notes";
    els.validationStatus.title = "This folder has no Markdown notes yet";
    return;
  }

  if (!state.validation.length) {
    if (state.graphHasHierarchy) {
      els.validationStatus.textContent = "Valid";
      els.validationStatus.title = "No broken parents or missing frontmatter";
      return;
    }

    els.validationStatus.textContent = "Grid mode";
    els.validationStatus.title = "Hierarchy metadata is incomplete. Loose nodes stay visible and can be connected to parent nodes.";
    return;
  }

  const counts = state.validation.reduce((acc, issue) => {
    acc[issue.type] = (acc[issue.type] || 0) + 1;
    return acc;
  }, {});
  const parts = [
    counts.parent ? `${counts.parent} parent` : "",
    counts.duplicate ? `${counts.duplicate} duplicate` : "",
    counts.frontmatter ? `${counts.frontmatter} frontmatter` : ""
  ].filter(Boolean);

  els.validationStatus.textContent = `${state.validation.length} issue${state.validation.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
  els.validationStatus.title = state.validation.map((issue) => issue.message).join("\n");
  if (!state.graphHasHierarchy) {
    els.validationStatus.title = `${els.validationStatus.title}\nLoose nodes stay visible and can be connected to parent nodes.`;
  }
}

function renderNewNoteParents() {
  const fragment = document.createDocumentFragment();
  const parents = state.sortedParentOptions;

  const rootOption = document.createElement("option");
  rootOption.value = "";
  rootOption.textContent = parents.length ? "No parent (new root or loose)" : "No parent (first root note)";
  fragment.appendChild(rootOption);

  for (const note of parents) {
    const option = document.createElement("option");
    option.value = note.path;
    option.textContent = parentOptionLabel(note);
    fragment.appendChild(option);
  }

  els.newNoteParent.replaceChildren(fragment);
  if (state.selectedPath && state.notePaths.has(state.selectedPath)) {
    els.newNoteParent.value = state.selectedPath;
  }

  updateNewNoteHint();
}

async function openNewNoteDialog() {
  if (!hasWritableWorkspace()) {
    setStatus("Open a folder to create notes");
    return;
  }

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  renderNewNoteParents();
  els.newNoteTitle.value = "";

  if (typeof els.newNoteDialog.showModal === "function") {
    els.newNoteDialog.showModal();
  } else {
    els.newNoteDialog.removeAttribute("hidden");
  }
  els.newNoteTitle.focus();
}

function closeNewNoteDialog() {
  if (typeof els.newNoteDialog.close === "function") {
    els.newNoteDialog.close();
  } else {
    els.newNoteDialog.setAttribute("hidden", "");
  }
}

function updateNewNoteHint() {
  if (!state.notes.length) {
    els.newNoteHint.textContent = "Creates the first root note.";
    return;
  }

  const parent = state.byPath.get(els.newNoteParent.value);
  if (!parent) {
    els.newNoteHint.textContent = "Creates a root or loose note.";
    return;
  }

  els.newNoteHint.textContent = `Creates a child of [[${parent.basename}]].`;
}

async function createNewNote(event) {
  event.preventDefault();

  const title = els.newNoteTitle.value.trim();
  const parent = state.byPath.get(els.newNoteParent.value);
  if (!title || !hasWritableWorkspace()) return;
  if (!parent && !state.notes.length) {
    await createFirstNote(title, getViewportCenterGraphPoint());
    closeNewNoteDialog();
    return;
  }

  const path = getAvailableNewNotePath(title);
  const raw = createNoteRaw({
    title,
    parent
  });
  const historyBefore = snapshotWorkspaceForHistory();
  const layoutSnapshot = snapshotGraphPositions();

  try {
    await invokeNative("create_note", {
      notesPath: state.notesPath,
      path,
      raw
    });
    const note = parseNote(path, raw);
    state.notes.push(note);
    state.notes.sort((a, b) => compareText(a.path, b.path));
    state.selectedPath = note.path;
    state.selectedPaths = new Set([note.path]);
    state.dirty = false;
    rebuildIndex();
    state.validation = validateNotes();
    freezeGraphPositions(layoutSnapshot);
    seedAddedNotePositions([path], layoutSnapshot);
    await updateManifestFile();
    renderSelectedNote("Note created");
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths(layoutPathsFromSnapshot(layoutSnapshot, [path])));
    updateSourceStatus();
    renderValidationStatus();
    closeNewNoteDialog();
    recordWorkspaceHistory("note creation", historyBefore);
  } catch (error) {
    setStatus("Could not create note");
    console.error(error);
  }
}

async function createFirstNote(title, position = getGraphViewportCenter()) {
  if (!title || !hasEmptyWritableWorkspace()) return false;

  const historyBefore = snapshotWorkspaceForHistory();
  const path = getAvailableNewNotePath(title);
  const raw = createNoteRaw({
    title,
    parent: null
  });

  try {
    await invokeNative("create_note", {
      notesPath: state.notesPath,
      path,
      raw
    });

    const note = parseNote(path, raw);
    state.notes.push(note);
    state.notes.sort((a, b) => compareText(a.path, b.path));
    state.selectedPath = note.path;
    state.selectedPaths = new Set([note.path]);
    state.dirty = false;
    state.manualPositions[path] = {
      x: round(position.x),
      y: round(position.y)
    };
    rebuildIndex();
    state.validation = validateNotes();
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    await updateManifestFile();
    renderSelectedNote("First note created");
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths([path]));
    updateSourceStatus();
    renderValidationStatus();
    saveActiveWorkspaceState();
    recordWorkspaceHistory("note creation", historyBefore);
    return true;
  } catch (error) {
    setStatus("Could not create note");
    console.error(error);
    return false;
  }
}

function getAvailableNewNotePath(title, reservedPaths = state.notePaths) {
  return getAvailableNewNotePathForTitle(title, reservedPaths);
}

async function updateManifestFile() {
  const paths = state.notes.map((note) => note.path).sort(compareText);
  if (!state.notesPath) return;
  await invokeNative("write_manifest", {
    notesPath: state.notesPath,
    paths
  });
}

function getLevelColor(level) {
  if (LEVEL_COLORS[level]) return LEVEL_COLORS[level];
  const hue = (level * 47) % 360;
  return `hsl(${hue} 82% 72%)`;
}

function parentOptionLabel(note) {
  const indent = "  ".repeat(Math.min(note.level, 12));
  return `${indent}${note.title}`;
}

function setStatus(message) {
  els.editorStatus.textContent = message || "";
  els.launchStatus.textContent = message || "";
  els.graphLaunchStatus.textContent = message || "";
}

function updateSourceStatus() {
  const isFolder = hasWritableWorkspace();
  const hasSelection = Boolean(getSelectedNote());
  const canDelete = canDeleteCurrentSelection();
  updateGraphTitle();
  els.sourceStatus.textContent = isFolder ? "" : "No folder";
  els.sourceStatus.title = isFolder
    ? [state.rootPath || state.workspaceName || "Folder open", searchIndexModeLabel(state.searchIndexMode)].filter(Boolean).join("\n")
    : "Open or create a folder to edit notes";
  els.newNoteButton.disabled = !isFolder;
  els.newNoteButton.title = isFolder ? "Create a note in this folder" : "Open or create a folder first";
  els.infoParent.disabled = !isFolder || !hasSelection;
  els.noteInfo.setAttribute("aria-disabled", String(!isFolder || !hasSelection));
  keepDisabledInfoClosed();
  els.deleteNoteButton.disabled = !canDelete;
  els.deleteNoteButton.title = canDelete ? "Move selection to Trash" : "Select notes to move to Trash";
  els.deleteNoteButton.setAttribute("aria-label", canDelete ? "Move selection to Trash" : "Select notes to move to Trash");
  syncFitViewButton();
  syncEditorPaneWidthForViewport();
  updateHeaderNoteTitleEditable(isFolder && hasSelection);
  setEditorEditable(isFolder && hasSelection);
  renderWorkspaceTabs();
  renderLaunchScreen();
}

function canDeleteCurrentSelection() {
  return hasWritableWorkspace() && (Boolean(getSelectedNote()) || state.selectedPaths.size > 0);
}

function setEditorEditable(isEditable) {
  if (!state.editorView) return;
  state.editorView.dispatch({
    effects: editorEditable.reconfigure(EditorView.editable.of(isEditable))
  });
}

function startPerfMeasure(name) {
  if (
    !PERF_ENABLED ||
    typeof window.performance === "undefined" ||
    typeof window.performance.mark !== "function"
  ) {
    return null;
  }

  const id = `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const start = `${id}:start`;
  window.performance.mark(start);
  return { name, start, end: `${id}:end` };
}

function finishPerfMeasure(measure) {
  if (
    !measure ||
    typeof window.performance === "undefined" ||
    typeof window.performance.mark !== "function" ||
    typeof window.performance.measure !== "function"
  ) {
    return;
  }

  window.performance.mark(measure.end);
  window.performance.measure(measure.name, measure.start, measure.end);
  window.performance.clearMarks(measure.start);
  window.performance.clearMarks(measure.end);
  if (typeof window.performance.clearMeasures === "function") {
    window.performance.clearMeasures(measure.name);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
