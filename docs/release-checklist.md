# Release Checklist

Use this when preparing a public Apex Notes release.

## Preflight

- Confirm the public app repo does not include private notes, separate marketing-site source, or generated bundles.
- Confirm `notes/` contains only neutral sample data.
- Confirm note frontmatter uses only `title` and `parent`; legacy `level` fields are ignored and may be removed on rewrite.
- Decide the release version and update every versioned file in the same change.

## Validate

```sh
npm test
cargo check --manifest-path src-tauri/Cargo.toml
APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team>)" npm run package:mac
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/Apex Notes.app"
hdiutil verify "src-tauri/target/release/bundle/dmg/Apex Notes_<version>_aarch64.dmg"
xcrun stapler validate "src-tauri/target/release/bundle/dmg/Apex Notes_<version>_aarch64.dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "src-tauri/target/release/bundle/dmg/Apex Notes_<version>_aarch64.dmg"
```

For UI, workspace, parser, or filesystem changes, also smoke test the built app with a small synthetic notes folder.

## Package

- Use the generated Tauri release artifacts from `src-tauri/target/release/bundle/`.
- Public macOS downloads must be signed with a Developer ID Application certificate, notarized with Apple, and stapled before upload. An Apple Development signature can pass `codesign` but still fail Gatekeeper for downloaded apps.
- `npm run package:mac` rebuilds the Tauri app, signs the `.app`, regenerates the DMG from the signed app, and verifies the mounted app from the DMG. Do not upload a raw `tauri build` DMG.
- `APEX_NOTES_ALLOW_ADHOC=1 npm run package:mac` is only for local install-script smoke tests; do not use ad-hoc artifacts for public releases.
- If macOS signature verification fails, re-sign the generated app bundle before creating the DMG.
- Rename uploaded release assets predictably, for example `apex-notes-<version>-macos-arm64.dmg`.
- Include the writing-agent skill as a release asset if it changed.
- Do not commit generated bundles back into the repository.

## Publish

- For routine production releases, push to `main` and let the rolling `main-production` GitHub Actions flow in [release-automation.md](release-automation.md) publish the build.
- Create a separate versioned GitHub Release with a short changelog, testing notes, and known limitations only when you intentionally want a stable archive tag.
- Mark security-sensitive fixes carefully and avoid exploit details until disclosure is appropriate.
- The Netlify website installer reads the rolling GitHub `main-production` release; only update the separate website/download page when its copy or install command changes.
- Verify the public download link points at the current `main-production` release.

## After Release

- Open a fresh install and verify the app version and basic folder open/create flows.
- Watch issues for installation, permissions, or data-loss reports.
- If a release must be pulled, update the GitHub Release notes and website link quickly.
