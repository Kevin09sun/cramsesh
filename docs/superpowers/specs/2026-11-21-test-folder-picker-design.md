# Choose a materials folder for an existing test — design

Date: 2026-11-21 · Size: small change

## Why
Tests made before the test-material sweep (2026-11-21 merge, PR #10) have no
stored `folder`, so the **Re-sweep folder** button is disabled
("This test has no stored folder") and there is no way to add one. The learner
wants the SBI4U test to read its materials, .docx files and their images
included, without losing the 17/41 points of progress it already holds.

## Goals
- On a test with no stored folder, the learner can pick one and the test reads it.
- Choosing the folder starts a re-sweep immediately. New items arrive as the
  existing "review the new items" card, as Re-sweep does today.

## Non-goals (owner-decided)
- No changing or replacing a folder once one is stored.
- No practice-test work (dropped).
- No changes to chat-attachment or notes-import file reading.

## Approaches considered
1. **Folder picker on the test page (chosen).** Reuses the native folder dialog
   chat attachments already use, plus the existing re-sweep path. Progress kept.
2. New test with the folder attached. No code, but readiness restarts from zero.
3. Hand-edit the test's JSON once. Fast, but older tests stay stuck.

## Design
- **UI** (`components/test-prep/readiness-view.tsx`): when `!test.folder`, the
  header shows **Choose folder…** where the disabled Re-sweep button is now
  *(builder call: replace rather than show both)*. On click it opens the folder
  dialog the same way `attach-files-button.tsx` does:
  `window.lh.chooseAttachmentFolder` in the desktop app, else
  `requestNativePaths("folder")` (`/api/path-picker`). Cancel does nothing.
  Picker unavailable (501) or busy (409) shows the same notices as the
  attach button. After a successful launch the page shows sweep progress
  exactly as a Re-sweep does. Once the folder is stored, the button is gone
  and the normal Re-sweep button takes its place.
- **Server**: `POST /api/tests/[id]/sweep` accepts an optional JSON body
  `{ folder }`. It is honoured only when the test has no stored folder; if
  one is already stored, the request gets a 409 *(builder call: one launch
  path keeps every existing gate: same-origin, running, pending additions)*.
  The folder is validated with the **same rules as the `sweep_materials`
  tool**: `resolveSourcePath` with the current policy, refuse the home folder or
  a drive root, must be an existing readable directory. Failures → 400 with the
  reason. On success: `setFolder`, then `startResweep`, then 202.
- **Shared validation**: move the folder checks out of `sweep_materials`
  (`src/agent/tools/test-prep.ts`) into one helper that both callers use, so
  the rules can't drift apart.

## Tests
- Route: sets the folder and starts the sweep; rejects a missing directory, the
  home folder, a drive root, and a test that already has a folder; existing
  sweep-route tests stay green.
- `sweep_materials` behaviour unchanged after the helper extraction (existing
  tests).
- UI: Choose folder… shows only when no folder is stored; Re-sweep shows otherwise.

## Left to the builder
Exact button styling and wording of error text, which follow the existing
readiness-page buttons and attach-button notices.
