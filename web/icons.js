import createElement from "lucide/dist/esm/createElement.mjs";
import CircleHelp from "lucide/dist/esm/icons/circle-question-mark.mjs";
import FilePlus from "lucide/dist/esm/icons/file-plus.mjs";
import FolderOpen from "lucide/dist/esm/icons/folder-open.mjs";
import FolderPlus from "lucide/dist/esm/icons/folder-plus.mjs";
import Maximize2 from "lucide/dist/esm/icons/maximize-2.mjs";
import Minimize2 from "lucide/dist/esm/icons/minimize-2.mjs";
import Minus from "lucide/dist/esm/icons/minus.mjs";
import Plus from "lucide/dist/esm/icons/plus.mjs";
import Scan from "lucide/dist/esm/icons/scan.mjs";
import Search from "lucide/dist/esm/icons/search.mjs";
import Trash2 from "lucide/dist/esm/icons/trash-2.mjs";
import X from "lucide/dist/esm/icons/x.mjs";

const ICONS = {
  close: X,
  createProject: FolderPlus,
  fit: Scan,
  fullscreenEnter: Maximize2,
  fullscreenExit: Minimize2,
  help: CircleHelp,
  newNote: FilePlus,
  openProject: FolderOpen,
  search: Search,
  trash: Trash2,
  zoomIn: Plus,
  zoomOut: Minus
};

export function createIcon(name, options = {}) {
  const iconNode = ICONS[name];
  if (!iconNode) {
    throw new Error(`Unknown icon: ${name}`);
  }

  const svg = createElement(iconNode, {
    "aria-hidden": "true",
    focusable: "false",
    width: options.size || 18,
    height: options.size || 18,
    "stroke-width": options.strokeWidth || 1.8
  });
  svg.classList.add("lucideIcon");
  return svg;
}

export function setButtonIcon(button, name, label = "") {
  if (!button) return;

  const icon = createIcon(name);
  if (!label) {
    button.replaceChildren(icon);
    return;
  }

  const labelElement = document.createElement("span");
  labelElement.className = "buttonLabel";
  labelElement.textContent = label;
  button.replaceChildren(icon, labelElement);
}
