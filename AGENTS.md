# Agent Instructions

This repository is a local-first Markdown hierarchy app. The bundled `notes/` folder is neutral sample data only. Do not put private or user-specific notes in the app repository.

## Required Frontmatter

Every note must start with this shape:

```yaml
---
title: "Human Readable Title"
level: 0
parent: null
---
```

Level semantics:

- `0` is a root depth, not a guarantee that there is only one apex in the folder.
- A note with `parent: null` may be a loose note or the root of an independent hierarchy.
- A note with a parent has level `parent.level + 1`.
- Levels are unbounded depth numbers. Do not assign names to levels.

## Canonical Linking Rule

The `parent` property is the only canonical hierarchy edge when present.

Use `parent: null` for loose notes and roots of independent hierarchies.

For every connected child note, `parent` must point to exactly one immediate parent:

```yaml
parent: "[[parent-note]]"
```

The parent must be exactly one level above the child. Multiple independent hierarchies may live in one folder.

Do not use body links to define hierarchy. Body links are contextual references only.

## File Naming

Preserve existing filenames when editing existing notes.

For new notes, use a stable Markdown filename and a display title:

```yaml
title: "Example Child"
```

The graph displays `title`, not the filename.

Use stable Markdown filenames. Subfolders are allowed, but folder names do not define hierarchy; `parent` does.

## Manifest

When adding or deleting Markdown files, update `notes/manifest.json`.

The local app can read files directly after the user opens the notes folder, but `manifest.json` keeps the seed preview working before folder access is granted.

## Strict Separation

Do not add schema fields beyond `title`, `level`, and `parent` unless the schema is explicitly changed. The app derives children from each present parent edge.
