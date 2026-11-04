---
name: apex-notes-writing
description: Create, edit, import, delete, and connect Apex Notes (Apex Nodes) Markdown notes, or create named canvas lines, squares, circles, freehand strokes, and text through the workspace annotation sidecar. Preserve hierarchy, dates, and existing canvas content.
---

# Apex Notes Writing

Use this skill for Apex Notes Markdown and canvas annotations. Agents with filesystem access can create shapes directly; no UI drawing or separate API server is required.

Repo rule: bundled `notes/` = neutral sample data only. No private/user notes in app repo.

## App Contract

- Workspace: app opens folder; if `notes/` exists, note root = `notes/`; else opened folder = note root.
- Reads `.md` recursively under note root; ignores dotfiles/symlinks.
- Source of truth after folder access = actual `.md`; `manifest.json` = seed/metadata path list.
- `layout.json` = graph positions keyed by note path; not hierarchy.
- `annotations.json` = versioned background canvas shapes, strokes, and text; see Canvas annotations below.
- `dates.json` = automatic note creation/line-date metadata; preserve it, do not hand-author it.
- New app-created workspace starts with empty `notes/manifest.json` + `notes/layout.json`.

## Frontmatter

Every note starts with only:

```yaml
---
title: "Human Readable Title"
parent: null
---
```

Rules:
- keys: only `title`, `parent`; no schema fields unless schema task.
- `title` = graph label; filename is storage.
- `parent: null` = loose note or independent root.
- `parent: "[[parent-stem]]"` = one immediate parent; depth is derived from the parent chain.
- Parent must exist, resolve uniquely, be outside child descendant chain.
- Multiple roots/loose notes in one folder are valid.
- Legacy `level` frontmatter is ignored by the app and may be removed when rewriting a note.

## Links

- Hierarchy edge: frontmatter `parent` only.
- Body `[[wikilink]]` = contextual/reference edge only.
- Body link forms: `[[stem]]`, `[[path/stem]]`, `[[Title]]`, `[[target|label]]`.
- Prefer parent/body refs by stable file stem; app also resolves path, title, slug.
- Do not body-link every ancestor; link only real context.
- Do not use body links to fake hierarchy.
- Standard `[label](https://example.com)` and HTTP links display as clickable labels. Multiline links stay raw to preserve logical lines and date labels; unsafe schemes are not made clickable.

## Canvas annotations: agent interface

Write `annotations.json` directly inside the resolved note root (usually `notes/annotations.json`, NOT the skill folder). It is a JSON document with exactly `version: 1` and `items: [...]`. Missing file means an empty canvas. Do not put annotations in Markdown/frontmatter, `layout.json`, or `manifest.json`.

All annotations, their names, and selection handles render behind graph edges and nodes. Shapes are visual only: enclosing a note does not group, connect, reparent, select, or move it. They participate in Fit-to-view, including annotation-only workspaces. Item order determines paint order within the background layer.

### Safe editing workflow

1. Resolve the user's actual workspace and note root; read existing annotations and relevant layout positions. Do not use this app repository's sample notes as the user's workspace.
2. Have the user save pending edits and close that workspace tab (or quit Apex Notes) before external sidecar writes. Do not race the app's in-memory annotation state. External annotation edits are loaded on workspace reopen, NOT live-watched.
3. If present, reject symlinks and read/validate the entire existing document. Preserve it byte-for-byte and report the problem if malformed, unsupported-version, or over limits; never silently reset it. A missing file can start as `{"version":1,"items":[]}`.
4. Merge requested additions into existing `items`. Generate collision-free stable IDs (UUIDs are suitable); preserve IDs when moving, resizing, or renaming. Delete only requested IDs. Do not replace the whole canvas with the example below.
5. Validate the merged document, preserve a recoverable copy outside the note root, and recheck that the original file has not changed. If it changed, stop and reread rather than overwrite. Write complete UTF-8 JSON via a temporary file in the same directory and atomic rename, with exclusive access while writing. Avoid partial writes.
6. Reopen the workspace and use Fit-to-view to verify positions, names, and existing annotations. Do not promise app undo for external file edits; use the backup to recover them.

### Coordinates and supported items

Use graph/world coordinates, not screen pixels: x increases rightward, y downward; negative values are allowed. Zoom/pan do not change stored coordinates. `layout.json` positions use this same space; preserve them when adding shapes. If a note has no saved position, its layout is computed: inspect the canvas rather than inventing a persisted position. Choose coordinates from the user's requested placement; example coordinates are illustrative.

Every item has a nonempty unique string `id` and a `type`. Only these fields are supported:

| Type | Geometry/content fields | Optional visible name |
| --- | --- | --- |
| `line` | `x1`, `y1`, `x2`, `y2` (distinct endpoints) | `name` |
| `square` | `x`, `y` (top-left), `size` (positive equal side length) | `name` |
| `circle` | `cx`, `cy` (center), `radius` (positive) | `name` |
| `stroke` | `points`: array of `{ "x": number, "y": number }` | None |
| `text` | `x`, `y` (text origin), `text` (string; `\n` for multiline) | None; use `text` |

Example complete document for a NEW empty annotation canvas:

```json
{
  "version": 1,
  "items": [
    { "id": "idea-boundary", "type": "square", "x": -200, "y": -200, "size": 400, "name": "Ideas" },
    { "id": "review-area", "type": "circle", "cx": 500, "cy": 0, "radius": 140, "name": "Review" },
    { "id": "next-step", "type": "line", "x1": 220, "y1": 0, "x2": 340, "y2": 0, "name": "Next step" },
    { "id": "freehand-mark", "type": "stroke", "points": [{ "x": -180, "y": 240 }, { "x": -80, "y": 270 }, { "x": 20, "y": 240 }] },
    { "id": "canvas-caption", "type": "text", "x": -200, "y": 320, "text": "Working notes\nShapes do not change hierarchy." }
  ]
}
```

Rename with `name` on a line/square/circle; move by changing its coordinates (both endpoints for a line, every point for a stroke); resize with endpoints, `size`, or `radius`. Preserve equal-sided squares and circular circles. No rectangles, arrows, color/fill controls, grouping, custom layers, or arbitrary extra fields in v1. The Pen toolbar produces `stroke` items, not a `pen` type.

### Validation limits

- All geometry must be finite JSON numbers, not strings, null, NaN, or Infinity. Lines must have distinct endpoints; squares/circles must have positive dimensions.
- At most 5,000 items; at most 4 MiB serialized UTF-8 JSON (keep the on-disk file within this limit too).
- Stroke: 2–4,096 points, with at least two distinct points; at most 100,000 stroke points across the document. Simplify long freehand paths before saving.
- Names: at most 120 Unicode characters. Text: at most 20,000 per text item. Combined names + text: at most 200,000. These are Unicode code-point counts, not UTF-16 code units.
- Reject duplicate/blank IDs, unknown fields/types, and versions other than 1. Omit an optional name instead of writing null.

For app integrations already running inside Tauri, the native command is `write_annotations` with `{ notesPath, annotations }` (camelCase keys); `notesPath` must be the absolute existing note root and `annotations` the FULL merged document. Workspace reads return `annotations` and optional `annotationsError`. The command validates and refuses to overwrite invalid existing data. It is not an HTTP endpoint or standalone CLI, and invoking it alone does not refresh the current canvas; coordinate with app state or reopen. Ordinary filesystem agents should use the safe workflow above.

## Automatic dates

The note editor shows Created/Last edited and muted daily groups; dates are not canvas node labels or Markdown prose. Local app edits date changed logical lines using the device's calendar day; blank spacing does not redate unchanged text. App undo/redo restores date attribution with text.

Preserve `dates.json` when backing up/moving a workspace. Do not insert manual dates merely to reproduce the UI, reset creation dates, or fabricate line history. Existing `Written`/`Added` markers remain meaningful and should be preserved. External Markdown edits are reconciled by content anchors: confidently unchanged lines retain dates; changed lines use the file modification day, explicitly estimated (`≈`). Creation estimates freeze once recorded. Invalid date metadata remains untouched and does not block Markdown saves. Date metadata is bounded to 20,000 notes, 100,000 lines/note, 200,000 lines total and 16 MiB; report warnings rather than erase it to bypass limits.

## Files

- Preserve existing filenames unless rename requested.
- New filename: stable slug `.md`; unique; subfolders OK.
- Folder names never define hierarchy; `parent` does.
- Keep body concise; H1 matching title is OK, not hierarchy.
- Imports/pastes should choose/require parent when making connected children; otherwise use `parent: null`.

## Manifest/Layout

- On add/delete `.md`, update `manifest.json`.
- Manifest = sorted JSON array of `.md` paths relative to note root.
- Manifest lists Markdown only; no `layout.json`, media, dirs, non-md.
- If deleting/renaming and touching `layout.json`, remove/rename stale keys only; do not invent hierarchy there.
- Opened folders can still load files not in manifest, but seed preview needs manifest parity.

## Edits

- Before edit: read current note set + manifest; detect existing hierarchy.
- Connect/reparent: change only the child `parent`; descendants derive depth automatically.
- If an existing note has legacy `level`, remove it the next time you rewrite that note.
- Delete parent: children may keep broken parents unless user asks reparent.
- Avoid duplicate titles/aliases; duplicate aliases make refs ambiguous.
- Keep unknown/private content out of repo sample notes.

## Validate

Before done:
- all notes: frontmatter present; only 2 keys; title present.
- parents: null or exactly one `[[...]]`; resolves uniquely; no missing parent; no cycles.
- connected notes: every child has exactly one immediate parent.
- body links: references only; no hierarchy encoded in body text.
- manifest: missing/extra paths fixed; all paths `.md`, relative, sorted.
- layout: no stale path keys if edited.
- annotations, if edited: schema/limits valid, IDs unique/stable, unrelated items retained, workspace reopened and visual placement checked (or explicitly report that visual verification was unavailable).
- date metadata: preserved, not generated from guessed history.

Report compactly: `notes=N parentless=N connected=N manifest_missing=N manifest_extra=N fixes=[...]`.
