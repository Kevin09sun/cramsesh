# Choose a Folder for an Existing Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A test with no stored materials folder shows **Choose folder…**. Picking a folder stores it and starts a re-sweep.

**Architecture:** Move `sweep_materials`' folder validation into one shared helper. `POST /api/tests/[id]/sweep` accepts an optional `{ folder }` (only for a test with no folder) and uses that helper, then `setFolder` + `startResweep`. The readiness page swaps the disabled Re-sweep button for a Choose folder… button that uses the existing native folder pickers.

**Tech Stack:** Next.js 16 route handlers, React client component, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-11-21-test-folder-picker-design.md`

## Global Constraints

- A stored folder is never replaced: a body `folder` on a test that already has one → 409.
- Folder rules are identical to `sweep_materials`: `resolveSourcePath(input, resolvePolicy())`; refuse home folder and drive/filesystem root; must be an existing readable directory; empty/whitespace refused.
- POST with no body keeps today's behaviour exactly (400 `"no folder stored for this test"` when no folder).
- Run tests with Git Bash: `NODE_ENV=test ./node_modules/.bin/tsx --test <files>` (`npm test` does not work on this machine).

## Review Focus

- POST body that is not JSON / `folder` not a string → 400, no sweep, no folder stored (Task 2 test).
- Folder valid but a sweep is already running or additions pending → existing 409, and the folder is NOT stored (Task 2 test: gates run before `setFolder`).
- User cancels the folder dialog → no request sent, page unchanged (Task 3 test).
- Server refuses the folder (400) → the error text shows on the page and the button stays (Task 3 test).
- Picker unavailable (`requestNativePaths` → `null`) → notice "The folder picker is not available on this system." and no POST (Task 3 test).

---

### Task 1: Shared folder validation helper

**Files:**
- Create: `src/agent/tools/sweep-folder.ts`
- Modify: `src/agent/tools/test-prep.ts` (the `sweep_materials` execute body, ~lines 400-425; move `samePath` into the new file)
- Test: `tests/sweep-folder.test.ts`; existing `tests/test-prep-tools.test.ts` (`describe("sweep_materials")`) must stay green unchanged

**Interfaces:**
- Produces: `export async function resolveSweepFolder(input: string): Promise<{ ok: true; folder: string } | { ok: false; error: string }>`
  - error strings are exactly the ones `sweep_materials` returns today:
    - empty/whitespace → `"folder is required — pass the folder the learner attached"`
    - home or root → `"that is your whole home folder / drive — pass the folder with the test materials"`
    - other failure → `` `folder not found or not a readable directory: ${input} (${reason})` ``

- [ ] **Step 1: Write failing tests** in `tests/sweep-folder.test.ts`:
  - `resolveSweepFolder(tmpDir)` → `{ ok: true, folder: <resolved tmpDir> }`
  - `resolveSweepFolder("   ")` → `ok: false`, error is the "folder is required" string
  - `resolveSweepFolder(os.homedir())` → `ok: false`, error is the "whole home folder / drive" string
  - `resolveSweepFolder(path.parse(tmpDir).root)` → same "whole home folder / drive" error
  - `resolveSweepFolder(path.join(tmpDir, "missing"))` → `ok: false`, error starts with `"folder not found or not a readable directory: "`
  - a file path (not a directory) → `ok: false`, same prefix
  (Note: the file-access policy may deny paths outside allowed roots. Use the same tmp setup `tests/test-prep-tools.test.ts` uses for its sweep_materials folder tests.)
- [ ] **Step 2: Run** `NODE_ENV=test ./node_modules/.bin/tsx --test tests/sweep-folder.test.ts` → FAIL (module not found)
- [ ] **Step 3: Implement** `resolveSweepFolder` by moving the validation (and `samePath`) out of `sweep_materials`. Then make `sweep_materials` call it and return `invalidInputResult("sweep_materials", [result.error])` on failure.
- [ ] **Step 4: Run** `NODE_ENV=test ./node_modules/.bin/tsx --test tests/sweep-folder.test.ts tests/test-prep-tools.test.ts` → all pass
- [ ] **Step 5: Commit** `refactor(sweep): share folder validation between sweep_materials and the route`

### Task 2: Route accepts a folder for a folderless test

**Files:**
- Modify: `app/api/tests/[id]/sweep/route.ts` (POST; update the header comment's contract)
- Test: `tests/test-sweep-api.test.ts` (add to `describe("POST /api/tests/[id]/sweep")`; add a `postSweepWithBody(id, body, origin = BASE)` helper sending JSON)

**Interfaces:**
- Consumes: `resolveSweepFolder` (Task 1); `stores.testStore.setFolder(id, folder)`; `startResweep(id)`
- Produces: `POST /api/tests/[id]/sweep` with body `{ folder: string }` → 202 `{ started: true }` and the folder stored; JSON errors `{ error }`

Order inside POST: same-origin → 404 → `recoverInterruptedSweep` → read body (an empty body means no folder) → **if folder given and the record already has a folder → 409 `"This test already has a folder."`** → if neither body folder nor stored folder → 400 (unchanged text) → running 409 → pending-additions 409 → if folder given: `resolveSweepFolder`, failure → 400 `{ error }`, success → `setFolder` → `startResweep` → 202.

- [ ] **Step 1: Write failing tests:**
  - "stores the chosen folder and starts a re-sweep": test with no folder, body `{ folder: FOLDER }` (mkdir it) → 202, `testStore.get(id).folder` equals the resolved FOLDER, `resweepCalls.length === 1`
  - "is a 409 when a folder is already stored": `testStore.setFolder` first, body folder → 409, error `"This test already has a folder."`, folder unchanged, no call
  - "is a 400 for a folder that does not exist": → 400, error starts with `"folder not found or not a readable directory: "`, record has no folder, no call
  - "is a 400 when folder is not a string" (`{ folder: 5 }`) and for an unparseable body → 400, no folder stored, no call
  - "does not store the folder while additions await review": no folder, `pendingAdditions` set (as the existing 409 test does), body folder → 409, record still has no folder
- [ ] **Step 2: Run** `NODE_ENV=test ./node_modules/.bin/tsx --test tests/test-sweep-api.test.ts` → new tests FAIL, old pass
- [ ] **Step 3: Implement** the order above in `POST`
- [ ] **Step 4: Run** the same command → all pass
- [ ] **Step 5: Commit** `feat(tests): choose a materials folder for a test that has none`

### Task 3: Choose folder… on the readiness page

**Files:**
- Modify: `components/test-prep/readiness-view.tsx` (header buttons ~line 313; `resweep()` ~line 221)
- Test: `tests/test-prep-readiness.test.tsx` (replace the test "Re-sweep folder is disabled without a stored folder")

**Interfaces:**
- Consumes: `requestNativePaths("folder")` and `FilePickerBusy`, `PICKER_BUSY_NOTICE` from `components/attach-files-button.tsx`; `window.lh?.chooseAttachmentFolder`; route from Task 2
- Produces: button `data-testid="choose-folder"`, label `Choose folder…`, shown only when `!test.folder` (then `resweep-folder` is not rendered)

Behaviour: click → desktop `window.lh.chooseAttachmentFolder()` (null = cancel) else `requestNativePaths("folder")` (`null` = unavailable → error "The folder picker is not available on this system."; `[]` = cancel; first path otherwise). Errors use `FilePickerBusy` → `PICKER_BUSY_NOTICE`, otherwise "Could not choose a folder. Try again.". Then POST `/api/tests/${id}/sweep` with JSON `{ folder }` and reuse the existing `resweep()` success/error handling (refactor `resweep` to take an optional `folder` and send it as a body). While the picker or POST is in flight, the button is disabled.

- [ ] **Step 1: Write failing tests** (stub `fetch` via `mount`; stub `/api/path-picker` responses in the fetch stub):
  - no folder → `choose-folder` present, `resweep-folder` absent
  - folder set → `resweep-folder` present, `choose-folder` absent
  - click with picker answering `{ paths: ["C:\\notes\\sbi4u"] }` → a POST to `/api/tests/<id>/sweep` with body `{ folder: "C:\\notes\\sbi4u" }`
  - picker answering `{ paths: [] }` → no sweep POST
  - picker 501 → no sweep POST; text "The folder picker is not available on this system." rendered
  - sweep POST answering 400 `{ error: "folder not found or not a readable directory: x (y)" }` → that text rendered, `choose-folder` still present
- [ ] **Step 2: Run** `NODE_ENV=test ./node_modules/.bin/tsx --test tests/test-prep-readiness.test.tsx` → new tests FAIL
- [ ] **Step 3: Implement** as described
- [ ] **Step 4: Run** the same command → all pass
- [ ] **Step 5: Commit** `feat(tests): Choose folder… on a test with no stored folder`

### Task 4: Verify

- [ ] `npm run typecheck` and `npm run lint` clean
- [ ] `NODE_ENV=test ./node_modules/.bin/tsx --test tests/sweep-folder.test.ts tests/test-sweep-api.test.ts tests/test-prep-readiness.test.tsx tests/test-prep-tools.test.ts tests/sweep-run.test.ts tests/sweep-transcribe.test.ts` all pass
- [ ] `npm run build` succeeds (retry once if the Next.js security check halts it)
