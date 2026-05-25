# Release Automation

Apex Notes is open source, but public macOS downloads need a stricter release boundary than normal pull request checks.

## What Runs Automatically

On every push to `main`, `.github/workflows/release-latest.yml` checks `package.json` and looks for a matching GitHub Release tag:

```text
package.json version 0.1.9 -> release tag v0.1.9
```

If that release already exists, the workflow stops.

If the release is missing, the workflow requests the protected `release` environment and waits for maintainer approval before it can access Apple signing credentials.

## Open Source Safety Model

- Pull requests never receive Apple signing or notarization secrets.
- The publish job runs only in `boriemannetje/apex-notes`.
- The publish job checks out the approved `main` commit by SHA.
- GitHub Release write access is scoped to the publish job only.
- Apple credentials should be stored as environment secrets on the protected `release` environment, not as broad repository secrets.

## Required Environment Secrets

Configure these on the GitHub `release` environment:

```text
APPLE_CERTIFICATE_P12_BASE64
APPLE_CERTIFICATE_PASSWORD
APPLE_TEAM_ID
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
```

Optional:

```text
APPLE_SIGNING_IDENTITY
```

`APPLE_CERTIFICATE_P12_BASE64` should be the base64 text of a Developer ID Application `.p12` certificate export. The password for that export goes in `APPLE_CERTIFICATE_PASSWORD`.

Use an Apple app-specific password for `APPLE_APP_SPECIFIC_PASSWORD`, not the main Apple account password.

## Website Download Path

The Netlify site does not need a separate deploy for a new app build. Its Terminal installer resolves the latest DMG through:

```text
https://api.github.com/repos/boriemannetje/apex-notes/releases/latest
```

After the workflow publishes a new GitHub Release, the website installer automatically uses that release.
