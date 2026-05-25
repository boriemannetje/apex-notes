# Release Automation

Apex Notes is open source, and `main` is production.

## What Runs Automatically

On every push to `main`, `.github/workflows/release-latest.yml` builds the app and publishes a rolling GitHub Release:

```text
main branch -> main-production release tag
```

The release assets are overwritten on every successful `main` build, even when `package.json` keeps the same app version.

## Open Source Safety Model

- Pull requests do not publish production downloads.
- The publish job runs only in `boriemannetje/apex-notes`.
- The publish job checks out the exact `main` commit by SHA.
- GitHub Release write access is scoped to the publish job only.
- The rolling release publishes a Terminal-installable ad-hoc signed DMG. The website install command still verifies the DMG and installed app with `codesign --verify --deep --strict`.

## Website Download Path

The Netlify site does not need a separate deploy for a new app build. Its Terminal installer resolves the production DMG through:

```text
https://api.github.com/repos/boriemannetje/apex-notes/releases/tags/main-production
```

After the workflow updates the rolling GitHub Release, the website installer automatically uses that main build.
