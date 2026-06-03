export interface DomElements {
  layout: Element | null;
  launchScreen: Element | null;
  launchOpenProjectButton: Element | null;
  launchCreateProjectButton: Element | null;
  launchRecentList: Element | null;
  launchRecentEmpty: Element | null;
  launchStatus: Element | null;
  graphProjectLauncher: Element | null;
  graphOpenProjectButton: Element | null;
  graphCreateProjectButton: Element | null;
  graphRecentList: Element | null;
  graphRecentEmpty: Element | null;
  graphLaunchStatus: Element | null;
  closeGraphProjectLauncherButton: Element | null;
  workspaceTabs: Element | null;
  graph: Element | null;
  graphPane: Element | null;
  graphScroller: Element | null;
  graphCanvas: SVGSVGElement | null;
  editorResizeHandle: Element | null;
  graphHelpButton: Element | null;
  graphHelpDialog: Element | null;
  closeGraphHelpButton: Element | null;
  searchField: Element | null;
  searchFieldIcon: Element | null;
  searchInput: Element | null;
  searchResults: Element | null;
  newNoteButton: Element | null;
  editorPane: Element | null;
  editor: Element | null;
  noteTitle: Element | null;
  notePath: Element | null;
  noteInfo: Element | null;
  infoParent: Element | null;
  fullscreenEditorButton: Element | null;
  deleteNoteButton: Element | null;
  editorStatus: Element | null;
  sourceStatus: Element | null;
  validationStatus: Element | null;
  updateButton: Element | null;
  updateRestartOverlay: Element | null;
  zoomInButton: Element | null;
  zoomOutButton: Element | null;
  resetViewButton: Element | null;
  fullscreenGraphButton: Element | null;
  newNoteDialog: Element | null;
  newNoteForm: Element | null;
  newNoteTitle: Element | null;
  newNoteParent: Element | null;
  newNoteHint: Element | null;
  cancelNewNoteButton: Element | null;
  createFolderDialog: Element | null;
  createFolderForm: Element | null;
  createFolderName: Element | null;
  createFolderLocationSelect: Element | null;
  createFolderLocationPath: Element | null;
  cancelCreateFolderButton: Element | null;
  hierarchyPromptDialog: Element | null;
  copyHierarchyPromptButton: Element | null;
  closeHierarchyPromptButton: Element | null;
  deleteConfirmDialog: Element | null;
  deleteConfirmTitle: Element | null;
  deleteConfirmMessage: Element | null;
  deleteConfirmDetail: Element | null;
  cancelDeleteButton: Element | null;
  confirmDeleteButton: Element | null;
  graphCreatePopover: Element | null;
  graphNewTitle: Element | null;
  cancelGraphCreateButton: Element | null;
}

export function getDomElements(): DomElements {
  return {
    layout: document.querySelector(".layout"),
    launchScreen: document.querySelector("#launchScreen"),
    launchOpenProjectButton: document.querySelector("#launchOpenProjectButton"),
    launchCreateProjectButton: document.querySelector("#launchCreateProjectButton"),
    launchRecentList: document.querySelector("#launchRecentList"),
    launchRecentEmpty: document.querySelector("#launchRecentEmpty"),
    launchStatus: document.querySelector("#launchStatus"),
    graphProjectLauncher: document.querySelector("#graphProjectLauncher"),
    graphOpenProjectButton: document.querySelector("#graphOpenProjectButton"),
    graphCreateProjectButton: document.querySelector("#graphCreateProjectButton"),
    graphRecentList: document.querySelector("#graphRecentList"),
    graphRecentEmpty: document.querySelector("#graphRecentEmpty"),
    graphLaunchStatus: document.querySelector("#graphLaunchStatus"),
    closeGraphProjectLauncherButton: document.querySelector("#closeGraphProjectLauncherButton"),
    workspaceTabs: document.querySelector("#workspaceTabs"),
    graph: document.querySelector("#graph"),
    graphPane: document.querySelector(".graphPane"),
    graphScroller: document.querySelector("#graphScroller"),
    graphCanvas: null,
    editorResizeHandle: document.querySelector("#editorResizeHandle"),
    graphHelpButton: document.querySelector("#graphHelpButton"),
    graphHelpDialog: document.querySelector("#graphHelpDialog"),
    closeGraphHelpButton: document.querySelector("#closeGraphHelpButton"),
    searchField: document.querySelector(".searchField"),
    searchFieldIcon: document.querySelector("#searchFieldIcon"),
    searchInput: document.querySelector("#searchInput"),
    searchResults: document.querySelector("#searchResults"),
    newNoteButton: document.querySelector("#newNoteButton"),
    editorPane: document.querySelector(".editorPane"),
    editor: document.querySelector("#editor"),
    noteTitle: document.querySelector("#noteTitle"),
    notePath: document.querySelector("#notePath"),
    noteInfo: document.querySelector("#noteInfo"),
    infoParent: document.querySelector("#infoParent"),
    fullscreenEditorButton: document.querySelector("#fullscreenEditorButton"),
    deleteNoteButton: document.querySelector("#deleteNoteButton"),
    editorStatus: document.querySelector("#editorStatus"),
    sourceStatus: document.querySelector("#sourceStatus"),
    validationStatus: document.querySelector("#validationStatus"),
    updateButton: document.querySelector("#updateButton"),
    updateRestartOverlay: document.querySelector("#updateRestartOverlay"),
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
    createFolderLocationSelect: document.querySelector("#createFolderLocationSelect"),
    createFolderLocationPath: document.querySelector("#createFolderLocationPath"),
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
}
