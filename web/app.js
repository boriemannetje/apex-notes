import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, dropCursor, highlightActiveLine, keymap } from "@codemirror/view";

const LEVEL_COLORS = ["#f2f0ea", "#9fc5ff", "#b8f0c0", "#ffe08a", "#ffb6d1", "#b88cff", "#7de3ff", "#f6a86d"];
const STORAGE_PREFIX = "hamkg-layout-v2";
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.2;
const DOT_RADIUS = 7;
const SELECTED_DOT_RADIUS = 12;
const HIT_RADIUS = 22;
const LEVEL_GAP = 138;
const NODE_GAP = 168;
const GRAPH_PAD = 96;
const PENDING_PATH = "__pending_node__";

const editorEditable = new Compartment();
const wikiLinkRefreshEffect = StateEffect.define();

const state = {
  notes: [],
  byPath: new Map(),
  byKey: new Map(),
  notePaths: new Set(),
  sortedNotes: [],
  sortedParentOptions: [],
  selectedPath: null,
  rootPath: "",
  notesPath: "",
  source: "none",
  workspaceName: "",
  dirty: false,
  saveTimer: null,
  saveToken: 0,
  graphRenderFrame: 0,
  queuedGraphRender: null,
  filter: "",
  validation: [],
  layoutKey: "",
  manualPositions: {},
  positions: new Map(),
  nodeElements: new Map(),
  edgeElements: [],
  editorView: null,
  editorHydrating: false,
  infoHydrating: false,
  pendingCreatePoint: null,
  pendingNode: null,
  ropeElement: null,
  ropeTargetPath: null,
  view: {
    x: 0,
    y: 0,
    scale: 1
  },
  activeInteraction: null,
  graphBounds: null
};

const els = {
  graph: document.querySelector("#graph"),
  graphScroller: document.querySelector("#graphScroller"),
  graphCanvas: null,
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
  graphCreatePopover: document.querySelector("#graphCreatePopover"),
  graphNewTitle: document.querySelector("#graphNewTitle"),
  cancelGraphCreateButton: document.querySelector("#cancelGraphCreateButton")
};

const wikiLinkField = StateField.define({
  create(editorState) {
    return buildWikiLinkDecorations(editorState.doc);
  },
  update(decorations, transaction) {
    const shouldRefresh = transaction.docChanged || transaction.effects.some((effect) => effect.is(wikiLinkRefreshEffect));
    return shouldRefresh ? buildWikiLinkDecorations(transaction.state.doc) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

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
  els.openFolderButton.addEventListener("click", openNotesFolder);
  els.createFolderButton.addEventListener("click", openCreateFolderDialog);
  els.newNoteButton.addEventListener("click", openNewNoteDialog);
  els.zoomInButton.addEventListener("click", () => zoomAtCenter(1.18));
  els.zoomOutButton.addEventListener("click", () => zoomAtCenter(1 / 1.18));
  els.resetViewButton.addEventListener("click", () => fitGraphView());
  els.cancelNewNoteButton.addEventListener("click", () => closeNewNoteDialog());
  els.cancelCreateFolderButton.addEventListener("click", () => closeCreateFolderDialog());
  els.newNoteParent.addEventListener("change", updateNewNoteHint);
  els.newNoteForm.addEventListener("submit", createNewNote);
  els.createFolderForm.addEventListener("submit", createGraphFolder);
  els.infoTitle.addEventListener("input", onInfoChanged);
  els.infoParent.addEventListener("change", onInfoChanged);
  els.deleteNoteButton.addEventListener("click", deleteSelectedNote);
  els.graphCreatePopover.addEventListener("submit", createPendingGraphNode);
  els.cancelGraphCreateButton.addEventListener("click", closeGraphCreatePopover);

  els.searchInput.addEventListener("input", () => {
    state.filter = els.searchInput.value.trim().toLowerCase();
    applyGraphDimming();
  });

  els.graph.addEventListener("wheel", onGraphWheel, { passive: false });
  els.graph.addEventListener("dblclick", openGraphCreatePopover);
  els.graph.addEventListener("pointerdown", startGraphPointerDown);
  els.graph.addEventListener("pointermove", continueInteraction);
  els.graph.addEventListener("pointerup", endInteraction);
  els.graph.addEventListener("pointercancel", cancelInteraction);
  els.graph.addEventListener("keydown", onGraphKeydown);
  window.addEventListener("resize", () => requestGraphRender({ preserveView: true }));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeGraphCreatePopover();
      if (state.pendingNode && !state.activeInteraction) {
        state.pendingNode = null;
        requestGraphRender({ preserveView: true });
        setStatus("New graph node canceled");
      }
    }
  });
}

function startEmpty() {
  state.notes = [];
  state.byPath = new Map();
  state.byKey = new Map();
  state.notePaths = new Set();
  state.sortedNotes = [];
  state.sortedParentOptions = [];
  state.selectedPath = null;
  state.rootPath = "";
  state.notesPath = "";
  state.source = "none";
  state.workspaceName = "";
  state.dirty = false;
  state.saveToken += 1;
  cancelQueuedGraphRender();
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  state.filter = "";
  state.validation = [];
  state.layoutKey = "";
  state.manualPositions = {};
  state.pendingCreatePoint = null;
  state.pendingNode = null;
  els.searchInput.value = "";
  renderSelectedNote("Open or create a folder");
  renderNewNoteParents();
  renderGraph({ preserveView: false });
  updateSourceStatus();
  renderValidationStatus();
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
    multiple: false,
    canCreateDirectories: true
  });
  return Array.isArray(selected) ? selected[0] : selected;
}

async function invokeNative(command, args = {}) {
  return window.__TAURI__.core.invoke(command, args);
}

function setNativeWorkspace(workspace, statusMessage) {
  state.rootPath = workspace.rootPath;
  state.notesPath = workspace.notesPath;
  state.source = "folder";
  state.workspaceName = workspace.workspaceName || workspace.rootPath || "Folder";
  const notes = workspace.notes.map((note) => parseNote(note.path, note.raw));
  setNotes(notes, statusMessage);
}

function hasWritableWorkspace() {
  return state.source === "folder" && Boolean(state.notesPath);
}

function setNotes(notes, statusMessage) {
  cancelQueuedGraphRender();
  state.notes = notes;
  state.dirty = false;
  state.pendingCreatePoint = null;
  state.pendingNode = null;
  rebuildIndex();
  state.validation = validateNotes();
  state.layoutKey = `${STORAGE_PREFIX}:${state.source}:${state.rootPath || state.workspaceName || "workspace"}`;
  state.manualPositions = readStoredPositions();

  if (!state.selectedPath || !state.byPath.has(state.selectedPath)) {
    const firstRoot = state.notes.find((note) => note.level === 0) || state.notes[0];
    state.selectedPath = firstRoot ? firstRoot.path : null;
  }

  renderSelectedNote(statusMessage);
  renderNewNoteParents();
  renderGraph({ preserveView: false });
  updateSourceStatus();
  renderValidationStatus();
}

function rebuildIndex() {
  state.byPath = new Map();
  state.byKey = new Map();
  state.notePaths = new Set();

  for (const note of state.notes) {
    state.byPath.set(note.path, note);
    state.notePaths.add(note.path);
  }

  for (const note of state.notes) {
    for (const key of note.keys) {
      if (!state.byKey.has(key)) {
        state.byKey.set(key, note);
      }
    }
  }

  for (const note of state.notes) {
    note.parentNote = resolveParent(note);
    note.children = [];
    note.bodyRefNotes = [];
  }

  for (const note of state.notes) {
    if (note.parentNote) {
      note.parentNote.children.push(note);
    }
    note.bodyRefNotes = note.bodyRefs
      .map((ref) => ({
        ...ref,
        note: resolveWikiNote(ref.ref)
      }))
      .filter((ref) => ref.note);
  }

  state.sortedNotes = [...state.notes].sort(compareGraphNotes);
  state.sortedParentOptions = [...state.notes].sort(compareParentOptions);

  refreshEditorDecorations();
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

  const keys = new Set([
    normalizeKey(pathNoExt),
    normalizeKey(basename),
    normalizeKey(title),
    normalizeKey(slugify(pathNoExt)),
    normalizeKey(slugify(basename)),
    normalizeKey(slugify(title))
  ]);

  return {
    path,
    pathNoExt,
    basename,
    title,
    level: Number.isFinite(level) ? level : 4,
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
    if (entryLines.length === 1) {
      values[key] = stripQuotes(match[2].trim());
    } else {
      values[key] = stripQuotes(match[2].trim());
    }
  }

  return { entries, values };
}

function parseWikiRefs(body) {
  const refs = [];
  const seen = new Set();
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(body)) !== null) {
    const parsed = parseWikiTarget(match[1]);
    if (!parsed.ref) continue;
    const key = normalizeKey(parsed.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(parsed);
  }

  return refs;
}

function parseWikiTarget(value) {
  const parts = String(value || "").split("|");
  const ref = parts[0].replace(/\.md$/i, "").trim();
  const alias = parts.slice(1).join("|").trim();
  return {
    ref,
    label: alias || ref.split("/").pop() || ref
  };
}

function resolveParent(note) {
  const ref = cleanWikiRef(note.parentRef);
  if (!ref) return null;
  return resolveWikiNote(ref);
}

function resolveWikiNote(ref) {
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

    const parentRef = cleanWikiRef(note.parentRef);
    if (note.level === 0) {
      if (parentRef) {
        issues.push({ type: "parent", note, message: `${note.title} is level 0 but has a parent` });
      }
      continue;
    }

    if (!parentRef) {
      issues.push({ type: "parent", note, message: `${note.title} is missing a parent` });
      continue;
    }

    if (!note.parentNote) {
      issues.push({ type: "parent", note, message: `${note.title} has a broken parent` });
      continue;
    }

    if (note.parentNote.level !== note.level - 1) {
      issues.push({
        type: "level",
        note,
        message: `${note.title} parent should be level ${note.level - 1}`
      });
    }
  }

  for (const matches of titleCounts.values()) {
    if (matches.length < 2) continue;
    for (const note of matches) {
      issues.push({ type: "duplicate", note, message: `${note.title} title is duplicated` });
    }
  }

  return issues;
}

function cleanWikiRef(value) {
  if (!value || value === "null") return null;
  const wiki = String(value).match(/\[\[([^\]]+)\]\]/);
  const ref = wiki ? wiki[1] : value;
  return parseWikiTarget(ref).ref;
}

function normalizeKey(value) {
  return String(value || "")
    .replace(/^notes\//i, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase();
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

  const previousPath = state.selectedPath;
  state.selectedPath = path;
  state.dirty = false;
  renderSelectedNote(state.source === "folder" ? "Loaded" : "Read-only");
  updateGraphSelection(previousPath, path);
  updateSourceStatus();
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
    els.deleteNoteButton.disabled = true;
    els.noteInfo.open = false;
    state.infoHydrating = false;
    return;
  }

  els.infoTitle.value = note.title;
  els.deleteNoteButton.disabled = !hasWritableWorkspace();
  renderInfoParents(note);
  updateInfoDerivedFields();
  state.infoHydrating = false;
}

function renderInfoParents(note) {
  const fragment = document.createDocumentFragment();
  const apexOption = document.createElement("option");
  apexOption.value = "";
  apexOption.textContent = "No parent (Apex)";
  fragment.appendChild(apexOption);

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
  while (current) {
    if (current.path === parent.path) return true;
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
  const note = getSelectedNote();
  if (!note || !hasWritableWorkspace()) {
    setStatus("Open notes folder to delete notes");
    return;
  }

  const childCount = note.children.length;
  const childWarning = childCount
    ? `\n\n${childCount} child note${childCount === 1 ? "" : "s"} will keep their Markdown and show broken parents until reconnected.`
    : "";
  const message = `Move "${note.title}" to Trash?${childWarning}`;

  if (!window.confirm(message)) return;

  if (state.dirty) {
    await flushAutosave();
    if (state.dirty) return;
  }

  try {
    await invokeNative("trash_note", {
      notesPath: state.notesPath,
      path: note.path
    });

    const deletedPath = note.path;
    const deletedParent = note.parentNote;
    state.notes = state.notes.filter((item) => item.path !== deletedPath);
    delete state.manualPositions[deletedPath];
    const parentStillExists = deletedParent && state.notes.some((item) => item.path === deletedParent.path);
    state.selectedPath =
      (parentStillExists && deletedParent.path) ||
      (state.notes[0] && state.notes[0].path) ||
      null;
    state.dirty = false;
    rebuildIndex();
    state.validation = validateNotes();
    saveStoredPositions();
    await updateManifestFile();
    renderSelectedNote("Moved note to Trash");
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    updateSourceStatus();
    renderValidationStatus();
  } catch (error) {
    setStatus("Could not delete note");
    console.error(error);
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
  if (!state.saveTimer) return;
  window.clearTimeout(state.saveTimer);
  state.saveTimer = null;
  await autosaveSelectedNote();
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
      state.manualPositions = pruneStoredPositions(state.manualPositions);
      saveStoredPositions();
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
        applyGraphDimming();
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
  note.rawLevel = updated.rawLevel;
  note.hasFrontmatter = updated.hasFrontmatter;
  note.hasLevel = updated.hasLevel;
  note.hasTitle = updated.hasTitle;
  note.body = updated.body;
  note.bodyRefs = updated.bodyRefs;
  note.searchText = updated.searchText;
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
  cancelQueuedGraphRender();
  const viewportWidth = Math.max(320, els.graphScroller.clientWidth || 0);
  const viewportHeight = Math.max(320, els.graphScroller.clientHeight || 0);

  els.graph.setAttribute("width", String(viewportWidth));
  els.graph.setAttribute("height", String(viewportHeight));
  els.graph.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);
  els.graph.replaceChildren();

  const canvas = document.createElementNS("http://www.w3.org/2000/svg", "g");
  canvas.setAttribute("class", "graphCanvas");
  els.graphCanvas = canvas;
  state.nodeElements = new Map();
  state.edgeElements = [];
  state.ropeElement = null;
  state.ropeTargetPath = null;

  const notes = getRenderableNotes();
  state.positions = buildPositions(notes, viewportWidth, viewportHeight);
  if (state.pendingNode) {
    state.positions.set(PENDING_PATH, state.pendingNode.position);
  }
  state.graphBounds = getGraphBounds(state.positions);

  if (!notes.length && !state.pendingNode) {
    els.graph.appendChild(canvas);
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "text");
    empty.setAttribute("class", "emptyGraphText");
    empty.setAttribute("x", String(viewportWidth / 2));
    empty.setAttribute("y", String(viewportHeight / 2));
    empty.textContent = "Open folder or create folder";
    els.graph.appendChild(empty);
    applyViewTransform();
    return;
  }

  if (!preserveView) {
    fitGraphView(false);
  }

  const fragment = document.createDocumentFragment();

  for (const note of notes) {
    if (!note.parentNote) continue;
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
    edge.setAttribute("class", `edge hierarchyEdge${isDimmed(note) || isDimmed(note.parentNote) ? " dimmed" : ""}`);
    edge.setAttribute("aria-hidden", "true");
    edge.style.setProperty("--level-color", getLevelColor(note.level));
    fragment.appendChild(edge);
    state.edgeElements.push({ path: edge, from: note.parentNote.path, to: note.path, type: "hierarchy" });
  }

  for (const referenceEdge of getReferenceEdges(notes)) {
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
    edge.setAttribute("class", `edge referenceEdge${referenceEdge.dimmed ? " dimmed" : ""}`);
    edge.setAttribute("aria-hidden", "true");
    edge.style.setProperty("--level-color", getLevelColor(referenceEdge.level));
    fragment.appendChild(edge);
    state.edgeElements.push({ path: edge, from: referenceEdge.from, to: referenceEdge.to, type: "reference" });
  }

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

function updateGraphSelection(previousPath, nextPath) {
  for (const path of new Set([previousPath, nextPath].filter(Boolean))) {
    const group = state.nodeElements.get(path);
    if (!group) continue;
    const isSelected = path === nextPath;
    group.classList.toggle("selected", isSelected);
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

function getReferenceEdges(notes) {
  const renderable = new Set(notes.map((note) => note.path));
  const hierarchyPairs = new Set();
  const referenceEdges = new Map();

  for (const note of notes) {
    if (!note.parentNote) continue;
    hierarchyPairs.add(undirectedPairKey(note.path, note.parentNote.path));
  }

  for (const note of notes) {
    for (const ref of note.bodyRefNotes) {
      const target = ref.note;
      if (!target || target.path === note.path) continue;
      if (!renderable.has(target.path)) continue;
      const pairKey = undirectedPairKey(note.path, target.path);
      if (hierarchyPairs.has(pairKey)) continue;
      if (referenceEdges.has(pairKey)) continue;
      referenceEdges.set(pairKey, {
        from: note.path,
        to: target.path,
        level: target.level,
        dimmed: isDimmed(note) || isDimmed(target)
      });
    }
  }

  return [...referenceEdges.values()];
}

function undirectedPairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function renderGraphNode(canvas, note) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const classes = ["node"];
  if (note.path === state.selectedPath) classes.push("selected");
  if (isDimmed(note)) classes.push("dimmed");
  group.setAttribute("class", classes.join(" "));
  group.style.setProperty("--level-color", getLevelColor(note.level));
  group.setAttribute("tabindex", "0");
  group.setAttribute("role", "button");
  group.setAttribute("aria-label", note.title);
  group.setAttribute("data-path", note.path);

  const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hit.setAttribute("class", "nodeHit");
  hit.setAttribute("r", String(HIT_RADIUS));
  group.appendChild(hit);

  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("class", "nodeDot");
  dot.setAttribute("r", String(note.path === state.selectedPath ? SELECTED_DOT_RADIUS : DOT_RADIUS));
  group.appendChild(dot);

  appendNodeLabel(group, note.title, "nodeLabel");
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

function buildPositions(notes, viewportWidth, viewportHeight) {
  const levels = new Map();
  for (const note of notes) {
    if (!levels.has(note.level)) levels.set(note.level, []);
    levels.get(note.level).push(note);
  }

  const levelNumbers = [...levels.keys()].sort((a, b) => a - b);
  let maxLevelCount = 1;
  for (const items of levels.values()) {
    if (items.length > maxLevelCount) maxLevelCount = items.length;
  }
  const contentWidth = Math.max(
    viewportWidth,
    GRAPH_PAD * 2 + Math.max(0, maxLevelCount - 1) * NODE_GAP
  );
  const contentHeight = Math.max(
    viewportHeight,
    GRAPH_PAD * 2 + Math.max(0, levelNumbers.length - 1) * LEVEL_GAP
  );
  const positions = new Map();

  levelNumbers.forEach((level, rowIndex) => {
    const row = levels.get(level);
    const rowWidth = Math.max(0, row.length - 1) * NODE_GAP;
    const startX = (contentWidth - rowWidth) / 2;
    const y = GRAPH_PAD + rowIndex * LEVEL_GAP;

    row.forEach((note, colIndex) => {
      positions.set(note.path, {
        x: startX + colIndex * NODE_GAP,
        y
      });
    });
  });

  for (const [path, position] of Object.entries(state.manualPositions)) {
    if (!state.notePaths.has(path)) continue;
    positions.set(path, position);
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

function updateGraphGeometry() {
  for (const { path, from, to, type } of state.edgeElements) {
    const fromPosition = state.positions.get(from);
    const toPosition = state.positions.get(to);
    if (!fromPosition || !toPosition) continue;
    path.setAttribute("d", type === "reference" ? referenceEdgePath(fromPosition, toPosition) : edgePath(fromPosition, toPosition));
  }

  for (const [path, group] of state.nodeElements.entries()) {
    const position = state.positions.get(path);
    if (!position) continue;
    group.setAttribute("transform", `translate(${position.x} ${position.y})`);
  }
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
  return !note.searchText.includes(state.filter);
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
  const point = clientToSvgPoint(clientX, clientY);
  const nextScale = clamp(state.view.scale * factor, MIN_ZOOM, MAX_ZOOM);
  const graphX = (point.x - state.view.x) / state.view.scale;
  const graphY = (point.y - state.view.y) / state.view.scale;
  state.view.x = point.x - graphX * nextScale;
  state.view.y = point.y - graphY * nextScale;
  state.view.scale = nextScale;
  applyViewTransform();
}

function fitGraphView(animate = true) {
  if (!state.graphBounds || !els.graphCanvas) return;
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
}

function applyViewTransform(animate = false) {
  if (!els.graphCanvas) return;
  els.graphCanvas.style.transition = animate ? "transform 120ms ease" : "";
  els.graphCanvas.setAttribute(
    "transform",
    `translate(${round(state.view.x)} ${round(state.view.y)}) scale(${round(state.view.scale)})`
  );
}

function startGraphPointerDown(event) {
  if (event.button !== 0) return;
  const group = event.target.closest ? event.target.closest(".node") : null;
  if (group && els.graph.contains(group)) {
    const path = group.getAttribute("data-path");
    if (path === PENDING_PATH) {
      startPendingRope(event, group);
      return;
    }

    const note = state.byPath.get(path);
    if (note) {
      startNodeDrag(event, note, group);
      return;
    }
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
  if (event.button !== 0 || state.pendingNode) return;
  closeGraphCreatePopover();
  state.activeInteraction = {
    type: "pan",
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    viewX: state.view.x,
    viewY: state.view.y
  };
  els.graph.setPointerCapture(event.pointerId);
}

function startNodeDrag(event, note, group) {
  if (event.button !== 0 || state.pendingNode) return;
  event.preventDefault();
  event.stopPropagation();
  closeGraphCreatePopover();

  const point = eventToGraphPoint(event);
  const position = state.positions.get(note.path);
  state.activeInteraction = {
    type: "node",
    pointerId: event.pointerId,
    path: note.path,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: point.x - position.x,
    offsetY: point.y - position.y,
    moved: false
  };
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
    pointerId: event.pointerId,
    start,
    current,
    targetPath: null
  };
  ensureRopeElement();
  updateRopePath(start, current);
  els.graph.setPointerCapture(event.pointerId);
}

function continueInteraction(event) {
  const interaction = state.activeInteraction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;

  if (interaction.type === "pan") {
    state.view.x = interaction.viewX + event.clientX - interaction.startX;
    state.view.y = interaction.viewY + event.clientY - interaction.startY;
    applyViewTransform();
    return;
  }

  if (interaction.type === "node") {
    const point = eventToGraphPoint(event);
    const distance = Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY);
    if (distance > 3) interaction.moved = true;

    const position = {
      x: round(point.x - interaction.offsetX),
      y: round(point.y - interaction.offsetY)
    };
    state.positions.set(interaction.path, position);
    state.manualPositions[interaction.path] = position;
    updateGraphGeometry();
    return;
  }

  if (interaction.type === "rope") {
    const point = eventToGraphPoint(event);
    interaction.current = point;
    const target = findRopeTarget(point);
    interaction.targetPath = target ? target.path : null;
    setRopeTarget(interaction.targetPath);
    updateRopePath(interaction.start, point);
  }
}

async function endInteraction(event) {
  const interaction = state.activeInteraction;
  if (!interaction || interaction.pointerId !== event.pointerId) return;

  if (interaction.type === "node") {
    saveStoredPositions();
    if (!interaction.moved) {
      selectNote(interaction.path);
    }
    state.activeInteraction = null;
    return;
  }

  if (interaction.type === "rope") {
    const parent = state.byPath.get(interaction.targetPath) || null;
    if (parent) {
      state.activeInteraction = null;
      clearRopeTarget();
      await createNoteFromPending(parent);
      return;
    }

    animateRopeBack(interaction);
    state.activeInteraction = null;
    clearRopeTarget();
    setStatus("Drop the rope on a parent node");
    return;
  }

  state.activeInteraction = null;
}

function cancelInteraction() {
  if (state.activeInteraction && state.activeInteraction.type === "rope") {
    animateRopeBack(state.activeInteraction);
  }
  state.activeInteraction = null;
  clearRopeTarget();
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

function findRopeTarget(point) {
  let best = null;
  let bestDistance = Infinity;
  for (const note of state.notes) {
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
  if (!state.notes.length) {
    setStatus("Create a parent-capable note first");
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

function createPendingGraphNode(event) {
  event.preventDefault();
  const title = els.graphNewTitle.value.trim();
  if (!title || !state.pendingCreatePoint) return;
  state.pendingNode = {
    title,
    position: {
      x: round(state.pendingCreatePoint.x),
      y: round(state.pendingCreatePoint.y)
    }
  };
  closeGraphCreatePopover();
  renderGraph({ preserveView: true });
  setStatus("Drag the purple rope to a parent node");
}

async function createNoteFromPending(parent) {
  if (!state.pendingNode || !hasWritableWorkspace()) return;

  const title = state.pendingNode.title;
  const level = parent.level + 1;
  const path = getAvailableNewNotePath(title, level, parent);
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
    state.dirty = false;
    state.manualPositions[path] = state.pendingNode.position;
    state.pendingNode = null;
    rebuildIndex();
    state.validation = validateNotes();
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    saveStoredPositions();
    await updateManifestFile();
    renderSelectedNote("Saved new note");
    renderNewNoteParents();
    renderGraph({ preserveView: true });
    updateSourceStatus();
    renderValidationStatus();
  } catch (error) {
    setStatus("Could not create note");
    console.error(error);
  }
}

function readStoredPositions() {
  try {
    const stored = window.localStorage.getItem(state.layoutKey);
    if (!stored) return {};
    return pruneStoredPositions(JSON.parse(stored));
  } catch {
    return {};
  }
}

function saveStoredPositions() {
  try {
    state.manualPositions = pruneStoredPositions(state.manualPositions);
    window.localStorage.setItem(state.layoutKey, JSON.stringify(state.manualPositions));
  } catch {
    setStatus("Could not save local layout");
  }
}

function pruneStoredPositions(positions) {
  const next = {};
  for (const [path, position] of Object.entries(positions || {})) {
    if (!state.notePaths.has(path)) continue;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    next[path] = {
      x: round(position.x),
      y: round(position.y)
    };
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
    els.validationStatus.textContent = "Valid";
    els.validationStatus.title = "No broken parents, missing levels, or duplicate titles";
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
}

function renderNewNoteParents() {
  const fragment = document.createDocumentFragment();
  const parents = state.sortedParentOptions;

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

  if (!state.notes.length) {
    setStatus("Create an apex note first");
    return;
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
  const parent = state.byPath.get(els.newNoteParent.value);
  if (!parent) {
    els.newNoteHint.textContent = "";
    return;
  }

  const nextLevel = parent.level + 1;
  els.newNoteHint.textContent = `Level ${nextLevel} · parent [[${parent.basename}]]`;
}

async function createNewNote(event) {
  event.preventDefault();

  const title = els.newNoteTitle.value.trim();
  const parent = state.byPath.get(els.newNoteParent.value);
  if (!title || !parent || !hasWritableWorkspace()) return;

  const level = parent.level + 1;
  const path = getAvailableNewNotePath(title, level, parent);
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

function getAvailableNewNotePath(title, level, parent) {
  const base = slugify(title) || "untitled";
  const directory = getRecommendedDirectory();
  const existing = new Set([...state.notePaths].map((path) => path.toLowerCase()));
  let suffix = 0;

  while (true) {
    const filename = `${base}${suffix ? `-${suffix + 1}` : ""}.md`;
    const path = directory ? `${directory}/${filename}` : filename;
    if (!existing.has(path.toLowerCase())) return path;
    suffix += 1;
  }
}

function getRecommendedDirectory() {
  return "";
}

async function updateManifestFile() {
  const paths = state.notes.map((note) => note.path).sort(compareText);
  if (!state.notesPath) return;
  await invokeNative("write_manifest", {
    notesPath: state.notesPath,
    paths
  });
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
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
  const canCreateChild = state.notes.length > 0;
  els.sourceStatus.textContent = isFolder ? state.workspaceName || "User folder" : "No folder";
  els.newNoteButton.disabled = !isFolder || !canCreateChild;
  els.infoTitle.disabled = !isFolder || !hasSelection;
  els.infoParent.disabled = !isFolder || !hasSelection;
  els.deleteNoteButton.disabled = !isFolder || !hasSelection;
  setEditorEditable(isFolder && hasSelection);
}

function setEditorEditable(isEditable) {
  if (!state.editorView) return;
  state.editorView.dispatch({
    effects: editorEditable.reconfigure(EditorView.editable.of(isEditable))
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
