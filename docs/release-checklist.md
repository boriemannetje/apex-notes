# Release Checklist

Use this when preparing a public Apex Notes release.

## Preflight

- Confirm the public app repo does not include private notes, separate marketing-site source, or generated bundles.
- Confirm `notes/` contains only neutral sample data.
- Confirm note frontmatter uses only `title`, `level`, and `parent`.
- Decide the release version and update every versioned file in the same change.

## Validate

```sh
npm run build:web
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/Apex Notes.app"
hdiutil verify "src-tauri/target/release/bundle/dmg/Apex Notes_<version>_aarch64.dmg"
```

For UI, workspace, parser, or filesystem changes, also smoke test the built app with a small synthetic notes folder.

## Package

- Use the generated Tauri release artifacts from `src-tauri/target/release/bundle/`.
- If macOS signature verification fails, re-sign the generated app bundle before creating or uploading the DMG.
- Rename uploaded release assets predictably, for example `apex-notes-<version>-macos-arm64.dmg`.
- Include the writing-agent skill as a release asset if it changed.
- Do not commit generated bundles back into the repository.

## Publish

- Create a GitHub Release with a short changelog, testing notes, and known limitations.
- Mark security-sensitive fixes carefully and avoid exploit details until disclosure is appropriate.
- Update the separate website/download page after the release assets are live.
- Verify the public download link points at the new release.

## After Release

- Open a fresh install and verify the app version and basic folder open/create flows.
- Watch issues for installation, permissions, or data-loss reports.
- If a release must be pulled, update the GitHub Release notes and website link quickly.
