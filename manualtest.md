If this file is sent to you, the user wants to manually test the native Apex Notes app. Install the app that includes the newest PR changes, then leave it open for the user.

## Manual Test Handoff

1. Check the repo state first.
   - Run `git status --short --branch`.
   - If the working tree contains unrelated local note edits, do not stage or overwrite them. Build from a clean temporary worktree at the current branch HEAD instead.
   - After creating a temporary worktree, `cd` into it or set the command working directory to that path before running install or package commands.
   - Confirm `git rev-parse --show-toplevel` prints the temporary worktree path, not the original dirty checkout.

2. Close old running copies.
   - Quit `Apex Notes` if it is running.
   - Confirm the app that remains installed is `/Applications/Apex Notes.app`.

3. Build and package the current changes.
   - Run `APEX_NOTES_ALLOW_ADHOC=1 npm run package:mac`.
   - If building from a fresh temporary worktree, run `npm ci` there before packaging if dependencies are missing.
   - Confirm the command creates both:
     - `src-tauri/target/release/bundle/macos/Apex Notes.app`
     - `src-tauri/target/release/bundle/dmg/Apex Notes_*.dmg`

4. Replace the installed app.
   - Remove `/Applications/Apex Notes.app`.
   - Copy the newly built `Apex Notes.app` into `/Applications` using `ditto`.

5. Verify the installed app.
   - Run `codesign --verify --deep --strict "/Applications/Apex Notes.app"`.
   - If verification fails after copying, run `codesign --force --deep --sign - "/Applications/Apex Notes.app"` and verify again.
   - Clear quarantine if needed with `xattr -dr com.apple.quarantine "/Applications/Apex Notes.app"`.
   - Read `CFBundleShortVersionString` from `/Applications/Apex Notes.app/Contents/Info.plist`.

6. Open the fresh install.
   - Run `open -n "/Applications/Apex Notes.app"`.
   - Confirm the running process path is `/Applications/Apex Notes.app/Contents/MacOS/hierarchical_agent_managed_knowledge_graph`.
   - Stop here and let the user manually test.
