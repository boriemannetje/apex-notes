# Apex Notes

Apex Notes is a local desktop app for editing a Markdown note hierarchy.

The graph is derived from frontmatter: `parent` creates the tree, and body `[[wiki links]]` create dotted contextual connections.

Download the latest build at [apex-notes.netlify.app](https://apex-notes.netlify.app) or from [GitHub Releases](https://github.com/boriemannetje/apex-notes/releases).

## Features

- Local-first Markdown notes
- Native folder access through Tauri
- Tree edges from frontmatter `parent`
- Dotted reference edges from body `[[wiki links]]`
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

The graph uses frontmatter, not body links, for hierarchy. `level` is an unbounded depth number: the apex is `0`, and every child is one deeper than its parent.

See `AGENTS.md` before creating or linking notes.

## Writing Skill

The reusable writing-agent skill lives at:

```text
skills/apex-notes-writing/SKILL.md
```

Put that skill in your note-taking folder or agent skill folder so a writing agent knows how to create notes, set `parent`, update `manifest.json`, and add dotted reference links through body wiki links.

## Website

The public download site is deployed separately. This repository contains the open-source app, neutral sample notes, and writing skill, not the website source.

To verify the static web shell in this repo:

```sh
npm run build:site
```

Native folder access and Trash support still require the packaged Tauri desktop app. For a desktop release, run `npm run build`, then publish the generated artifacts from `src-tauri/target/release/bundle/` to GitHub Releases. Keep download links pointed at the latest release artifacts rather than committing binaries to the repository.

## License

MIT
