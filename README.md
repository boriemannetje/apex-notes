# Apex Notes

Apex Notes is a local desktop app for editing Markdown note hierarchies.

The graph is derived from frontmatter: `parent` creates hierarchy edges when present, and body `[[wiki links]]` create solid, semi-transparent contextual connections.

Download the latest build at [apex-notes.netlify.app](https://apex-notes.netlify.app) or from [GitHub Releases](https://github.com/boriemannetje/apex-notes/releases).

## Features

- Local-first Markdown notes
- Native folder access through Tauri
- Tree edges from frontmatter `parent`
- Semi-transparent reference edges from body `[[wiki links]]`
- Minimal, draggable graph view
- Bundled writing-agent skill in `skills/apex-notes-writing/`

## Run

```sh
npm install
npm run dev
```

This opens the Tauri desktop app. The desktop app uses native folder dialogs and Rust filesystem commands for local Markdown reads/writes.
`npm run serve` is used internally by `tauri dev` to host the frontend during local development; the app itself expects the Tauri shell for folder access and Trash support.

Click `Open notes folder` to edit an existing graph, or `Create folder` to start a new writable graph.

## Build

```sh
npm run build
```

This creates the production web bundle first, then runs the Tauri desktop build.

To verify the Netlify/static web build without creating a desktop bundle:

```sh
npm run build:site
```

## Contributing

This repository is ready for forks, issues, and pull requests. Start with:

- [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, review expectations, and note schema rules
- [SECURITY.md](SECURITY.md) for private vulnerability reporting
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for collaboration expectations
- [docs/release-checklist.md](docs/release-checklist.md) for release steps

Small, focused pull requests are easiest to review. For larger changes, open an issue first with the workflow, affected files, and testing plan.

This public repository contains the app source, neutral sample notes, and the bundled writing skill. It should not contain private notes, user-specific vaults, separate marketing-site source, or generated release bundles.

## Data

Markdown files live in `notes/`. The bundled folder contains only neutral starter data.

### Automatic note dates

The note editor shows creation and last-edit dates below the title. Last edited reflects the file's modification time in the device's current timezone. Consecutive nonblank lines last written or edited on the same calendar day share one quiet date label after the group's last line. Editing an older line updates that line's day; undo/redo restores its date attribution with the text. Blank spacing and soft wrapping do not create extra date labels.

Dates are stored in `notes/dates.json`, not in Markdown or frontmatter. Keep this sidecar with a folder when moving or backing it up to retain precise attribution. Existing `Written` and `Added` date markers are preserved and recognized; otherwise dates are estimated from filesystem timestamps and marked `≈`. External edits preserve confidently matched unchanged lines and estimate the changed lines' day. Stored calendar days do not shift when changing timezones. Dates have no manual correction control.

Invalid or unsupported date metadata is left untouched and reported without blocking Markdown editing. Date tracking is bounded to 20,000 notes, 100,000 lines per note, 200,000 lines per workspace and a 16 MiB sidecar; exceeding those limits leaves Markdown usable and reports a date-metadata warning.

The graph uses frontmatter, not body links, for hierarchy. `parent` is the canonical hierarchy edge when present. Parentless notes are valid loose notes or independent roots, and connected-note depth is derived from the parent chain. Legacy `level` frontmatter is ignored and may be removed when a note is rewritten.

See `AGENTS.md` before creating or linking notes.

## Writing Skill

The reusable writing-agent skill lives at:

```text
skills/apex-notes-writing/SKILL.md
```

Put that skill in your note-taking folder or agent skill folder so a writing agent knows how to create notes, set `parent`, update `manifest.json`, and add contextual reference links through body wiki links.

## Website

The public download site is deployed separately. This repository contains the open-source app, neutral sample notes, and writing skill, not the website source.

To verify the static web shell in this repo:

```sh
npm run build:site
```

Native folder access and Trash support still require the packaged Tauri desktop app. For a desktop release, run `npm run build`, then publish the generated artifacts from `src-tauri/target/release/bundle/` to GitHub Releases. Keep download links pointed at the latest release artifacts rather than committing binaries to the repository.

## License

MIT
