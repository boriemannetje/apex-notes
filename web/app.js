import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, dropCursor, highlightActiveLine, keymap } from "@codemirror/view";
import {
  detectLargeGraphMode,
  selectLargeModeReferenceEdges
} from "./graphLargeMode.js";
import { LARGE_GRAPH_CONFIG } from "./graphConfig.js";
import { createGraphIndex, ISSUE_TYPES } from "./graphModel.js";
import { buildGraphLayout } from "./graphLayout.js";
import {
  computeNoteLinkStats,
  decideVisibleLabels,
  getLabelVisibilityPolicy,
  prepareLabelVisibilityCache
} from "./labelVisibility.js";
import { createSearchIndex } from "./searchIndex.js";
import {
  cleanWikiRef,
  getNoteAliasKeys,
  normalizeKey,
  parseWikiRefs,
  parseWikiTarget,
  slugify
} from "./noteRefs.js";
import apexNotesWritingSkill from "../skills/apex-notes-writing/SKILL.md";

const LEVEL_COLORS = ["#f2f0ea", "#9fc5ff", "#b8f0c0", "#ffe08a", "#ffb6d1", "#b88cff", "#7de3ff", "#f6a86d"];
const STORAGE_PREFIX = "hamkg-layout-v2";
const HIERARCHY_AGENT_INSTRUCTIONS = `Custom hierarchy guidance:
- check for pre existing hyrachy, sometimes only a few files don't have the correct formatting
- Build sensible hierarchy edges from the notes in this folder following the note writing skill.
- Parentless level 0 notes are allowed as loose notes or roots of independent hierarchies.
- When a note is connected to a parent, the parent must be one level above it.
- Moving down a connected hierarchy should become progressively less abstract and more concrete: principles -> themes -> projects/areas -> concrete notes, examples, tasks, or observations.
- Use body wiki links only for contextual references between related notes, not as hierarchy.

Full Apex Notes writing skill, copied from skills/apex-notes-writing/SKILL.md:

${apexNotesWritingSkill.trim()}`;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 2.2;
const DOT_RADIUS = 7;
const SELECTED_DOT_RADIUS = 12;
const HIT_RADIUS = 22;
const LEVEL_GAP = 138;
const NODE_GAP = 168;
const GRAPH_PAD = 96;
const PENDING_PATH = "__pending_node__";
const SPATIAL_CELL_SIZE = 240;
const LIVE_SYNC_INTERVAL_MS = 1500;
const PERF_ENABLED =
  window.location.search.includes("perf=1") ||
  window.localStorage.getItem("apex-notes-perf") === "1";

const editorEditable = new Compartment();
const wikiLinkRefreshEffect = StateEffect.define();

const state = {
  workspaces: [],
  activeWorkspaceId: null,
  nextWorkspaceId: 1,
  notes: [],
  graphIndex: null,
  searchIndex: null,
  byPath: new Map(),
  byKey: new Map(),
  notePaths: new Set(),
  sortedNotes: [],
  sortedParentOptions: [],
  selectedPath: null,
  selectedPaths: new Set(),
  rootPath: "",
  notesPath: "",
  source: "none",
  workspaceName: "",
  dirty: false,
  saveTimer: null,
  saveToken: 0,
  fileSignatures: new Map(),
  liveSyncTimer: 0,
  liveSyncInFlight: false,
  liveSyncToken: 0,
  graphRenderFrame: 0,
  queuedGraphRender: null,
  filter: "",
  searchMatchedPaths: new Set(),
  validation: [],
  layoutKey: "",
  manualPositions: {},
  autoPositions: new Map(),
  positions: new Map(),
  nodeElements: new Map(),
  edgeElements: [],
  edgeElementsByPath: new Map(),
  spatialIndex: null,
  referenceEdges: [],
  referenceEdgeCount: 0,
  largeGraphMode: false,
  labelStats: new Map(),
  labelVisibilityCache: null,
  labelVisibility: null,
  labelVisibilityKey: "",
  labelRefreshFrame: 0,
  hoveredPath: null,
  focusedPath: null,
  editorView: null,
  editorHydrating: false,
  infoHydrating: false,
  graphHasHierarchy: true,
  hierarchyPromptShown: false,
  hierarchyPromptText: "",
  pendingCreatePoint: null,
  pendingNode: null,
  nodeClipboard: null,
  ropeElement: null,
  ropeTargetPath: null,
  selectionRectElement: null,
  lastGraphPoint: null,
  view: {
    x: 0,
    y: 0,
    scale: 1
  },
  activeInteraction: null,
  interactionFrame: 0,
  queuedInteractionEvent: null,
  graphBounds: null,
  graphViewport: null,
  graphFullscreenFallback: false
};

const els = {
  workspaceTabs: document.querySelector("#workspaceTabs"),
  graphWorkspaceName: document.querySelector("#graphWorkspaceName"),
  graph: document.querySelector("#graph"),
  graphPane: document.querySelector(".graphPane"),
  graphScroller: document.querySelector("#graphScroller"),
  graphCanvas: null,
  graphHelpButton: document.querySelector("#graphHelpButton"),
  graphHelpDialog: document.querySelector("#graphHelpDialog"),
  closeGraphHelpButton: document.querySelector("#closeGraphHelpButton"),
  searchInput: document.querySelector("#searchInput"),
  openFolderButton: document.querySelector("#openFolderButton"),
  createFolderButton: document.querySelector("#createFolderButton"),
  newNoteButton: document.querySelector("#newNoteButton"),
  editor: document.querySelector("#editor"),
  noteTitle: document.querySelector("#noteTitle"),
  notePath: document.querySelector("#notePath"),
  noteInfo: document.querySelector("#noteInfo"),
  infoTitle: document.querySelector("#infoTitle"),
  infoParent: document.querySelector("#infoParent"),
  infoLevel: document.querySelector("#infoLevel"),
  deleteNoteButton: document.querySelector("#deleteNoteButton"),
  editorStatus: document.querySelector("#editorStatus"),
  sourceStatus: document.querySelector("#sourceStatus"),
  validationStatus: document.querySelector("#validationStatus"),
  zoomInButton: document.querySelector("#zoomInButton"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  resetViewButton: document.querySelector("#resetViewButton"),
  fullscreenGraphButton: document.querySelector("#fullscreenGraphButton"),
  newNoteDialog: document.querySelector("#newNoteDialog"),
  newNoteForm: document.querySelector("#newNoteForm"),
  newNoteTitle: document.querySelector("#newNoteTitle"),
  newNoteParent: document.querySelector("#newNoteParent"),
  newNoteHint: document.querySelector("#newNoteHint"),
  cancelNewNoteButton: document.querySelector("#cancelNewNoteButton"),
  createFolderDialog: document.querySelector("#createFolderDialog"),
  createFolderForm: document.querySelector("#createFolderForm"),
  createFolderName: document.querySelector("#createFolderName"),
  createApexTitle: document.querySelector("#createApexTitle"),
  cancelCreateFolderButton: document.querySelector("#cancelCreateFolderButton"),
  hierarchyPromptDialog: document.querySelector("#hierarchyPromptDialog"),
  copyHierarchyPromptButton: document.querySelector("#copyHierarchyPromptButton"),
  closeHierarchyPromptButton: document.querySelector("#closeHierarchyPromptButton"),
  deleteConfirmDialog: document.querySelector("#deleteConfirmDialog"),
  deleteConfirmTitle: document.querySelector("#deleteConfirmTitle"),
  deleteConfirmMessage: document.querySelector("#deleteConfirmMessage"),
  deleteConfirmDetail: document.querySelector("#deleteConfirmDetail"),
  cancelDeleteButton: document.querySelector("#cancelDeleteButton"),
  confirmDeleteButton: document.querySelector("#confirmDeleteButton"),
  graphCreatePopover: document.querySelector("#graphCreatePopover"),
  graphNewTitle: document.querySelector("#graphNewTitle"),
  cancelGraphCreateButton: document.querySelector("#cancelGraphCreateButton")
};

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

initializeEditor();
bindEvents();
startEmpty();

function initializeEditor() {
  state.editorView = new EditorView({
    parent: els.editor,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        wikiLinkField,
        editorEditable.of(EditorView.editable.of(false)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || state.editorHydrating) return;
          markSelectedDirty();
        }),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
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

function bindEvents() {
  els.graphHelpButton.addEventListener("click", openGraphHelpDialog);
  els.closeGraphHelpButton.addEventListener("click", closeGraphHelpDialog);
  els.openFolderButton.addEventListener("click", openNotesFolder);
  els.createFolderButton.addEventListener("click", openCreateFolderDialog);
  els.workspaceTabs.addEventListener("click", onWorkspaceTabsClick);
  els.graphWorkspaceName.addEventListener("input", syncGraphWorkspaceNameSize);
  els.graphWorkspaceName.addEventListener("blur", () => {
    void renameActiveWorkspace();
  });
  els.graphWorkspaceName.addEventListener("keydown", onGraphWorkspaceNameKeydown);
  els.newNoteButton.addEventListener("click", openNewNoteDialog);
  els.zoomInButton.addEventListener("click", () => zoomAtCenter(1.18));
  els.zoomOutButton.addEventListener("click", () => zoomAtCenter(1 / 1.18));
  els.resetViewButton.addEventListener("click", () => fitGraphView());
  els.fullscreenGraphButton.addEventListener("click", toggleGraphFullscreen);
  els.cancelNewNoteButton.addEventListener("click", () => closeNewNoteDialog());
  els.cancelCreateFolderButton.addEventListener("click", () => closeCreateFolderDialog());
  els.closeHierarchyPromptButton.addEventListener("click", () => closeHierarchyPromptDialog());
  els.copyHierarchyPromptButton.addEventListener("click", () => copyHierarchyPrompt());
  els.cancelDeleteButton.addEventListener("click", () => settleDeleteConfirm(false));
  els.confirmDeleteButton.addEventListener("click", () => settleDeleteConfirm(true));
  els.deleteConfirmDialog.addEventListener("close", () => settleDeleteConfirm(false));
  els.newNoteParent.addEventListener("change", updateNewNoteHint);
  els.newNoteForm.addEventListener("submit", createNewNote);
  els.createFolderForm.addEventListener("submit", createGraphFolder);
  els.infoTitle.addEventListener("input", onInfoChanged);
  els.infoParent.addEventListener("change", onInfoChanged);
  els.deleteNoteButton.addEventListener("click", deleteSelectedNote);
  els.graphCreatePopover.addEventListener("submit", createPendingGraphNode);
  els.cancelGraphCreateButton.addEventListener("click", closeGraphCreatePopover);

  els.searchInput.addEventListener("input", () => {
    setSearchFilter(els.searchInput.value);
    applyGraphDimming();
    scheduleLabelVisibilityRefresh({ force: true });
    scheduleLargeGraphRefresh();
  });

  els.graph.addEventListener("wheel", onGraphWheel, { passive: false });
  els.graph.addEventListener("dblclick", openGraphCreatePopover);
  els.graph.addEventListener("pointerdown", startGraphPointerDown);
  els.graph.addEventListener("pointerover", onGraphPointerOver);
  els.graph.addEventListener("pointerout", onGraphPointerOut);
  els.graph.addEventListener("focusin", onGraphFocusIn);
  els.graph.addEventListener("focusout", onGraphFocusOut);
  els.graph.addEventListener("pointermove", queueInteraction);
  els.graph.addEventListener("pointerup", endInteraction);
  els.graph.addEventListener("pointercancel", cancelInteraction);
  els.graph.addEventListener("keydown", onGraphKeydown);
  els.graph.addEventListener("dragover", onGraphDragOver);
  els.graph.addEventListener("dragleave", onGraphDragLeave);
  els.graph.addEventListener("drop", onGraphDrop);
  document.addEventListener("keydown", onDocumentKeydown);
  window.addEventListener("resize", scheduleResizeRender);
  document.addEventListener("fullscreenchange", syncGraphFullscreenState);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeGraphCreatePopover();
      if (state.pendingNode && !state.activeInteraction) {
        state.pendingNode = null;
        requestGraphRender({ preserveView: true });
        setStatus("New graph node canceled");
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

function toggleGraphFullscreen() {
  if (document.body.classList.contains("graphFullscreen")) {
    exitGraphFullscreen();
    return;
  }

  enterGraphFullscreen();
}

function enterGraphFullscreen() {
  closeGraphCreatePopover();
  document.body.classList.add("graphFullscreen");
  state.graphFullscreenFallback = !els.graphPane.requestFullscreen;
  syncGraphFullscreenButton();
  requestGraphRender({ preserveView: true });

  if (els.graphPane.requestFullscreen && !document.fullscreenElement) {
    els.graphPane.requestFullscreen().catch(() => {
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

  if (document.fullscreenElement === els.graphPane && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {
      syncGraphFullscreenState();
    });
  }
}

function syncGraphFullscreenState() {
  const isFullscreen = document.fullscreenElement === els.graphPane || (
    state.graphFullscreenFallback &&
    document.body.classList.contains("graphFullscreen") &&
    !document.fullscreenElement
  );
  if (document.fullscreenElement === els.graphPane) {
    state.graphFullscreenFallback = false;
  }
  document.body.classList.toggle("graphFullscreen", isFullscreen);
  syncGraphFullscreenButton();
  requestGraphRender({ preserveView: true });
}

function syncGraphFullscreenButton() {
  const isFullscreen = document.body.classList.contains("graphFullscreen");
  els.fullscreenGraphButton.textContent = isFullscreen ? "Exit full screen" : "Full screen";
  els.fullscreenGraphButton.setAttribute("aria-pressed", String(isFullscreen));
}

function updateGraphTitle() {
  const isEditingName = document.activeElement === els.graphWorkspaceName;
  const workspaceName = state.workspaceName || "Folder";
  els.graphWorkspaceName.disabled = !hasWritableWorkspace();
  els.graphWorkspaceName.placeholder = workspaceName;
  if (!isEditingName) {
    els.graphWorkspaceName.value = workspaceName;
  }
  syncGraphWorkspaceNameSize();
}

function syncGraphWorkspaceNameSize() {
  const value = els.graphWorkspaceName.value || els.graphWorkspaceName.placeholder || "Folder";
  els.graphWorkspaceName.size = Math.max(4, Math.min(value.length, 34));
}

function onGraphWorkspaceNameKeydown(event) {
  event.stopPropagation();
  if (event.key === "Enter") {
    event.preventDefault();
    els.graphWorkspaceName.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    updateGraphTitle();
    els.graphWorkspaceName.blur();
  }
}

async function renameActiveWorkspace() {
  if (!hasWritableWorkspace()) {
    updateGraphTitle();
    return;
  }

  const requestedName = els.graphWorkspaceName.value.trim();
  if (!requestedName || requestedName === state.workspaceName) {
    updateGraphTitle();
    return;
  }

  const previousRootPath = state.rootPath;
  els.graphWorkspaceName.disabled = true;
  stopLiveSync();

  try {
    if (state.dirty) {
      await flushAutosave();
      if (state.dirty) {
        throw new Error("Save the current note before renaming the folder.");
      }
    }

    const workspace = await invokeNative("rename_workspace", {
      rootPath: previousRootPath,
      folderName: requestedName
    });
    setNativeWorkspace(workspace, "Renamed folder", { previousRootPath });
  } catch (error) {
    setStatus(`Could not rename folder: ${String(error)}`);
    updateGraphTitle();
    startLiveSync();
  }
}

function onWorkspaceTabsClick(event) {
  const openButton = event.target.closest("[data-open-workspace]");
  if (openButton) {
    event.preventDefault();
    void openNotesFolder();
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
    void switchWorkspaceTab(switchButton.dataset.switchWorkspace);
  }
}

function startEmpty() {
  stopLiveSync();
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
  state.dirty = false;
  state.saveToken += 1;
  state.fileSignatures = new Map();
  cancelQueuedGraphRender();
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  state.filter = "";
  state.searchMatchedPaths = new Set();
  state.validation = [];
  state.layoutKey = "";
  state.graphHasHierarchy = true;
  state.hierarchyPromptShown = false;
  state.manualPositions = {};
  state.autoPositions = new Map();
  state.positions = new Map();
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
  state.pendingNode = null;
  state.nodeClipboard = null;
  state.lastGraphPoint = null;
  state.activeInteraction = null;
  cancelQueuedInteraction();
  state.graphViewport = null;
  els.searchInput.value = "";
  renderSelectedNote("Open or create a folder");
  renderNewNoteParents();
  renderGraph({ preserveView: false });
  updateSourceStatus();
  renderValidationStatus();
  renderWorkspaceTabs();
}

async function openNotesFolder() {
  if (!isTauriApp()) {
    setStatus("Open the Tauri app to use local folders");
    return;
  }

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  try {
    const rootPath = await pickNativeDirectory();
    if (!rootPath) return;
    const workspace = await invokeNative("read_workspace", { rootPath });
    setNativeWorkspace(workspace, "Loaded from folder");
  } catch (error) {
    if (error && error.name !== "AbortError") {
      setStatus("Could not open folder");
      console.error(error);
    }
  }
}

async function openCreateFolderDialog() {
  if (!isTauriApp()) {
    setStatus("Open the Tauri app to create folders");
    return;
  }

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

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

async function createGraphFolder(event) {
  event.preventDefault();

  const requestedFolder = slugify(els.createFolderName.value.trim()) || "apex-notes";
  const apexTitle = els.createApexTitle.value.trim() || "Apex";

  try {
    setStatus("Choose a parent folder");
    const parentPath = await pickNativeDirectory();
    if (!parentPath) return;
    const workspace = await invokeNative("create_workspace", {
      parentPath,
      folderName: requestedFolder,
      apexTitle
    });
    setNativeWorkspace(workspace, "Created folder");
    closeCreateFolderDialog();
  } catch (error) {
    if (error && error.name !== "AbortError") {
      setStatus("Could not create folder");
      console.error(error);
    }
  }
}

function isTauriApp() {
  return Boolean(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.dialog);
}

async function pickNativeDirectory() {
  const selected = await window.__TAURI__.dialog.open({
    directory: true,
    recursive: true,
    multiple: false,
    canCreateDirectories: true
  });
  return Array.isArray(selected) ? selected[0] : selected;
}

async function invokeNative(command, args = {}) {
  return window.__TAURI__.core.invoke(command, args);
}

function fileSignature(file) {
  if (file && file.signature) return String(file.signature);
  const modified = Number(file && file.modifiedMs) || 0;
  const bytes = Number(file && file.byteLen) || 0;
  return `${modified}:${bytes}`;
}

function buildFileSignatureMap(files = []) {
  const signatures = new Map();
  for (const file of files || []) {
    if (!file || !file.path) continue;
    signatures.set(file.path, fileSignature(file));
  }
  return signatures;
}

function cloneFileSignatures(signatures) {
  if (signatures instanceof Map) {
    return new Map(signatures);
  }
  if (signatures && typeof signatures === "object") {
    return new Map(Object.entries(signatures));
  }
  return new Map();
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
    if (state.dirty || state.saveTimer || state.activeInteraction) return;

    const statuses = await invokeNative("list_note_files", {
      notesPath: state.notesPath
    });
    if (token !== state.liveSyncToken || !canLiveSyncWorkspace()) return;

    const nextSignatures = buildFileSignatureMap(statuses);
    const pathsToRead = [];
    const deletedPaths = [];

    for (const file of statuses || []) {
      if (!file || !file.path) continue;
      if (state.fileSignatures.get(file.path) === nextSignatures.get(file.path)) continue;
      pathsToRead.push(file.path);
    }

    for (const path of state.fileSignatures.keys()) {
      if (!nextSignatures.has(path)) {
        deletedPaths.push(path);
      }
    }

    if (!pathsToRead.length && !deletedPaths.length) {
      state.fileSignatures = nextSignatures;
      saveActiveWorkspaceState();
      return;
    }

    if (state.dirty || state.saveTimer || state.activeInteraction) return;

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
      state.activeInteraction
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

  for (const file of files || []) {
    if (!file || !file.path) continue;
    const existing = state.byPath.get(file.path);
    if (existing && existing.raw === file.raw) continue;

    const note = parseNote(file.path, file.raw);
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
    return;
  }

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
  normalizeSelectionAfterNotesChanged();

  renderCurrentSelection(liveUpdateStatus(added.size, changed.size, deletedSet.size));
  renderNewNoteParents();
  renderGraph({ preserveView: true });
  updateSourceStatus();
  maybeShowHierarchyPrompt();
  renderValidationStatus();
  saveActiveWorkspaceState();
}

function liveUpdateStatus(added, changed, removed) {
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (changed) parts.push(`${changed} changed`);
  if (removed) parts.push(`${removed} removed`);
  return `Live updated: ${parts.join(", ")}`;
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

function setNativeWorkspace(workspace, statusMessage, { previousRootPath } = {}) {
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
  target.fileSignatures = buildFileSignatureMap(workspace.notes || []);
  target.dirty = false;
  const targetNotePaths = new Set(target.notes.map((note) => note.path));
  target.manualPositions = existing
    ? pruneStoredPositions(existing.manualPositions, targetNotePaths)
    : readStoredPositions(workspace.positions || {}, layoutKey, targetNotePaths);

  if (!existing) {
    state.workspaces.push(target);
  }

  restoreWorkspaceState(target, statusMessage, { preserveView: target.hasView });
}

function hasWritableWorkspace() {
  return state.source === "folder" && Boolean(state.notesPath);
}

function hasEmptyWritableWorkspace() {
  return hasWritableWorkspace() && state.notes.length === 0;
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

  workspace.notes = state.notes;
  workspace.selectedPath = state.selectedPath;
  workspace.selectedPaths = [...state.selectedPaths].filter((path) => state.notePaths.has(path));
  workspace.rootPath = state.rootPath;
  workspace.notesPath = state.notesPath;
  workspace.source = state.source;
  workspace.workspaceName = state.workspaceName;
  workspace.dirty = state.dirty;
  workspace.fileSignatures = cloneFileSignatures(state.fileSignatures);
  workspace.filter = state.filter;
  workspace.layoutKey = state.layoutKey;
  workspace.manualPositions = pruneStoredPositions(state.manualPositions);
  workspace.graphHasHierarchy = state.graphHasHierarchy;
  workspace.hierarchyPromptShown = state.hierarchyPromptShown;
  workspace.hierarchyPromptText = state.hierarchyPromptText;
  workspace.view = { ...state.view };
  workspace.hasView = true;
}

function restoreWorkspaceState(workspace, statusMessage, { preserveView } = { preserveView: true }) {
  stopLiveSync();
  closeGraphCreatePopover();
  cancelQueuedGraphRender();
  cancelLabelVisibilityRefresh();
  cancelQueuedInteraction();
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }

  state.activeWorkspaceId = workspace.id;
  state.notes = workspace.notes || [];
  state.graphIndex = null;
  state.searchIndex = null;
  state.selectedPath = workspace.selectedPath || null;
  state.selectedPaths = new Set(workspace.selectedPaths || []);
  state.rootPath = workspace.rootPath || "";
  state.notesPath = workspace.notesPath || "";
  state.source = workspace.source || "folder";
  state.workspaceName = workspace.workspaceName || workspace.rootPath || "Folder";
  state.dirty = Boolean(workspace.dirty);
  state.saveToken += 1;
  state.fileSignatures = cloneFileSignatures(workspace.fileSignatures);
  state.filter = workspace.filter || "";
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
  state.pendingNode = null;
  state.activeInteraction = null;
  state.hoveredPath = null;
  state.focusedPath = null;
  state.autoPositions = new Map();
  state.positions = new Map();
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

  rebuildIndex();
  state.validation = validateNotes();
  normalizeSelectionAfterNotesChanged();

  els.searchInput.value = state.filter;
  renderCurrentSelection(statusMessage);
  renderNewNoteParents();
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

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  saveActiveWorkspaceState();
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return;
  restoreWorkspaceState(workspace, "Loaded from tab", { preserveView: true });
}

async function closeWorkspaceTab(workspaceId) {
  const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (index === -1) return;

  if (workspaceId === state.activeWorkspaceId && state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  saveActiveWorkspaceState();
  state.workspaces.splice(index, 1);

  if (workspaceId !== state.activeWorkspaceId) {
    renderWorkspaceTabs();
    return;
  }

  const nextWorkspace = state.workspaces[Math.min(index, state.workspaces.length - 1)];
  if (nextWorkspace) {
    restoreWorkspaceState(nextWorkspace, "Closed folder tab", { preserveView: true });
  } else {
    startEmpty();
  }
}

function renderWorkspaceTabs() {
  const fragment = document.createDocumentFragment();

  for (const workspace of state.workspaces) {
    const isActive = workspace.id === state.activeWorkspaceId;
    const isDirty = isActive ? state.dirty : workspace.dirty;
    const tab = document.createElement("div");
    tab.className = `workspaceTab${isActive ? " active" : ""}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(isActive));
    tab.title = workspace.rootPath || workspace.workspaceName || "Folder";

    const switchButton = document.createElement("button");
    switchButton.className = "workspaceTabMain";
    switchButton.type = "button";
    switchButton.dataset.switchWorkspace = workspace.id;

    const title = document.createElement("span");
    title.className = "workspaceTabTitle";
    title.textContent = workspace.workspaceName || "Folder";
    switchButton.appendChild(title);

    if (isDirty) {
      const dirty = document.createElement("span");
      dirty.className = "workspaceTabDirty";
      dirty.textContent = "*";
      switchButton.appendChild(dirty);
    }

    const closeButton = document.createElement("button");
    closeButton.className = "workspaceTabClose";
    closeButton.type = "button";
    closeButton.dataset.closeWorkspace = workspace.id;
    closeButton.setAttribute("aria-label", `Close ${workspace.workspaceName || "folder"}`);
    closeButton.title = `Close ${workspace.workspaceName || "folder"}`;

    tab.append(switchButton, closeButton);
    fragment.appendChild(tab);
  }

  if (state.workspaces.length) {
    const addButton = document.createElement("button");
    addButton.className = "workspaceTabAdd";
    addButton.type = "button";
    addButton.dataset.openWorkspace = "true";
    addButton.setAttribute("aria-label", "Open another notes folder");
    addButton.title = "Open another notes folder";
    addButton.textContent = "+";
    fragment.appendChild(addButton);
  }

  els.workspaceTabs.replaceChildren(fragment);
}

function rebuildIndex() {
  state.byPath = new Map();
  state.byKey = new Map();
  state.notePaths = new Set();

  for (const note of state.notes) {
    state.byPath.set(note.path, note);
    state.notePaths.add(note.path);
  }

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
  state.searchIndex = createSearchIndex(state.notes);
  updateSearchMatchedPaths();
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
    note.declaredLevel = vertex ? vertex.declaredLevel : (note.hasLevel ? note.level : null);
    note.derivedLevel = vertex ? vertex.derivedLevel : null;
    const inferredRootWithoutLevel =
      vertex &&
      vertex.derivedLevel === 0 &&
      !note.hasLevel &&
      !cleanWikiRef(note.parentRef);
    if (vertex && Number.isFinite(vertex.derivedLevel) && !inferredRootWithoutLevel) {
      note.level = vertex.derivedLevel;
    } else if (Number.isFinite(note.declaredLevel)) {
      note.level = note.declaredLevel;
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
    if (!note.hasFrontmatter || !note.hasLevel || !note.hasTitle) {
      return false;
    }
  }

  if (state.graphIndex && state.graphIndex.validation.length) {
    return false;
  }

  return true;
}

function isValidApex(note) {
  if (!note || cleanWikiRef(note.parentRef) || !note.hasLevel) return false;
  if (state.graphIndex && state.graphIndex.derivedLevels.has(note.path)) {
    return state.graphIndex.derivedLevels.get(note.path) === 0;
  }
  return Boolean(note.hasLevel && note.level === 0);
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
    note.hasLevel &&
    parent.hasLevel &&
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
  return Boolean(note && (!note.hasFrontmatter || !note.hasTitle || !hasUsableHierarchySlot(note)));
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

function parseNote(path, raw) {
  const parsed = splitMarkdown(raw);
  const frontmatter = parseFrontmatter(parsed.frontmatterRaw);
  const body = parsed.body;
  const pathNoExt = path.replace(/\.md$/i, "");
  const basename = pathNoExt.split("/").pop();
  const heading = body.match(/^#\s+(.+)$/m);
  const title = frontmatter.values.title || (heading && heading[1].trim()) || basename;
  const level = Number.parseInt(frontmatter.values.level, 10);
  const bodyRefs = parseWikiRefs(body);
  const searchText = `${title} ${path} ${raw}`.toLowerCase();

  const keys = new Set(getNoteAliasKeys(path, title));

  return {
    path,
    pathNoExt,
    basename,
    title,
    level: Number.isFinite(level) ? level : 4,
    declaredLevel: Number.isFinite(level) ? level : null,
    derivedLevel: null,
    rawLevel: frontmatter.values.level,
    hasFrontmatter: parsed.hasFrontmatter,
    hasLevel: Object.prototype.hasOwnProperty.call(frontmatter.values, "level") && Number.isFinite(level),
    hasTitle: Object.prototype.hasOwnProperty.call(frontmatter.values, "title"),
    parentRef: frontmatter.values.parent || null,
    raw,
    frontmatterRaw: parsed.frontmatterRaw,
    frontmatterEntries: frontmatter.entries,
    frontmatterValues: frontmatter.values,
    body,
    bodyRefs,
    bodyRefNotes: [],
    searchText,
    keys: [...keys],
    parentNote: null,
    children: []
  };
}

function splitMarkdown(raw) {
  if (!raw.startsWith("---")) {
    return {
      hasFrontmatter: false,
      frontmatterRaw: "",
      body: raw
    };
  }

  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) {
    return {
      hasFrontmatter: false,
      frontmatterRaw: "",
      body: raw
    };
  }

  const frontmatterRaw = raw.slice(3, endIndex).replace(/^\n/, "").replace(/\s+$/, "");
  const body = raw.slice(endIndex + 4).replace(/^\s*\n/, "");
  return {
    hasFrontmatter: true,
    frontmatterRaw,
    body
  };
}

function parseFrontmatter(raw) {
  const lines = raw ? raw.split("\n") : [];
  const entries = [];
  const values = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      entries.push({ key: null, lines: [line] });
      index += 1;
      continue;
    }

    const key = match[1];
    const entryLines = [line];
    index += 1;
    while (index < lines.length && !lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)) {
      entryLines.push(lines[index]);
      index += 1;
    }
    entries.push({ key, lines: entryLines });
    values[key] = stripQuotes(match[2].trim());
  }

  return { entries, values };
}

function resolveParent(note) {
  const ref = cleanWikiRef(note.parentRef);
  if (!ref) return null;
  return resolveWikiNote(ref);
}

function resolveWikiNote(ref) {
  if (state.graphIndex) {
    const path = state.graphIndex.resolvePath(ref);
    if (path) return state.byPath.get(path) || null;
  }
  return state.byKey.get(normalizeKey(ref)) || state.byKey.get(normalizeKey(slugify(ref))) || null;
}

function validateNotes() {
  const issues = [];
  const titleCounts = new Map();

  for (const note of state.notes) {
    const titleKey = normalizeKey(note.title);
    if (!titleCounts.has(titleKey)) titleCounts.set(titleKey, []);
    titleCounts.get(titleKey).push(note);

    if (!note.hasFrontmatter) {
      issues.push({ type: "frontmatter", note, message: `${note.title} is missing frontmatter` });
    }

    if (!note.hasTitle) {
      issues.push({ type: "frontmatter", note, message: `${note.title} is missing a title` });
    }

    if (!note.hasLevel) {
      issues.push({ type: "level", note, message: `${note.title} is missing a valid level` });
    }
  }

  for (const matches of titleCounts.values()) {
    if (matches.length < 2) continue;
    for (const note of matches) {
      issues.push({ type: "duplicate", note, message: `${note.title} title is duplicated` });
    }
  }

  if (state.graphIndex) {
    for (const issue of state.graphIndex.validation) {
      issues.push(graphIssueToValidation(issue));
    }
  }

  return issues;
}

function graphIssueToValidation(issue) {
  const path = issue.path || (Array.isArray(issue.paths) ? issue.paths[0] : null);
  const note = path ? state.byPath.get(path) || null : null;
  let type = "parent";

  if (issue.type === ISSUE_TYPES.LEVEL_MISMATCH) {
    type = "level";
  } else if (issue.type === ISSUE_TYPES.DUPLICATE_ALIAS) {
    type = "duplicate";
  }

  return {
    type,
    note,
    graphIssue: issue,
    message: issue.message || "Hierarchy issue"
  };
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
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

  const previousSelection = new Set(state.selectedPaths);
  state.selectedPath = path;
  state.selectedPaths = new Set([path]);
  state.dirty = false;
  renderSelectedNote(state.source === "folder" ? "Loaded" : "Read-only");
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
      .filter((path) => path !== PENDING_PATH)
      .filter((path) => state.byPath.has(path))
  );

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
  setEditorBody("");
  renderInfoPanel(null);
  setStatus(statusMessage || selectionStatus(count));
}

function selectionStatus(count) {
  if (!count) return "No graph selection";
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

  if (!note) {
    els.noteTitle.textContent = "Select a note";
    els.notePath.textContent = "";
    setEditorBody("");
    renderInfoPanel(null);
    setStatus(statusMessage || "No note loaded");
    return;
  }

  els.noteTitle.textContent = note.title;
  els.notePath.textContent = note.path;
  setEditorBody(note.body);
  renderInfoPanel(note);
  setStatus(statusMessage);
}

function getSelectedNote() {
  return state.byPath.get(state.selectedPath) || null;
}

function setEditorBody(body) {
  const view = state.editorView;
  state.editorHydrating = true;
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: body || ""
    },
    effects: wikiLinkRefreshEffect.of(null)
  });
  state.editorHydrating = false;
}

function getEditorBody() {
  return state.editorView ? state.editorView.state.doc.toString() : "";
}

function refreshEditorDecorations() {
  if (!state.editorView) return;
  state.editorView.dispatch({ effects: wikiLinkRefreshEffect.of(null) });
}

function renderInfoPanel(note) {
  state.infoHydrating = true;

  if (!note) {
    els.infoTitle.value = "";
    els.infoParent.innerHTML = "";
    els.infoLevel.value = "";
    els.deleteNoteButton.disabled = !canDeleteCurrentSelection();
    els.noteInfo.open = false;
    state.infoHydrating = false;
    return;
  }

  els.infoTitle.value = note.title;
  els.deleteNoteButton.disabled = !canDeleteCurrentSelection();
  renderInfoParents(note);
  updateInfoDerivedFields();
  state.infoHydrating = false;
}

function renderInfoParents(note) {
  const fragment = document.createDocumentFragment();
  const rootOption = document.createElement("option");
  rootOption.value = "";
  rootOption.textContent = "No parent (root / loose)";
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
  updateInfoDerivedFields();
  const note = getSelectedNote();
  if (note) {
    els.noteTitle.textContent = els.infoTitle.value.trim() || note.title;
  }
  markSelectedDirty();
}

function updateInfoDerivedFields() {
  const parent = state.byPath.get(els.infoParent.value) || null;
  const level = parent ? parent.level + 1 : 0;
  els.infoLevel.value = String(level);
}

function getInfoValues(note) {
  const parent = state.byPath.get(els.infoParent.value) || null;
  const level = parent ? parent.level + 1 : 0;
  return {
    title: els.infoTitle.value.trim() || note.title,
    level,
    parentRef: parent ? `[[${parent.basename}]]` : null
  };
}

function markSelectedDirty() {
  if (!state.selectedPath || state.source !== "folder") return;
  state.dirty = true;
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
    setStatus("Open notes folder to delete notes");
    return false;
  }

  const deleting = new Set(notes.map((note) => note.path));
  const childCount = state.notes.filter((note) => note.parentNote && deleting.has(note.parentNote.path) && !deleting.has(note.path)).length;
  if (!(await confirmDeleteNotes(notes, childCount))) return false;

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
  }

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
    const parentStillExists = deletedParent && state.notes.some((item) => item.path === deletedParent.path);
    const nextPath = notes.length === 1
      ? ((parentStillExists && deletedParent.path) || (state.notes[0] && state.notes[0].path) || null)
      : null;
    state.selectedPath = nextPath;
    state.selectedPaths = nextPath ? new Set([nextPath]) : new Set();
    state.dirty = false;
    rebuildIndex();
    state.validation = validateNotes();
    void savePositionPatch(positionRemovalPatch(deletedPaths));
    await updateManifestFile();
    renderCurrentSelection(`Moved ${notes.length} note${notes.length === 1 ? "" : "s"} to Trash`);
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    updateSourceStatus();
    renderValidationStatus();
    return true;
  } catch (error) {
    setStatus("Could not delete note");
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
    setStatus("Open notes folder to edit");
    return;
  }

  const raw = composeRaw(note, getEditorBody(), getInfoValues(note));
  const path = note.path;
  const token = ++state.saveToken;
  setStatus("Saving...");

  try {
    await invokeNative("write_note", {
      notesPath: state.notesPath,
      path,
      raw
    });
    if (token !== state.saveToken) return;

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

      els.noteTitle.textContent = updated.title;
      els.notePath.textContent = updated.path;
      renderInfoPanel(updated);
      renderNewNoteParents();
      renderGraph({ preserveView: true });
      renderValidationStatus();
    } else {
      patchBodyOnlyNote(note, updated);
      if (state.filter) {
        updateSearchMatchedPaths();
        applyGraphDimming();
        scheduleLabelVisibilityRefresh({ force: true });
        scheduleLargeGraphRefresh();
      }
    }

    updateSourceStatus();
    setStatus("Saved automatically");
  } catch (error) {
    state.dirty = true;
    setStatus("Autosave failed");
    console.error(error);
  }
}

function composeRaw(note, body, values) {
  const knownKeys = new Set(["title", "level", "parent", "group"]);
  const lines = [
    `title: "${escapeYaml(values.title)}"`,
    `level: ${values.level}`,
    values.parentRef ? `parent: "${escapeYaml(values.parentRef)}"` : "parent: null"
  ];

  for (const entry of note.frontmatterEntries || []) {
    if (!entry.key || knownKeys.has(entry.key)) continue;
    lines.push(...entry.lines);
  }

  const cleanBody = body || "";
  return `---\n${lines.join("\n")}\n---\n\n${cleanBody}${cleanBody.endsWith("\n") ? "" : "\n"}`;
}

function noteNeedsFullRefresh(current, updated) {
  return (
    current.title !== updated.title ||
    current.level !== updated.level ||
    current.parentRef !== updated.parentRef ||
    current.hasFrontmatter !== updated.hasFrontmatter ||
    current.hasLevel !== updated.hasLevel ||
    current.hasTitle !== updated.hasTitle ||
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
  note.declaredLevel = updated.declaredLevel;
  note.derivedLevel = updated.derivedLevel;
  note.rawLevel = updated.rawLevel;
  note.hasFrontmatter = updated.hasFrontmatter;
  note.hasLevel = updated.hasLevel;
  note.hasTitle = updated.hasTitle;
  note.body = updated.body;
  note.bodyRefs = updated.bodyRefs;
  note.searchText = updated.searchText;
  state.searchIndex = createSearchIndex(state.notes);
}

function createNoteRaw({ title, level, parent, body }) {
  return [
    "---",
    `title: "${escapeYaml(title)}"`,
    `level: ${level}`,
    parent ? `parent: "[[${parent.basename}]]"` : "parent: null",
    "---",
    "",
    body || `# ${title}\n`
  ].join("\n");
}

function renderGraph({ preserveView } = { preserveView: true }) {
  const perf = startPerfMeasure("renderGraph");
  cancelQueuedGraphRender();
  const viewportWidth = Math.max(320, els.graphScroller.clientWidth || 0);
  const viewportHeight = Math.max(320, els.graphScroller.clientHeight || 0);
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
  state.selectionRectElement = null;

  const notes = getRenderableNotes();
  state.positions = buildPositions(notes);
  if (state.pendingNode) {
    state.positions.set(PENDING_PATH, state.pendingNode.position);
  }
  state.graphBounds = getGraphBounds(state.positions);
  state.spatialIndex = buildSpatialIndex(notes);
  state.labelVisibilityKey = "";

  if (!notes.length && !state.pendingNode) {
    els.graph.appendChild(canvas);
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "text");
    empty.setAttribute("class", "emptyGraphText");
    empty.setAttribute("x", String(viewportWidth / 2));
    empty.setAttribute("y", String(viewportHeight / 2));
    empty.textContent = hasEmptyWritableWorkspace()
      ? "Click anywhere to create your first note"
      : "Open folder or create folder";
    els.graph.appendChild(empty);
    applyViewTransform();
    updateLabelVisibility({ force: true });
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
    edge.setAttribute("class", `edge hierarchyEdge${isDimmed(note) || isDimmed(note.parentNote) ? " dimmed" : ""}`);
    edge.setAttribute("aria-hidden", "true");
    edge.style.setProperty("--level-color", getLevelColor(note.level));
    fragment.appendChild(edge);
    registerGraphEdge({ path: edge, from: note.parentNote.path, to: note.path, type: "hierarchy" });
  }

  for (const referenceEdge of getRenderableReferenceEdges(notes)) {
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
    edge.setAttribute("class", `edge referenceEdge${referenceEdge.dimmed ? " dimmed" : ""}`);
    edge.setAttribute("aria-hidden", "true");
    edge.style.setProperty("--level-color", getLevelColor(referenceEdge.level));
    fragment.appendChild(edge);
    registerGraphEdge({ path: edge, from: referenceEdge.from, to: referenceEdge.to, type: "reference" });
  }

  state.labelVisibility = state.largeGraphMode ? computeLargeGraphLabelVisibility() : null;

  for (const note of notes) {
    renderGraphNode(fragment, note);
  }

  if (state.pendingNode) {
    renderPendingNode(fragment);
  }

  canvas.appendChild(fragment);
  els.graph.appendChild(canvas);
  applyViewTransform();
  updateGraphGeometry();
  updateLabelVisibility({ force: true });
  finishPerfMeasure(perf);
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

let resizeDebounceTimer = 0;
function scheduleResizeRender() {
  if (resizeDebounceTimer) {
    window.clearTimeout(resizeDebounceTimer);
  }
  resizeDebounceTimer = window.setTimeout(() => {
    resizeDebounceTimer = 0;
    requestGraphRender({ preserveView: true });
  }, 120);
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

let largeGraphRefreshTimer = 0;
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
  for (const path of new Set([...previous, ...next])) {
    const group = state.nodeElements.get(path);
    if (!group) continue;
    const isSelected = next.has(path);
    group.classList.toggle("selected", isSelected);
    group.setAttribute("aria-pressed", String(isSelected));
    const dot = group.querySelector(".nodeDot");
    if (dot) {
      dot.setAttribute("r", String(isSelected ? SELECTED_DOT_RADIUS : DOT_RADIUS));
    }
  }
}

function applyGraphDimming() {
  for (const [path, group] of state.nodeElements.entries()) {
    if (path === PENDING_PATH) continue;
    const note = state.byPath.get(path);
    if (note) {
      group.classList.toggle("dimmed", isDimmed(note));
      group.classList.toggle("search-matched", isSearchMatched(note));
    }
  }

  for (const edge of state.edgeElements) {
    const from = state.byPath.get(edge.from);
    const to = state.byPath.get(edge.to);
    edge.path.classList.toggle("dimmed", Boolean((from && isDimmed(from)) || (to && isDimmed(to))));
  }
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
        focusedPath: state.focusedPath,
        searchMatchedPaths: getSearchMatchedPaths()
      },
      {
        maxEdgeCount: LARGE_GRAPH_CONFIG.referenceEdgeLimit
      }
    );
  }

  return edges.map((edge) => {
    const from = state.byPath.get(edge.from);
    const to = state.byPath.get(edge.to);
    return {
      ...edge,
      dimmed: Boolean((from && isDimmed(from)) || (to && isDimmed(to)))
    };
  });
}

function undirectedPairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function renderGraphNode(canvas, note) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const classes = ["node"];
  const loose = isLooseHierarchyNote(note);
  if (state.selectedPaths.has(note.path)) classes.push("selected");
  if (isDimmed(note)) classes.push("dimmed");
  if (loose) classes.push("looseNode");
  group.setAttribute("class", classes.join(" "));
  group.style.setProperty("--level-color", getLevelColor(note.level));
  group.setAttribute("tabindex", "0");
  group.setAttribute("role", "button");
  group.setAttribute("aria-pressed", String(state.selectedPaths.has(note.path)));
  group.setAttribute("aria-label", loose ? `${note.title}, loose note` : note.title);
  if (loose) group.setAttribute("title", "Drag to another node to connect");
  group.setAttribute("data-path", note.path);

  const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hit.setAttribute("class", "nodeHit");
  hit.setAttribute("r", String(HIT_RADIUS));
  group.appendChild(hit);

  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("class", "nodeDot");
  dot.setAttribute("r", String(state.selectedPaths.has(note.path) ? SELECTED_DOT_RADIUS : DOT_RADIUS));
  group.appendChild(dot);

  if (shouldRenderInitialNodeLabel(note)) {
    appendNodeLabel(group, note.title, "nodeLabel");
  }
  canvas.appendChild(group);
  state.nodeElements.set(note.path, group);
}

function renderPendingNode(canvas) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "node pendingNode");
  group.style.setProperty("--level-color", "#b88cff");
  group.setAttribute("tabindex", "0");
  group.setAttribute("role", "button");
  group.setAttribute("aria-label", `New note ${state.pendingNode.title}`);
  group.setAttribute("data-path", PENDING_PATH);

  const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hit.setAttribute("class", "nodeHit");
  hit.setAttribute("r", String(HIT_RADIUS + 4));
  group.appendChild(hit);

  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("class", "nodeDot pendingDot");
  dot.setAttribute("r", String(SELECTED_DOT_RADIUS));
  group.appendChild(dot);

  appendNodeLabel(group, state.pendingNode.title, "nodeLabel pendingLabel");
  canvas.appendChild(group);
  state.nodeElements.set(PENDING_PATH, group);
}

function appendNodeLabel(group, title, className) {
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("class", className);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("y", "30");
  const lines = wrapTitle(title);
  lines.forEach((line, index) => {
    const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
    tspan.setAttribute("x", "0");
    tspan.setAttribute("dy", index === 0 ? "0" : "15");
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
  const note = path === PENDING_PATH ? state.pendingNode : state.byPath.get(path);
  if (!note) return;
  appendNodeLabel(group, note.title, path === PENDING_PATH ? "nodeLabel pendingLabel" : "nodeLabel");
}

function removeGraphNodeLabel(group) {
  const label = group.querySelector(".nodeLabel");
  if (label) label.remove();
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
    looseColumns: Math.max(1, Math.ceil(Math.sqrt(notes.filter(isLooseHierarchyNote).length || 1))),
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
  if (!stored) return null;
  const base = autoPositions.get(path);
  if (Number.isFinite(stored.dx) || Number.isFinite(stored.dy)) {
    if (!base) return null;
    return {
      x: round(base.x + (Number(stored.dx) || 0)),
      y: round(base.y + (Number(stored.dy) || 0))
    };
  }
  if (Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
    return {
      x: round(stored.x),
      y: round(stored.y)
    };
  }
  return null;
}

function buildSquareGridPositions(notes) {
  const positions = new Map();

  const count = notes.length;
  if (!count) return positions;

  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const colMax = columns;
  const contentWidth = GRAPH_PAD * 2 + Math.max(0, colMax - 1) * NODE_GAP;

  for (let index = 0; index < count; index += 1) {
    const note = notes[index];
    const row = Math.floor(index / columns);
    const column = index % columns;
    const remainingInRow = Math.min(columns, count - row * columns);
    const startX = (contentWidth - Math.max(0, remainingInRow - 1) * NODE_GAP) / 2;
    const x = startX + column * NODE_GAP;
    const y = GRAPH_PAD + row * LEVEL_GAP;

    positions.set(note.path, {
      x,
      y
    });
  }

  return positions;
}

function getGraphBounds(positions) {
  let count = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const position of positions.values()) {
    count += 1;
    minX = Math.min(minX, position.x - 92);
    maxX = Math.max(maxX, position.x + 92);
    minY = Math.min(minY, position.y - 42);
    maxY = Math.max(maxY, position.y + 62);
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
  path.setAttribute("d", type === "reference" ? referenceEdgePath(fromPosition, toPosition) : edgePath(fromPosition, toPosition));
}

function edgePath(from, to) {
  const midY = from.y + (to.y - from.y) / 2;
  return [
    `M ${round(from.x)} ${round(from.y + DOT_RADIUS + 3)}`,
    `C ${round(from.x)} ${round(midY)}`,
    `${round(to.x)} ${round(midY)}`,
    `${round(to.x)} ${round(to.y - DOT_RADIUS - 3)}`
  ].join(" ");
}

function referenceEdgePath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const lift = clamp(distance * 0.18, 30, 92);
  const start = endpointToward(from, to, DOT_RADIUS + 9);
  const end = endpointToward(to, from, DOT_RADIUS + 9);
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

function isDimmed(note) {
  if (!state.filter) return false;
  return !state.searchMatchedPaths.has(note.path);
}

function isSearchMatched(note) {
  return Boolean(state.filter && state.searchMatchedPaths.has(note.path));
}

function getSearchMatchedPaths() {
  return state.searchMatchedPaths;
}

function setSearchFilter(value) {
  state.filter = String(value || "").trim().toLowerCase();
  updateSearchMatchedPaths();
}

function updateSearchMatchedPaths() {
  if (!state.filter) {
    state.searchMatchedPaths = new Set();
    return;
  }

  const matches = new Set(
    (state.searchIndex ? state.searchIndex.search(state.filter, {
      limit: Math.max(1, state.notes.length),
      minScore: 0,
      includeTrigramFallback: true,
      alwaysIncludeTrigram: true
    }) : [])
      .map((result) => result.path)
  );

  if (state.filter.length < 3 || !matches.size) {
    for (const note of state.notes) {
      if (note.searchText.includes(state.filter)) matches.add(note.path);
    }
  }
  state.searchMatchedPaths = matches;
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
      const visible = path !== PENDING_PATH || Boolean(state.pendingNode);
      if (visible) ensureGraphNodeLabel(group, path);
      group.classList.toggle("label-hidden", !visible);
      group.classList.toggle("label-visible", visible);
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
    const visible = path === PENDING_PATH || labelVisibility.visiblePaths.has(path);
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
    searchMatchedPaths: getSearchMatchedPaths(),
    labelRectangles: buildApproxLabelRectangles(state.sortedNotes),
    labelOverlapPadding: 6
  });
}

function buildApproxLabelRectangles(notes) {
  const rectangles = new Map();
  for (const note of notes) {
    const position = state.positions.get(note.path);
    if (!position) continue;
    const lines = wrapTitle(note.title);
    const width = Math.max(44, ...lines.map((line) => line.length * 7.2));
    const height = Math.max(18, lines.length * 15);
    rectangles.set(note.path, {
      left: position.x - width / 2,
      top: position.y + 22,
      width,
      height
    });
  }
  return rectangles;
}

function getLabelVisibilityKey() {
  const pendingKey = state.pendingNode ? "pending" : "settled";
  const sizeKey = `${state.nodeElements.size}:${state.sortedNotes.length}:${pendingKey}`;
  if (!state.largeGraphMode) return `small:${sizeKey}`;

  const policy = getLabelVisibilityPolicy(state.view.scale);
  return [
    "large",
    sizeKey,
    policy.name,
    state.selectedPath || "",
    [...state.selectedPaths].sort(compareText).join("\u001f"),
    state.hoveredPath || "",
    state.focusedPath || "",
    state.filter
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
  event.preventDefault();
  closeGraphCreatePopover();
  const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
  zoomAtPoint(event.clientX, event.clientY, factor);
}

function zoomAtCenter(factor) {
  const rect = els.graph.getBoundingClientRect();
  zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function zoomAtPoint(clientX, clientY, factor) {
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

function fitGraphView(animate = true) {
  if (!state.graphBounds || !els.graphCanvas) return;
  const previousScale = state.view.scale;
  const viewportWidth = Math.max(320, els.graphScroller.clientWidth || 0);
  const viewportHeight = Math.max(320, els.graphScroller.clientHeight || 0);
  const scale = clamp(
    Math.min(1.08, (viewportWidth - 72) / state.graphBounds.width, (viewportHeight - 72) / state.graphBounds.height),
    MIN_ZOOM,
    MAX_ZOOM
  );

  state.view.scale = scale;
  state.view.x = viewportWidth / 2 - (state.graphBounds.minX + state.graphBounds.width / 2) * scale;
  state.view.y = viewportHeight / 2 - (state.graphBounds.minY + state.graphBounds.height / 2) * scale;
  applyViewTransform(animate);
  refreshLabelsAfterZoom(previousScale);
}

function applyViewTransform(animate = false) {
  if (!els.graphCanvas) return;
  const perf = startPerfMeasure("applyViewTransform");
  els.graphCanvas.style.transition = animate ? "transform 120ms ease" : "";
  els.graphCanvas.setAttribute(
    "transform",
    `translate(${round(state.view.x)} ${round(state.view.y)}) scale(${round(state.view.scale)})`
  );
  finishPerfMeasure(perf);
}

function onGraphPointerOver(event) {
  const path = getNodePathFromEvent(event);
  if (!path || path === PENDING_PATH || path === state.hoveredPath) return;
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
  if (!path || path === PENDING_PATH || path === state.focusedPath) return;
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

function focusGraph() {
  if (document.activeElement === els.graph) return;
  els.graph.focus({ preventScroll: true });
}

function startGraphPointerDown(event) {
  if (event.button !== 0 && event.button !== 1) return;
  focusGraph();
  state.lastGraphPoint = eventToGraphPoint(event);

  if (wantsGraphPan(event)) {
    startPan(event);
    return;
  }

  const group = event.target.closest ? event.target.closest(".node") : null;
  if (group && els.graph.contains(group)) {
    const path = group.getAttribute("data-path");
    if (path === PENDING_PATH) {
      startPendingRope(event, group);
      return;
    }

    const note = state.byPath.get(path);
    if (note) {
      if (isLooseHierarchyNote(note)) {
        startLooseRope(event, note, group);
        return;
      }
      startNodeDrag(event, note, group);
      return;
    }
  }

  if (shouldStartMarqueeSelection(event)) {
    startMarqueeSelection(event);
    return;
  }

  startPan(event);
}

function onGraphKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const group = event.target.closest ? event.target.closest(".node") : null;
  if (!group || !els.graph.contains(group)) return;
  const path = group.getAttribute("data-path");
  if (!path || path === PENDING_PATH) return;
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
  return event.button === 0 && (event.shiftKey || event.metaKey || event.ctrlKey);
}

function wantsGraphPan(event) {
  return event.button === 1 || (event.button === 0 && event.altKey);
}

function startNodeDrag(event, note, group) {
  if (event.button !== 0 || state.pendingNode) return;
  event.preventDefault();
  event.stopPropagation();
  closeGraphCreatePopover();

  const point = eventToGraphPoint(event);
  const dragPaths = state.selectedPaths.has(note.path) ? [...state.selectedPaths] : [note.path];
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
    moved: false
  };
  group.classList.add("dragging");
  els.graph.classList.add("isDraggingNodes");
  els.graph.setPointerCapture(event.pointerId);
}

function startMarqueeSelection(event) {
  if (event.button !== 0 || state.pendingNode) return;
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
    additive: event.metaKey || event.ctrlKey,
    baseSelection: new Set(state.selectedPaths),
    previewSelection: new Set(state.selectedPaths)
  };
  els.graph.classList.add("isSelecting");
  els.graph.setPointerCapture(event.pointerId);
}

function startPendingRope(event, group) {
  if (event.button !== 0 || !state.pendingNode) return;
  event.preventDefault();
  event.stopPropagation();

  const start = state.positions.get(PENDING_PATH);
  const current = eventToGraphPoint(event);
  state.activeInteraction = {
    type: "rope",
    mode: "pending",
    pointerId: event.pointerId,
    sourcePath: PENDING_PATH,
    start,
    current,
    targetPath: null,
    startX: event.clientX,
    startY: event.clientY,
    moved: true
  };
  group.classList.add("ropeSource");
  ensureRopeElement();
  updateRopePath(start, current);
  els.graph.setPointerCapture(event.pointerId);
}

function startLooseRope(event, note, group) {
  if (event.button !== 0 || state.pendingNode || !isLooseHierarchyNote(note)) return;
  event.preventDefault();
  event.stopPropagation();
  closeGraphCreatePopover();

  const start = state.positions.get(note.path);
  if (!start) return;

  state.activeInteraction = {
    type: "rope",
    mode: "connect",
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
      state.manualPositions[path] = manualDeltaForPosition(path, position);
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
    if (!interaction.moved && interaction.mode === "connect") return;

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

  if (interaction.type === "node") {
    clearNodeDragClasses(interaction);
    if (interaction.moved) {
      void savePositionPatch(positionPatchForPaths(interaction.paths));
    }
    if (!interaction.moved) {
      if (state.selectedPaths.size > 1 && state.selectedPaths.has(interaction.primaryPath)) {
        renderCurrentSelection(selectionStatus(state.selectedPaths.size));
      } else {
        await selectNote(interaction.primaryPath);
      }
    } else {
      await setGraphSelection(interaction.paths, {
        openSingle: false,
        statusMessage: `Moved ${interaction.paths.length} note${interaction.paths.length === 1 ? "" : "s"}`
      });
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
    const parent = state.byPath.get(interaction.targetPath) || null;
    const child = state.byPath.get(interaction.sourcePath) || null;
    const wasClick = interaction.mode === "connect" && !interaction.moved;

    if (wasClick) {
      state.activeInteraction = null;
      clearRopeSource(interaction);
      clearRopeTarget();
      if (child) await selectNote(child.path);
      return;
    }

    if (parent) {
      state.activeInteraction = null;
      clearRopeSource(interaction);
      clearRopeTarget();
      if (interaction.mode === "connect" && child) {
        await connectLooseNoteToParent(child, parent);
      } else {
        await createNoteFromPending(parent);
      }
      return;
    }

    animateRopeBack(interaction);
    state.activeInteraction = null;
    clearRopeSource(interaction);
    clearRopeTarget();
    setStatus("Drop the rope on a parent node");
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
  rope.setAttribute("class", "pendingRope");
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
  const excludedPaths = new Set([sourcePath, PENDING_PATH].filter(Boolean));

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
  return {
    x: (point.x - state.view.x) / state.view.scale,
    y: (point.y - state.view.y) / state.view.scale
  };
}

function clientToSvgPoint(clientX, clientY) {
  const rect = els.graph.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

async function openGraphCreatePopover(event) {
  if (event.target.closest && event.target.closest(".node")) return;
  if (!hasWritableWorkspace()) {
    setStatus("Open notes folder to create notes");
    return;
  }
  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  event.preventDefault();
  state.pendingCreatePoint = eventToGraphPoint(event);
  els.graphCreatePopover.style.left = `${Math.round(event.clientX)}px`;
  els.graphCreatePopover.style.top = `${Math.round(event.clientY)}px`;
  els.graphCreatePopover.hidden = false;
  els.graphNewTitle.value = "";
  els.graphNewTitle.focus();
}

function closeGraphCreatePopover() {
  els.graphCreatePopover.hidden = true;
  state.pendingCreatePoint = null;
}

async function createPendingGraphNode(event) {
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
  state.pendingNode = {
    title,
    position
  };
  closeGraphCreatePopover();
  renderGraph({ preserveView: true });
  setStatus("Drag the purple rope to a parent node");
}

async function createNoteFromPending(parent) {
  if (!state.pendingNode || !hasWritableWorkspace()) return;

  const title = state.pendingNode.title;
  const parentPlan = getParentConnectionPlan(parent, null);
  const level = parentPlan.level + 1;
  const path = getAvailableNewNotePath(title);
  const raw = createNoteRaw({
    title,
    level,
    parent,
    body: `# ${title}\n`
  });

  try {
    if (parentPlan.raw !== parent.raw) {
      await invokeNative("write_note", {
        notesPath: state.notesPath,
        path: parent.path,
        raw: parentPlan.raw
      });
    }

    await invokeNative("create_note", {
      notesPath: state.notesPath,
      path,
      raw
    });

    const note = parseNote(path, raw);
    if (parentPlan.raw !== parent.raw) {
      replaceNoteInState(parseNote(parent.path, parentPlan.raw));
    }
    state.notes.push(note);
    state.notes.sort((a, b) => compareText(a.path, b.path));
    state.selectedPath = note.path;
    state.selectedPaths = new Set([note.path]);
    state.dirty = false;
    state.manualPositions[path] = state.pendingNode.position;
    state.pendingNode = null;
    rebuildIndex();
    state.validation = validateNotes();
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    await updateManifestFile();
    renderSelectedNote("Saved new note");
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths([path]));
    updateSourceStatus();
    renderValidationStatus();
  } catch (error) {
    setStatus("Could not create note");
    console.error(error);
  }
}

async function connectLooseNoteToParent(child, parent) {
  if (!child || !parent || child.path === parent.path || !hasWritableWorkspace()) return false;
  if (isDescendant(parent, child)) {
    setStatus("Choose a parent outside this note's child chain");
    return false;
  }

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return false;
    child = state.byPath.get(child.path);
    parent = state.byPath.get(parent.path);
    if (!child || !parent) return false;
  }

  const parentPlan = getParentConnectionPlan(parent, child);
  const childRaw = composeRaw(child, child.body, {
    title: child.title,
    level: parentPlan.level + 1,
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
    renderSelectedNote(`Connected ${child.title} under ${parent.title}`);
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    updateSourceStatus();
    renderValidationStatus();
    saveActiveWorkspaceState();
    return true;
  } catch (error) {
    setStatus("Could not connect note");
    console.error(error);
    return false;
  }
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
      level: parent.level,
      parentRef: parent.parentNote ? `[[${parent.parentNote.basename}]]` : null
    };
  }

  const apex = findFallbackApex(parent, child);
  if (apex) {
    return {
      title: parent.title,
      level: apex.level + 1,
      parentRef: `[[${apex.basename}]]`
    };
  }

  return {
    title: parent.title,
    level: 0,
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
  if (isTextEntryTarget(event.target)) return;

  const hasGraphFocus = document.activeElement === els.graph || els.graph.contains(document.activeElement);
  const hasSelection = state.selectedPaths.size > 0;
  if (!hasGraphFocus) return;

  if ((event.key === "Backspace" || event.key === "Delete") && hasSelection) {
    event.preventDefault();
    await deleteGraphSelection();
    return;
  }

  const isShortcut = (event.metaKey || event.ctrlKey) && !event.altKey;
  if (!isShortcut) return;

  const key = event.key.toLowerCase();
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
    setStatus("Open notes folder to paste notes");
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
      level,
      parent: nextParent,
      body: source.body || `# ${title}\n`
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
  const parent = getPasteParent();
  if (!parent) {
    setStatus("Select a parent note before pasting text");
    return false;
  }

  const reservedTitles = new Set(state.notes.map((note) => normalizeKey(note.title)));
  const title = getAvailableDisplayTitle(titleFromText(text), reservedTitles);
  const level = parent.level + 1;
  const path = getAvailableNewNotePath(title);
  const raw = createNoteRaw({
    title,
    level,
    parent,
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
    setStatus("Open notes folder to create notes");
    return false;
  }

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
    void savePositionPatch(positionPatchForPaths(specs.map((spec) => spec.path)));
    await updateManifestFile();
    renderCurrentSelection(statusMessage);
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    updateSourceStatus();
    renderValidationStatus();
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
  const viewportWidth = Math.max(320, els.graphScroller.clientWidth || 0);
  const viewportHeight = Math.max(320, els.graphScroller.clientHeight || 0);
  return {
    x: round((viewportWidth / 2 - state.view.x) / state.view.scale),
    y: round((viewportHeight / 2 - state.view.y) / state.view.scale)
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

function getAvailableDisplayTitle(title, reservedTitles) {
  const base = String(title || "").trim() || "Untitled note";
  let candidate = base;
  let suffix = 2;
  while (reservedTitles.has(normalizeKey(candidate))) {
    candidate = `${base} ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function titleFromText(text, fallback = "Pasted note") {
  const parsed = splitMarkdown(text);
  const frontmatter = parseFrontmatter(parsed.frontmatterRaw);
  if (frontmatter.values.title) return frontmatter.values.title;

  const body = parsed.body || text;
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return cleanTitleText(heading[1], fallback);

  return cleanTitleText(body, fallback);
}

function cleanTitleText(text, fallback) {
  const words = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]().,!?:;"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  const title = words.join(" ").slice(0, 56).trim();
  return title || fallback;
}

function bodyFromText(text, title) {
  const parsed = splitMarkdown(text);
  const body = (parsed.hasFrontmatter ? parsed.body : text).trim();
  return body ? `${body}\n` : `# ${title}\n`;
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
    setStatus("Open notes folder to drop Markdown files");
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
    const level = parent.level + 1;
    const path = getAvailableNewNotePath(title, reservedPaths);
    const raw = createNoteRaw({
      title,
      level,
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
  const patch = {};
  for (const path of paths || []) {
    const position = state.positions.get(path);
    if (!position) continue;
    patch[path] = manualDeltaForPosition(path, position);
  }
  return patch;
}

function manualDeltaForPosition(path, position) {
  const auto = state.autoPositions.get(path);
  if (!auto) {
    return {
      x: round(position.x),
      y: round(position.y)
    };
  }
  return {
    dx: round(position.x - auto.x),
    dy: round(position.y - auto.y)
  };
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
      els.validationStatus.title = "No broken parents, missing levels, or duplicate titles";
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
    counts.level ? `${counts.level} level` : "",
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
  rootOption.textContent = parents.length ? "No parent (new root / loose)" : "No parent (first root note)";
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
    setStatus("Open notes folder to create notes");
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
    els.newNoteHint.textContent = "Creates the first level 0 root note";
    return;
  }

  const parent = state.byPath.get(els.newNoteParent.value);
  if (!parent) {
    els.newNoteHint.textContent = "Creates a level 0 root or loose note";
    return;
  }

  const nextLevel = parent.level + 1;
  els.newNoteHint.textContent = `Level ${nextLevel} · parent [[${parent.basename}]]`;
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

  const level = parent ? parent.level + 1 : 0;
  const path = getAvailableNewNotePath(title);
  const raw = createNoteRaw({
    title,
    level,
    parent,
    body: `# ${title}\n`
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
    rebuildIndex();
    state.validation = validateNotes();
    await updateManifestFile();
    renderSelectedNote("Saved new note");
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    updateSourceStatus();
    renderValidationStatus();
    closeNewNoteDialog();
  } catch (error) {
    setStatus("Could not create note");
    console.error(error);
  }
}

async function createFirstNote(title, position = getGraphViewportCenter()) {
  if (!title || !hasEmptyWritableWorkspace()) return false;

  const path = getAvailableNewNotePath(title);
  const raw = createNoteRaw({
    title,
    level: 0,
    parent: null,
    body: `# ${title}\n`
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
    renderSelectedNote("Saved first note");
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    await savePositionPatch(positionPatchForPaths([path]));
    updateSourceStatus();
    renderValidationStatus();
    saveActiveWorkspaceState();
    return true;
  } catch (error) {
    setStatus("Could not create note");
    console.error(error);
    return false;
  }
}

function getAvailableNewNotePath(title, reservedPaths = state.notePaths) {
  const base = slugify(title) || "untitled";
  const existing = new Set([...reservedPaths].map((path) => path.toLowerCase()));
  let suffix = 0;

  while (true) {
    const filename = `${base}${suffix ? `-${suffix + 1}` : ""}.md`;
    if (!existing.has(filename.toLowerCase())) return filename;
    suffix += 1;
  }
}

async function updateManifestFile() {
  const paths = state.notes.map((note) => note.path).sort(compareText);
  if (!state.notesPath) return;
  await invokeNative("write_manifest", {
    notesPath: state.notesPath,
    paths
  });
}

function escapeYaml(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getLevelColor(level) {
  if (LEVEL_COLORS[level]) return LEVEL_COLORS[level];
  const hue = (level * 47) % 360;
  return `hsl(${hue} 82% 72%)`;
}

function parentOptionLabel(note) {
  const indent = "  ".repeat(Math.min(note.level, 12));
  const overflow = note.level > 12 ? `L${note.level} ` : "";
  return `${indent}${overflow}${note.title}`;
}

function setStatus(message) {
  els.editorStatus.textContent = message || "";
}

function updateSourceStatus() {
  const isFolder = hasWritableWorkspace();
  const hasSelection = Boolean(getSelectedNote());
  updateGraphTitle();
  els.sourceStatus.textContent = isFolder ? "" : "No folder";
  els.newNoteButton.disabled = !isFolder;
  els.infoTitle.disabled = !isFolder || !hasSelection;
  els.infoParent.disabled = !isFolder || !hasSelection;
  els.deleteNoteButton.disabled = !canDeleteCurrentSelection();
  setEditorEditable(isFolder && hasSelection);
  renderWorkspaceTabs();
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
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
