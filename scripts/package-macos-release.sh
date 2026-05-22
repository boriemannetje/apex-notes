#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/Apex Notes.app"
DMG_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"
DMG_NAME="Apex Notes_${VERSION}_aarch64.dmg"
DMG_PATH="$DMG_DIR/$DMG_NAME"

find_signing_identity() {
  if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    printf '%s\n' "$APPLE_SIGNING_IDENTITY"
    return 0
  fi

  security find-identity -v -p codesigning 2>/dev/null | awk -F '"' '
    /Developer ID Application/ { print $2; found = 1; exit }
    /Apple Development/ && candidate == "" { candidate = $2 }
    END {
      if (!found && candidate != "") {
        print candidate
      }
    }
  '
}

if [[ "${APEX_NOTES_ALLOW_ADHOC:-}" == "1" ]]; then
  SIGNING_IDENTITY="-"
else
  SIGNING_IDENTITY="$(find_signing_identity)"
fi

if [[ -z "$SIGNING_IDENTITY" ]]; then
  printf 'No macOS code signing identity found. Set APPLE_SIGNING_IDENTITY or use APEX_NOTES_ALLOW_ADHOC=1 for a local-only smoke package.\n' >&2
  exit 1
fi

if [[ "$SIGNING_IDENTITY" == "-" ]]; then
  printf 'Signing ad-hoc. Do not use this artifact for a public macOS download.\n' >&2
else
  printf 'Signing with identity: %s\n' "$SIGNING_IDENTITY"
fi

rm -rf "$APP_PATH" "$DMG_PATH"

npm run build:web:prod
npx tauri build --bundles app,dmg --no-sign

codesign --force --deep --options runtime --sign "$SIGNING_IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

rm -f "$DMG_PATH"
(
  cd "$DMG_DIR"
  ./bundle_dmg.sh \
    --volname "Apex Notes" \
    --volicon "icon.icns" \
    --icon-size 128 \
    --window-size 660 400 \
    --app-drop-link 480 170 \
    --icon "Apex Notes.app" 180 170 \
    "$DMG_NAME" \
    "../macos"
)

hdiutil verify "$DMG_PATH"

MOUNT_DIR="$(mktemp -d)"
cleanup() {
  hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  rm -rf "$MOUNT_DIR"
}
trap cleanup EXIT

hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$DMG_PATH" >/dev/null
codesign --verify --deep --strict --verbose=2 "$MOUNT_DIR/Apex Notes.app"

printf 'Created verified DMG: %s\n' "$DMG_PATH"
