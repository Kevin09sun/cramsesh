# Test Material Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test mode reads every file and page in the learner's materials folder (PDF, PPTX, DOCX, text, images — figures/scans via the vision slot), and proposes a plan of one point per skill archetype and one per must-know fact, with noise in a recoverable "Left out" list, a coverage line, and an incremental "Re-sweep folder" action.

**Architecture:** A new sweep pipeline under `src/agent/subagents/sweep/` (enumerate → transcribe → cheap-slot chunk extraction → strong-slot merge → validated save) callable two ways: as a new `"sweep"` job kind launched by the test-prep tool `sweep_materials` (delivers a steer into the chat), and directly from a re-sweep API route (no chat). Test records gain optional `leftOut`, `sweep`, `pendingAdditions` fields; pure rules live in `src/core/test-prep.ts`, persistence in `src/store/tests.ts`, UI in `components/test-prep/`.

**Tech Stack:** TypeScript, Next.js 16 App Router, pi-agent-core sub-agents (`runSubmitAgent`, `runSubagent`), pdfjs-dist + native render (`getHeadless().renderPdfPages`), new deps `jszip` (pptx) and `mammoth` (docx), node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-11-20-test-material-sweep-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing any route or page code (AGENTS.md: this Next.js has breaking changes).
- Run tests with the Bash tool: `NODE_ENV=test ./node_modules/.bin/tsx --test <files>` (`npm test` fails on this machine). `npm run typecheck` and `npm run lint` work normally.
- The full suite has ~23 known Windows-only failures; compare failing test names against a baseline taken on `main` before Task 1, never expect fully green.
- All new `TestRecord` fields are optional; existing test files must still load (`isTestRecord`) and `version` stays `1`.
- A sweep never modifies existing points, statuses or history. Only the first sweep saves sections; re-sweep writes only `pendingAdditions`.
- Model roles: `sweepReader` → `vision`, `sweepExtractor` → `cheap`, `sweepMerger` → `strong` (via `ROLE_SLOT`).
- Supported sweep file types: `.pdf`, `.pptx`, `.docx`, `.md`, `.markdown`, `.txt`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`. Everything else → coverage `unsupported`.
- Source strings: `"<relative path> p. N"` (PDF), `"<relative path> slide N"` (pptx), `"<relative path>"` (docx/text/image), relative to the test's folder, forward slashes.
- The agent layer never imports store adapters: inject via ports (existing `TestPrepStore` idiom).
- Branch: `feat/test-sweep` (already created; spec committed as `cffae06`).

## Review Focus

1. **Second `sweep_materials` call** (model retry, continued sitting) when a plan already exists → refused with a message pointing to Re-sweep; plan untouched. *(Task 7 test)*
2. **Encrypted / corrupt PDF or a vision call that throws** → file/page lands in `coverage.unreadable` with a reason, sweep continues with other files, never reported as `empty`. *(Task 4 test)*
3. **Merger returns invalid output twice** (empty sections or point without source) → sweep `status: "error"`, no sections saved, error names what was read. *(Task 6 test)*
4. **Re-sweep with no changed files** → completes with no `pendingAdditions` (or empty), coverage `lastResweep.files === 0`, no merger call. *(Task 6 test)*
5. **Re-sweep clicked while a sweep is running or additions are pending** → API answers 409, nothing starts. *(Task 9 test)*

---

### Task 0: Baseline

- [ ] **Step 1:** On `main` (stash nothing — tree is clean), run the full suite and save failing test names: `NODE_ENV=test ./node_modules/.bin/tsx --test tests/*.test.ts tests/*.test.tsx 2>&1 | tee <scratchpad>/baseline.txt` (~8 min). Record the `not ok` lines.
- [ ] **Step 2:** `git checkout feat/test-sweep`.

### Task 1: Core types and pure sweep rules

**Files:**
- Modify: `src/core/test-prep.ts`
- Test: `tests/test-sweep-core.test.ts` (create)

**Interfaces — Produces:**
```ts
export interface LeftOutItem { id: string; text: string; source: string; reason: string; suggestedSection?: string; }
export interface SweepCoverage {
  files: number; pages: number; visionPages: number;
  unsupported: string[]; unreadable: string[]; empty: string[]; removed: string[];
  lastResweep?: { at: string; files: number };
}
export interface SweepState {
  status: "running" | "done" | "error"; activity?: string; startedAt: string; finishedAt?: string;
  error?: string; coverage?: SweepCoverage; fileHashes: Record<string, string>;
}
export interface PendingAdditions { sections: PlanDraftSection[]; leftOut: LeftOutItem[]; }
// TestRecord gains: leftOut?: LeftOutItem[]; sweep?: SweepState; pendingAdditions?: PendingAdditions;

export function emptyCoverage(): SweepCoverage;
/** Whole-folder cumulative coverage: counts add, lists union (deduped), a file in `run`
 *  clears its old entries from unreadable/empty first; `removed` replaced by run.removed. */
export function mergeCoverage(prev: SweepCoverage | undefined, run: SweepCoverage, resweepAt?: string): SweepCoverage;
/** e.g. "Read 14 files · 312 pages (41 looked at by vision) · nothing found: ch4.pdf p. 88–90 · couldn't read: old.pdf (encrypted) · not read: notes.key" */
export function coverageLine(c: SweepCoverage): string;
/** Insert item as a point into the section titled suggestedSection (trimmed match), else the first section; returns new drafts. */
export function promoteIntoDraft(draft: PlanDraftSection[], item: LeftOutItem): PlanDraftSection[];
/** Append accepted additions to sections as new unchecked points (sections matched by trimmed title, else appended). Never alters existing points. */
export function applyAdditions(sections: TestSection[], accepted: PlanDraftSection[], newId: () => string): TestSection[];
```

- [ ] **Step 1: Write failing tests** in `tests/test-sweep-core.test.ts`:
  - `mergeCoverage adds counts and unions lists` — prev `{files:2,pages:10,visionPages:1,empty:["a.pdf p. 3"]}`, run `{files:1,pages:4,visionPages:2,empty:["b.pdf p. 1"]}` → `files 3, pages 14, visionPages 3, empty ["a.pdf p. 3","b.pdf p. 1"]`.
  - `mergeCoverage drops stale entries for re-read files` — prev empty `["a.pdf p. 3"]`, run re-reads `a.pdf` (run.files includes it, run.empty `[]`; pass the run's file list via an entry in run — implementer: add `readFiles?: string[]` to the run argument type only, not stored) → `a.pdf p. 3` gone.
  - `mergeCoverage with resweepAt sets lastResweep {at, files: run.files}`.
  - `coverageLine collapses consecutive pages` — empty `["ch4.pdf p. 88","ch4.pdf p. 89","ch4.pdf p. 90"]` → contains `"nothing found: ch4.pdf p. 88–90"`; contains `"Read 14 files · 312 pages (41 looked at by vision)"` for those counts; omits sections whose lists are empty.
  - `promoteIntoDraft uses suggestedSection, falls back to first section` — point appended with `{text, source}`, no id.
  - `applyAdditions keeps existing points byte-identical` — deepStrictEqual of the pre-existing points before/after; new points `status "unchecked"`, `history []`; unknown section title → new section appended.
- [ ] **Step 2:** Run `NODE_ENV=test ./node_modules/.bin/tsx --test tests/test-sweep-core.test.ts` → FAIL (not exported).
- [ ] **Step 3:** Implement the types and functions above in `src/core/test-prep.ts` (pure, no imports).
- [ ] **Step 4:** Run the test file + `tests/test-prep-core.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(sweep): core types and coverage/left-out rules`.

### Task 2: Store methods

**Files:**
- Modify: `src/store/tests.ts`
- Test: `tests/test-prep-store.test.ts` (extend; follow its existing data-dir setup)

**Interfaces — Consumes:** Task 1 types/functions. **Produces** (added to `testStore`):
```ts
setFolder(id: string, folder: string): TestRecord;
updateSweep(id: string, patch: Partial<SweepState>): TestRecord;            // creates sweep if absent (startedAt required then)
/** First sweep only: throws "plan already exists" if sections.length > 0. Saves sections via mergePlan([], draft), planConfirmed=false, leftOut. */
saveSweepPlan(id: string, draft: PlanDraftSection[], leftOut: LeftOutItem[]): TestRecord;
setPendingAdditions(id: string, additions: PendingAdditions): TestRecord;  // additions.leftOut stays inside pendingAdditions until resolveAdditions
/** accepted: section/point indexes into pendingAdditions; everything not accepted → leftOut with reason "dropped by you"; pendingAdditions.leftOut → leftOut; clears pendingAdditions. */
resolveAdditions(id: string, acceptedKeys: string[]): TestRecord;            // key = `${sectionIndex}:${pointIndex}`
/** After confirmation: promotes a leftOut item as an unchecked point (promoteIntoDraft semantics via applyAdditions), removes it from leftOut; planConfirmed unchanged. */
promoteLeftOut(id: string, itemId: string): TestRecord;
```
`LeftOutItem.id` minted with the store's `newId()` when absent. `isTestRecord` keeps accepting records with/without the new fields (do not validate them strictly; ignore malformed optional fields by treating them as absent on read).

- [ ] **Step 1: Failing tests:** `saveSweepPlan refuses when a plan exists`; `saveSweepPlan saves unconfirmed sections and leftOut`; `resolveAdditions adds accepted as unchecked, dropped go to leftOut with reason "dropped by you", existing points unchanged, pendingAdditions cleared`; `promoteLeftOut keeps planConfirmed true and removes the item`; `legacy record without new fields still loads`; each mutation emits `tests-changed` (mirror existing emit assertions in the file).
- [ ] **Step 2:** Run `tests/test-prep-store.test.ts` → FAIL.
- [ ] **Step 3:** Implement (same read-modify-write + `writeTest` + `emit` idiom).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(sweep): test store sweep methods`.

### Task 3: Model roles

**Files:**
- Modify: `config.ts` (`ModelRole`), `src/core/settings.ts` (`ROLE_SLOT`), plus any exhaustive `Record<ModelRole, …>` the typechecker flags (do NOT add the new roles to `BACKGROUND_MODEL_ROLES` — no settings UI, like `apIndexer`).
- Test: extend the existing ROLE_SLOT test if one exists (`grep -rn ROLE_SLOT tests/`), else add to `tests/test-sweep-core.test.ts`: `ROLE_SLOT maps sweepReader→vision, sweepExtractor→cheap, sweepMerger→strong`.

- [ ] **Step 1:** Write the assertion; run → FAIL.
- [ ] **Step 2:** Add roles; run `npm run typecheck` and fix every flagged exhaustive map.
- [ ] **Step 3:** Run test + typecheck → PASS.
- [ ] **Step 4:** Commit `feat(sweep): sweep model roles`.

### Task 4: Enumerate + transcribe

**Files:**
- Create: `src/agent/subagents/sweep/transcribe.ts`, `src/agent/subagents/sweep/office.ts`
- Modify: `package.json` (add `jszip`, `mammoth` — latest stable at least two weeks old, exact versions in lockfile)
- Test: `tests/sweep-transcribe.test.ts` (create; build fixtures in a temp dir at test time — tiny PDFs via existing PDF test fixtures if present under `tests/fixtures`, pptx/docx built with JSZip in the test)

**Interfaces — Produces:**
```ts
export const SWEEP_EXTENSIONS: ReadonlySet<string>;
export interface SweepFile { rel: string; abs: string; ext: string; hash: string; }   // sha256 of bytes
export function enumerateFolder(folder: string): Promise<{ files: SweepFile[]; unsupported: string[] }>; // uses walkFiles from src/agent/tools/fs-shared.ts
export type Describe = (images: Array<{ png: Buffer; mime: string }>, hint: string) => Promise<string>;
export interface Transcript { rel: string; markdown: string; pages: number; visionPages: number; unreadable: string[]; } // markdown carries <!-- source: … --> markers
export function transcribeFile(file: SweepFile, deps: { describe: Describe; signal?: AbortSignal; onActivity?: (line: string) => void }): Promise<Transcript>;
// office.ts
export function pptxSlides(bytes: Uint8Array): Promise<Array<{ slide: number; text: string; notes: string; images: Array<{ data: Buffer; mime: string }> }>>;
export function docxContent(bytes: Uint8Array): Promise<{ markdown: string; images: Array<{ data: Buffer; mime: string }> }>;
```
Rules:
- Marker per unit: `<!-- source: <rel> p. N -->`, `<!-- source: <rel> slide N -->`, `<!-- source: <rel> -->`.
- PDF: `pdfInfo` per page; text via `pdfExtract(abs, String(n))`. Send page to `describe` (render with `getHeadless().renderPdfPages(abs, [n], { dpi: 150 })`) when `image_count > 0 || math_density >= 0.15 || text_length < 200`. Prompt hint: describe figures/diagrams/tables faithfully (labels, axes, captions, values); if the page is scanned, transcribe it. Batch up to 4 pages per describe call is allowed but each page's description must land under its own marker — simplest: one page per call, bounded concurrency 4.
- pptx: slide order from `ppt/presentation.xml` slide list; text from `a:t` runs; notes from `ppt/notesSlides/notesSlideN.xml`; images = media targets of `ppt/slides/_rels/slideN.xml.rels`. Slides with images → `describe`.
- docx: `mammoth.convertToMarkdown` (or HTML→turndown, already a dep) with images captured via mammoth's image handler → `describe` each, appended at the end under the file marker.
- Images: `describe` once. Text: read as UTF-8.
- Failures: a whole-file failure (pdfjs throws, encrypted, bad zip) → `unreadable: ["<rel> (reason)"]`, empty markdown; a single `describe` failure → `unreadable: ["<rel> p. N (vision failed)"]`, page text still kept. Never throw out of `transcribeFile` except on abort.

- [ ] **Step 1: Failing tests:** `enumerateFolder lists supported files with hashes and unsupported separately`; `pdf page with an image is described and marked`; `text-only pdf page is not sent to describe`; `pptx slide text, notes and image description land under slide markers` (in-test JSZip-built pptx with 2 slides); `docx headings become markdown`; `describe throwing records "(vision failed)" and keeps text`; `corrupt pdf → unreadable with reason, no throw`. `describe` is a stub recording its calls.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `npm install jszip mammoth` then implement.
- [ ] **Step 4:** Run → PASS; `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(sweep): enumerate and transcribe pdf/pptx/docx/images`.

### Task 5: Extractor and merger stages

**Files:**
- Create: `src/agent/subagents/sweep/extract.ts`, `src/agent/subagents/sweep/merge.ts`, `src/agent/subagents/sweep/prompts.ts`
- Test: `tests/sweep-stages.test.ts` (scripted engines, same pattern as `tests/extraction.test.ts` / ap-indexer tests)

**Interfaces — Produces:**
```ts
export interface Candidate { kind: "skill" | "fact"; category: string; text: string; source: string; evidence: string; }
export function chunkTranscripts(transcripts: Transcript[], budget: number): string[]; // uses chunkNotes; every chunk starts with the marker in force at its first line
export function extractCandidates(chunk: string, opts: { engine?: PiEngine; signal?: AbortSignal; onUsage: (u: Usage) => void }): Promise<{ candidates: Candidate[]; markersSeen: string[] }>;
export interface MergeInput { candidates: Candidate[]; outlineHeadings: string[]; existingPoints: string[]; existingLeftOut: string[]; }
export interface MergeOutput { sections: PlanDraftSection[]; leftOut: Array<Omit<LeftOutItem, "id">>; }
export function mergeCandidates(input: MergeInput, opts: { engine?: PiEngine; signal?: AbortSignal; onUsage: (u: Usage) => void }): Promise<MergeOutput>;
```
- Both use `runSubmitAgent` (roles `sweepExtractor` / `sweepMerger`, tool names `submit_candidates` / `submit_plan`).
- `extractCandidates` `validate`: every candidate `source` must be one of the chunk's markers. Extractor prompt (in `prompts.ts`): extract generously (recall over precision) everything a teacher could test; categories: vocab/term, definition, formula, person, date/event, process/steps, labeled diagram, worked-example type, comparison, other; `kind:"skill"` for "can do X" items, `"fact"` for things known one by one.
- `mergeCandidates` `validate`: `planProblems(sections)` empty, and in re-sweep mode (`existingPoints.length > 0`) sections may be empty only if leftOut covers all candidates — implementer: allow empty sections array only when `existingPoints.length > 0` (bypass planProblems' "at least one section" in that mode). Merger prompt encodes the spec rules verbatim: one point per **skill archetype** (a distinct kind of question, regardless of how many examples); one point per **must-know fact** (each vocab term its own point; key formulas, people, dates, events likewise); **noise** → leftOut with a short reason (slide titles, anecdotes, admin notes, citations, filler examples, author names); sections = `outlineHeadings` when non-empty, else coherent topic headings from the material; each point keeps a `source` citing representative pages; never re-propose `existingPoints` or `existingLeftOut`.
- Overflow (left to builder in spec — decided here): if the serialized candidate list exceeds 150k chars, first mechanically dedupe facts by lowercase trimmed text, then if still over, merge per group of candidates bucketed by source file and concatenate sections by title.

- [ ] **Step 1: Failing tests:** `chunkTranscripts carries the active marker into each chunk`; `extractCandidates rejects a candidate with a source not in the chunk then accepts the retry` (scripted engine submits bad then good); `mergeCandidates returns sections and leftOut`; `mergeCandidates prompt contains the archetype, must-know-fact and noise rules` (assert substrings of the system prompt: `"skill archetype"`, `"each vocab term"`, `"Left out"` or `"noise"`); `mergeCandidates throws after maxTurns of invalid submissions`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(sweep): extractor and merger stages`.

### Task 6: Sweep orchestrator

**Files:**
- Create: `src/agent/subagents/sweep/run-sweep.ts`
- Test: `tests/sweep-run.test.ts`

**Interfaces — Consumes:** Tasks 1, 2, 4, 5. **Produces:**
```ts
export interface SweepStore {   // port, structurally satisfied by testStore
  get(id: string): TestRecord | null;
  updateSweep(id: string, patch: Partial<SweepState>): TestRecord;
  saveSweepPlan(id: string, draft: PlanDraftSection[], leftOut: LeftOutItem[]): TestRecord;
  setPendingAdditions(id: string, a: PendingAdditions): TestRecord;
}
export interface SweepDeps {
  store: SweepStore;
  engines: { reader?: PiEngine; extractor?: PiEngine; merger?: PiEngine };
  describe?: Describe;            // default: built from engines.reader via runSubagent with image content
  signal?: AbortSignal;
  onUsage?: (role: ModelRole, u: Usage) => void;
}
export interface SweepOutcome { ok: boolean; mode: "initial" | "resweep"; points: number; leftOut: number; coverage: SweepCoverage; error?: string; }
export function runSweep(testId: string, mode: "initial" | "resweep", deps: SweepDeps): Promise<SweepOutcome>;
```
Behavior:
- Requires `record.folder`. `updateSweep({status:"running", startedAt, activity})` first; activity updated per file/page ("Reading ch4.pdf — page 88/312", "Finding testable items — chunk 3/17", "Building the plan").
- Re-sweep: only files whose hash differs from `sweep.fileHashes` or are new; files in hashes but not on disk → `removed`. No changed files → skip extract/merge, finish `done` with `lastResweep.files = 0`, no `pendingAdditions`.
- Outline detection: first file whose name matches `/outline|syllabus|study guide|review/i`; headings = its markdown `#`-lines (or the merger gets `[]`).
- Transcript cache: `PATHS.tests/<id>/sweep/<sha256>.md` (create dir); cached transcript reused when hash matches.
- `empty` = markers of units that produced zero candidates (from `markersSeen` vs candidate sources), excluding units already in `unreadable`.
- Merge failure (throw) → retry merge once → still failing: `updateSweep({status:"error", error: "<msg>. Read N files · M pages.", coverage})`, nothing saved, `ok:false`.
- Success initial: `saveSweepPlan(...)`; resweep: `setPendingAdditions(...)`. Then `updateSweep({status:"done", finishedAt, coverage: mergeCoverage(prev, run, resweep ? now : undefined), fileHashes})`.

- [ ] **Step 1: Failing tests** (stub engines/describe, temp folder with 2 text files): `initial sweep saves an unconfirmed plan, leftOut and coverage`; `merge failing twice ends in error and saves nothing` (Review Focus 3); `resweep with no changes makes no merger call and records lastResweep.files 0` (Review Focus 4); `resweep sends only changed files and existing point texts to the merger, writes pendingAdditions, leaves sections untouched`; `removed file listed in coverage.removed, no points removed`; `unreadable file never appears in empty` (Review Focus 2).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(sweep): sweep orchestrator`.

### Task 7: `sweep` job kind and `sweep_materials` tool

**Files:**
- Modify: `src/core/contracts/jobs.ts` (`JobKind` + `SweepToolInput {testId; folder}` + `SweepResult = SweepOutcome-shaped`, `isSubagentFailure`, `steerText`), `src/agent/subagents/runner.ts` (`KIND_ROLE.sweep = "sweepMerger"`, `KIND_RUNNERS.sweep`, failure shape in `refuse`, input union; the sweep runner gets reader/extractor engines via `deps.engineFor("sweepReader" | "sweepExtractor")` and passes a `SweepStore` — add `sweepStore?: SweepStore` to `JobRunnerDeps`), `src/agent/tools/test-prep.ts` (tool + `TestPrepStore` gains `setFolder`), `src/server/chat-handler.ts` (inject `testStore` as `sweepStore`; pass to test-prep ctx), `components/artifacts/dispatch-card.tsx` (`KIND_LABEL.sweep = "Reading your materials"`).
- Test: `tests/test-prep-tools.test.ts`, `tests/jobs.test.ts` (extend)

**Tool contract — `sweep_materials`:** input `{ folder: string }` (the folder the learner attached; absolute or as given). Execute:
1. Refuse (invalidInputResult) when the test has `sections.length > 0` or `sweep?.status === "running"`: `"this test already has a plan — materials added later are read with the Re-sweep folder button on the test page"` (Review Focus 1).
2. Resolve/validate the folder with the same path resolution and access check `lsTool` uses (see `src/agent/tools/ls.ts` / `fs-shared.ts`); not a readable directory → invalidInputResult.
3. `ctx.tests.setFolder(testId, folder)`, dispatch job kind `"sweep"` through the existing `dispatchJob` path (jobs ctx), return text: `"Reading every file in the folder now. End your turn; the plan arrives when the sweep finishes."`
Steer text on success: `"Sweep finished: <points> points proposed (<leftOut> left out). Coverage: <coverageLine>. The plan is saved UNCONFIRMED — give the learner a two-line summary and stop for review."`; on failure: `"Sweep failed: <error>"`.

- [ ] **Step 1: Failing tests:** `sweep_materials refuses when a plan exists and does not dispatch`; `sweep_materials refuses a missing folder`; `sweep_materials stores folder and dispatches a sweep job`; `sweep job steer text includes the coverage line` (jobs test with scripted engines / stubbed runSweep — add `sweepOverride: { current?: typeof runSweep }` test seam in runner.ts like the existing model overrides).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; `npm run typecheck`. **Step 4:** Run both files → PASS.
- [ ] **Step 5:** Commit `feat(sweep): sweep job kind and sweep_materials tool`.

### Task 8: Doctrine rewrite

**Files:**
- Modify: `src/agent/prompts/testprep/10-doctrine.md` ("Scoping the plan"), `src/agent/prompts/testprep/00-base.md` (line about `source`: "the file and page or slide it came from"), `propose_plan` descriptions in `src/agent/tools/test-prep.ts` ("sections from the outline's headings" → "sections", source → "the file and page/slide it came from").
- Test: `tests/test-prep-prompt.test.ts`

New "Scoping the plan" text (exact):
```
## Scoping the plan

On the first turn the learner points you at a folder. Call `sweep_materials` with that folder and tell the learner you are reading all of their materials — it can take a few minutes. Then end your turn. If they gave no folder, ask for it.

When the sweep finishes, the plan is already proposed. Give a two-line summary — how many points, the coverage line, and anything that could not be read — then stop and wait for the learner to review it.

Use `propose_plan` only when the learner asks for changes in chat. **Never invent scope from general knowledge.**
```
- [ ] **Step 1:** Update prompt tests: assert doctrine contains `"sweep_materials"` and `"Never invent scope from general knowledge."`, does not contain `"outline first"`. Run → FAIL.
- [ ] **Step 2:** Edit prompts/descriptions. **Step 3:** Run prompt + tools tests → PASS.
- [ ] **Step 4:** Commit `feat(sweep): test-prep doctrine uses the sweep`.

### Task 9: API routes

**Files:**
- Create: `app/api/tests/[id]/sweep/route.ts` (`POST` start re-sweep; `GET` → `{ sweep, pendingAdditions }`), `app/api/tests/[id]/additions/route.ts` (`POST {accepted: string[]}` → `resolveAdditions`), `app/api/tests/[id]/left-out/route.ts` (`POST {itemId}` → `promoteLeftOut`)
- Modify: `app/api/tests/[id]/plan/route.ts` only if its GET filters fields (it must return `leftOut`, `sweep`, `pendingAdditions`).
- Test: `tests/test-sweep-api.test.ts` (mirror `tests/test-prep-plan-route.test.ts` setup)

Rules: mirror the existing plan route's params/response idioms (read Next docs first). `POST sweep`: 404 unknown test; 400 `"no folder stored for this test"` when `folder` absent; 409 when `sweep.status === "running"` or `pendingAdditions` present (Review Focus 5); otherwise fire-and-forget `runSweep(id, "resweep", deps)` with engines from the server's settings-resolved `engineFor` (same source chat-handler uses — extract a shared helper if needed) and return 202 `{ started: true }`.

- [ ] **Step 1: Failing tests** for each status above plus `additions POST resolves and returns the record` and `left-out POST promotes`. `runSweep` stubbed via a test seam.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(sweep): re-sweep, additions and left-out routes`.

### Task 10: Plan review UI — coverage line and Left out

**Files:**
- Modify: `components/test-prep/plan-review-card.tsx`, `components/test-prep/plan-editor.tsx`
- Create: `components/test-prep/left-out-list.tsx`, `components/test-prep/coverage-line.tsx`
- Test: `tests/test-prep-plan-card.test.tsx` (extend)

**Produces:**
```ts
export function CoverageLine(props: { coverage?: SweepCoverage }): JSX.Element | null;   // uses coverageLine()
export function LeftOutList(props: { items: LeftOutItem[]; onPromote: (item: LeftOutItem) => void; defaultOpen?: false }): JSX.Element | null; // collapsed "Left out (N)"; rows: text, reason, source, "Promote" button (data-testid="promote-left-out")
```
- In the review card (unconfirmed, latest proposal): `CoverageLine` above the editor; `LeftOutList` below it. Promote calls `promoteIntoDraft` on the editor draft (lift draft state if `PlanEditor` owns it — add `draft`/`onDraftChange` props or an imperative `addPoint(sectionTitle, point)`), and hides the item locally. On Save/confirm, the PUT body also sends `leftOut` minus promoted ids — extend `PUT /api/tests/[id]/plan` to accept optional `leftOut: LeftOutItem[]` and persist it (add test in `tests/test-prep-plan-route.test.ts`).
- While `sweep.status === "running"` and there are no sections: show `sweep.activity` in place of the editor.

- [ ] **Step 1: Failing tests:** `shows coverage line`; `Left out is collapsed with count`; `promote moves the item into its suggested section in the editor`; `confirm sends leftOut without promoted items`; `running sweep shows activity`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(sweep): coverage and left-out in plan review`.

### Task 11: Readiness page — Re-sweep, additions, persistent Left out

**Files:**
- Modify: `components/test-prep/readiness-view.tsx`
- Create: `components/test-prep/resweep-additions-card.tsx`
- Test: `tests/test-prep-readiness.test.tsx` (extend)

Behavior:
- Header button **"Re-sweep folder"** (`data-testid="resweep-folder"`) beside "Edit plan". Disabled with title `"This test has no stored folder"` when `!folder`; disabled with title `"Review the new items first"` when `pendingAdditions`; while running shows `sweep.activity` and is disabled. Click → `POST /api/tests/[id]/sweep`; poll `GET …/sweep` every 2s while running (or reuse the page's existing `tests-changed` refresh if present).
- `CoverageLine` under the header (whole-folder coverage, plus `"Last re-sweep: +N files"` when `lastResweep`).
- `ResweepAdditionsCard` when `pendingAdditions`: each proposed point with a checkbox (default checked) grouped by section; its own `LeftOutList` (read-only, no promote here); button **"Add accepted"** → `POST …/additions {accepted}`.
- Persistent `LeftOutList` (collapsed) at the bottom; Promote → `POST …/left-out {itemId}`.

- [ ] **Step 1: Failing tests:** `resweep disabled without folder`; `resweep disabled while additions pending`; `additions card posts only checked keys`; `left-out promote posts itemId`; `coverage line shows last re-sweep`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(sweep): re-sweep and left-out on the readiness page`.

### Task 12: Whole-branch verification

- [ ] **Step 1:** `npm run typecheck` → no errors. `npm run lint` → no new errors.
- [ ] **Step 2:** Full suite (command from Global Constraints); diff `not ok` names against Task 0 baseline → no new failures.
- [ ] **Step 3:** `npm run build` → succeeds.
- [ ] **Step 4:** Manual smoke (orchestrator, with owner's consent before touching live data): run the dev app against a scratch data dir (`LH_DATA_DIR`), create a test, attach a folder containing a multi-page PDF with figures, a .pptx and a .docx; confirm plan appears with coverage line and Left out; add a file, Re-sweep, accept an addition.
