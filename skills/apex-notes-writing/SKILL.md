---
name: apex-notes-writing
description: Use when creating, editing, tagging, or connecting notes for Apex Notes, a Markdown hierarchy app that stores notes under notes/. Enforces required frontmatter, optional parent hierarchy edges, unbounded depth levels, contextual dotted reference links, manifest updates, and the rule that body links are not hierarchy.
---

# Apex Notes Writing

## Scope

Use this skill whenever writing or changing Markdown notes in a `notes/` folder managed by this app.

The source of truth is the Markdown files in `notes/`. When a note has a `parent`, the app derives hierarchy from that frontmatter edge and derives the note's true depth from that parent tree. Notes without parents may intentionally exist as loose notes or roots of independent hierarchies.

## Required Frontmatter

Every note must start with exactly one YAML frontmatter block using this shape:

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
- Treat `level` as cached depth metadata: compute it from the parent chain when present and keep it correct, but do not use it as the canonical hierarchy edge.
- Levels are unbounded depth numbers. Do not assign names to levels.

Do not add schema fields beyond `title`, `level`, and `parent` unless the user explicitly changes the schema.

## Canonical Connection Rule

`parent` is the only canonical hierarchy edge when present. A `level` mismatch is repairable metadata drift; a wrong `parent` is a structural hierarchy problem.

- Use `parent: null` for loose notes and roots of independent hierarchies.
- A note either has no parent or exactly one immediate parent.
- Multiple independent hierarchies may live in one folder.
- When present, the parent defines the child's level: set the child level to the parent's derived level plus one.
- Use a wiki link to the parent file stem, preserving the existing style:

```yaml
parent: "[[parent-note]]"
```

Body links are only contextual references. Never rely on body links to define hierarchy.

## Contextual Reference Links

Create dotted, non-hierarchy connections by adding wiki links in the note body:

```md
This depends on [[related-note]] and also touches [[another-note|a readable label]].
```

Rules:

- Use body links to tag or reference other existing nodes that are contextually related.
- Link by file stem, title, slug, or path when it resolves clearly to one note.
- Use aliases with `[[target-note|label]]` when the sentence should read naturally.
- Do not use a body link instead of `parent`; hierarchy still belongs only in frontmatter.
- Do not add body links to every ancestor. Add them only when the body text is genuinely about that other node.

The app renders resolved body links as dotted reference lines between nodes. Broken links stay visible in the editor as missing links and do not create a graph edge.

## Placement Rules

- Preserve existing filenames when editing existing notes.
- For new notes, choose a stable filename. The visible graph label comes from `title`.
- Subfolders are allowed, but folder names do not define hierarchy; `parent` does.

Place each new connected note under the immediate parent that best represents where it belongs. If the note is intentionally loose or starts a separate hierarchy, use `parent: null` and `level: 0`. Do not create category names or intermediate levels unless the user's graph actually needs those nodes.

## Writing Workflow

Before editing:

1. Decide whether the note should be loose, a root, or connected to an existing parent.
2. If using a parent, read that parent note and verify it exists.
3. Derive the level from the parent chain when present, then write that level into frontmatter (`parent depth + 1`, or `0` for loose/root notes).

When adding a note:

1. Put it in the correct folder.
2. Add the required frontmatter first.
3. Set `parent` to the immediate parent, or to `null` when intentionally loose/root.
4. Write concise body text with an H1 matching the title when useful.
5. Add body links only for contextual references.
6. Update `notes/manifest.json` with the new path relative to `notes/`.

When deleting a note:

1. Remove it from `notes/manifest.json`.
2. Check for children that use it as `parent` and re-parent them only if the user asked for that structural change.

When editing a note:

- Keep the filename stable unless the user explicitly wants a rename.
- Do not change `parent` casually; that is a graph structure change.
- If `level` disagrees with the parent-derived depth, repair `level` without treating that alone as a reparenting.
- If you do change structure, recompute and repair levels for affected descendants.

## Examples

Child under a root:

```yaml
---
title: "Example Child"
level: 1
parent: "[[apex]]"
---
```

Deeper child:

```yaml
---
title: "Example Deeper Child"
level: 2
parent: "[[example-child]]"
---
```

Loose note or independent root:

```yaml
---
title: "Example Loose Note"
level: 0
parent: null
---
```

## Final Check

Before finishing, confirm:

- All edited notes have valid frontmatter.
- Parentless notes are intentional loose/root notes, not accidental omissions.
- Each connected child has one immediate parent.
- No body link is being used as the hierarchy edge.
- `notes/manifest.json` changed only if note files were added or deleted.
and verify:

Build hierarchy edges from `parent` frontmatter only, derive levels for connected trees, then verify and repair cached levels plus manifest connectivity.
Requirements:
1. Parentless notes are allowed; each should use `parent: null` and `level: 0`.
2. Every connected child has a single `parent` in format `[[file-stem]]`, and its parent must be an existing note.
3. Multiple roots or independent hierarchies in one folder are valid.
4. Make all present parent relationships canonical and set each connected child `level` to the derived depth; use body wiki links only as contextual references, never hierarchy.
5. If any `manifest.json` entry references a missing file, remove it, or add the file if creating new notes.
6. Before finishing, report a validation check with counts: total notes, #parentless notes, #connected notes with valid parent chain, #manifest missing entries, and explicit list of fixes made.
