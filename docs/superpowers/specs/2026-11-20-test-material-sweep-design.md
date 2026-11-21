# Test material sweep — design

Date: 2026-11-20 · Status: draft for owner approval

## Intent

Test mode's plan must cover **everything the test could ask** from the learner's
materials, without the learner re-prompting ("you missed the vocab"), and it must
actually read long, illustrated PDFs in full. At the same time it must **not**
fill up with noise. The owner's picture: *one point for every archetype of
question that can be asked on the test.*

### Why it fails today (verified)

- `src/agent/prompts/testprep/10-doctrine.md:7` tells the model to read the
  **outline first** and open slides only if the outline is missing or vague. No
  prompt names item types (vocab, formulas, dates, diagrams). Coverage is the
  model's discretion over whatever it chose to read.
- Test mode reads PDFs via the `pdf` job (`src/agent/subagents/pdf-reader.ts`),
  which is selective by design: long PDFs (>40 pages) are searched, never read
  front-to-back; ≤6 renders per call, 14 iterations; the test-prep agent gets
  back only a 2–6 sentence brief.
- The folder path is never stored on the test (`app/api/chats/route.ts:87-100`
  calls `testStore.create(title)` without a folder); it lives only in chat text.

## Goals

1. Every file in the materials folder is read; every PDF page is read (text in
   full; figure / equation pages looked at by a vision model; scanned pages
   transcribed).
2. The proposed plan contains:
   - **one point per skill archetype** — a distinct kind of question
     ("solve a quadratic by factoring"), regardless of how many examples the
     material contains;
   - **one point per must-know fact** — each vocab term is its own point;
     key formulas, people, dates, and events are treated the same way;
   - **no noise** — slide titles, anecdotes, admin notes, citations, filler
     examples, author names, etc. are left out.
3. What was left out is visible and recoverable: a collapsed **"Left out"** list
   under the plan, each item with a short reason and source, promotable into the
   plan with one click.
4. Coverage is auditable: a coverage line reports files/pages processed and which
   pages yielded nothing.
5. Folders change: a **"Re-sweep folder"** action sweeps only new/changed files
   and proposes additions without touching existing points or progress.

## Non-goals

- Changing how sittings, questions, grading, or readiness work.
- Changing the notes/knowledge-graph importer (`/api/graph/import`).
- Migrating existing tests (new fields are optional; old tests keep working;
  re-sweep is unavailable for tests with no stored folder — see below).
- Native-PDF model input.

## Anti-goals (would be failure even if it "works")

- A plan bloated with trivia or every sentence of the slides.
- Silently dropping material the learner would have wanted, with no way to see it.
- Re-sweep resetting or reshuffling points the learner has already worked on.
- The test-prep agent skimming again because the sweep result was too big for it.

## Owner decisions (settled in conversation)

| Decision | Choice |
|---|---|
| Scope | **Everything in the folder.** Outline headings organize sections; they do not limit scope. |
| Figure/scan reader | **Vision model slot** (currently deepseek flash), swappable in settings. |
| Granularity | Skills → one point per archetype. Must-know facts (vocab etc.) → one point each. |
| Noise visibility | Collapsed **"Left out"** list with reason + source, one-click promote. |
| Sorting model | **Cheap slot per chunk** (generous candidate extraction) → **strong slot (Opus)** does the final archetype grouping, dedupe, section assignment, and noise call over the whole candidate list. |
| New files | **"Re-sweep folder" button**: only new/changed files; proposes additions for accept/drop; existing points and progress untouched. |
| Office files | **Read `.pptx` and `.docx`** (new converters). |

## Approaches considered

- **A. Prompt rewrite + full-read PDF mode.** Smallest build, but Opus does all
  reading in one conversation; on large folders it runs out of context or skims,
  and nothing proves coverage. Rejected.
- **B. Dedicated sweep pipeline before planning.** *(Chosen.)* Deterministic
  read of every file/page, chunked candidate extraction, Opus merge. Only option
  that can prove coverage; reuses the notes importer's chunk→extract pattern.
- **C. B's transcripts, but Opus reads them chunk by chunk.** Better per-chunk
  judgment, slow/costly, and re-introduces context limits. Rejected.

## Design

### 1. Folder becomes part of the test

- New tool `sweep_materials({ folder })` in the test-prep registry
  (`src/agent/tools/test-prep.ts`). The agent calls it on the first turn with the
  folder the learner attached. It stores `folder` on the `TestRecord` (field
  already exists, `src/core/test-prep.ts`; `testStore` already supports it) and
  starts the sweep.
- **First proposal only** *(my call)*: the tool refuses once the test has any
  plan (confirmed or not) or a sweep is running, and tells the agent to point the
  learner at **Re-sweep folder**. This guarantees a sweep can never overwrite a
  plan or erase progress (`savePlan` → `mergePlan` drops absent points). Changing
  a test's stored folder is out of scope for this change.
- Folder access goes through the existing file-access rules used by
  `read`/`ls`/`walkFiles` (`src/agent/tools/fs-shared.ts`), including its skip
  list.

### 2. Sweep pipeline (background)

Stages, each reporting a one-line activity (e.g. "Reading ch4.pdf — page 88/312"):

1. **Enumerate** every file under the folder (recursive, `walkFiles`).
   Supported: `.pdf`, `.pptx`, `.docx`, text/markdown (`.md`, `.txt`, …), images
   (`jpg/png/gif/webp/bmp`). Unsupported files are listed in the coverage report
   as "not read (unsupported type)", never silently ignored.
2. **Transcribe** each file to Markdown with page/slide markers
   (`<!-- file: ch4.pdf p. 88 -->`):
   - PDF: text per page via `pdf-ops` (`pdfExtract` / `pdfInfo`). A page is also
     **rendered** (`HeadlessApi.renderPdfPages`) and sent to the **vision** slot
     when it has images (`image_count > 0`), high `math_density`, or little/no
     text. Vision output: a faithful description of figures/diagrams (labels,
     axes, captions, table contents) and, for scanned pages, a transcription.
     Appended under that page's marker.
   - `.pptx`: per slide, the slide text (titles, body, tables) **and speaker
     notes**, under `slide N` markers; images embedded on a slide (`ppt/media/*`
     referenced by that slide) go to the vision slot and their descriptions are
     appended under the slide. Baseline needs no external install (zip + XML
     parsing). Vision sees each slide's embedded pictures, not a render of the
     whole slide layout; diagrams built from native PowerPoint shapes/SmartArt
     are captured only as their text. *(My call: full-slide rendering would need
     LibreOffice installed; flagged to the owner.)*
   - `.docx`: text with headings/lists/tables (e.g. `mammoth`), embedded images
     to the vision slot, under `section`/heading markers.
   - Image files: vision description/transcription.
   - Text files: as-is.
   - Transcripts are cached per file, keyed by content hash, under the test's data
     dir (e.g. `data/tests/<id>/sweep/`), so re-sweep skips unchanged files.
3. **Extract candidates** — transcripts chunked (reuse `chunkNotes`, preserving
   markers so every chunk knows its source). **Cheap** slot, per chunk, extracts
   *generously* (recall over precision): each candidate =
   `{ kind: "skill" | "fact", category, text, source, evidence }` where category ∈
   vocab/term, definition, formula, person, date/event, process/steps,
   labeled diagram, worked-example type, comparison, other; `source` =
   "file p. N" / "file slide N"; `evidence` = the short quote.
4. **Merge (strong slot / Opus)** over the full candidate list (+ the outline
   file's headings if one is detected):
   - group skill candidates into **archetypes** (one point each; source cites
     representative pages);
   - dedupe facts; **each must-know fact stays its own point**;
   - assign points to **sections** = outline headings when an outline exists,
     otherwise coherent topic headings derived from the material;
   - classify **noise** → Left-out item with a short reason and its
     `suggestedSection`;
   - points obey existing plan rules (`planProblems`) — one testable item each,
     `source` required.
5. **Save** the result directly as the **unconfirmed** proposed plan
   (`savePlan(testId, sections, false)`, same path `propose_plan` uses) plus the
   Left-out list and coverage report. Rationale *(builder-facing call)*: the
   agent never has to re-emit hundreds of points through a tool call, so it
   cannot drop any. **Validate before saving** *(my call)*: merge output must pass
   `planProblems` (non-empty, every point has `source`); on failure retry the
   merge once, then end the sweep as `error` with nothing saved, and report what
   was and wasn't read.
6. **Coverage report**: files read, pages read, pages sent to vision, unsupported
   files, files/pages that **could not be read** (encrypted, corrupt, vision call
   failed) — kept distinct from pages that were read and yielded **zero**
   candidates, so "nothing found" never hides "couldn't read" *(my call)*.
   Coverage describes the **whole folder, cumulatively** across sweeps; a
   re-sweep also records a "last re-sweep: +N files" note *(my call)*.

Concurrency, chunk budget, and vision batch size are builder calls; keep vision
calls parallel but bounded.

### 3. Data additions (`src/core/test-prep.ts`)

All optional so existing records stay valid (`version` stays 1 unless the builder
needs a bump):

```ts
interface LeftOutItem { id: string; text: string; source: string; reason: string; suggestedSection?: string; }
interface SweepCoverage { files: number; pages: number; visionPages: number; unsupported: string[]; unreadable: string[] /* "file" or "file p. N" + why */; empty: string[] /* "file p. N" */; removed: string[]; lastResweep?: { at: string; files: number }; }
interface SweepState { status: "running" | "done" | "error"; activity?: string; startedAt: string; finishedAt?: string; error?: string; coverage?: SweepCoverage; fileHashes: Record<string, string>; }
// TestRecord gains:
leftOut?: LeftOutItem[];
sweep?: SweepState;
pendingAdditions?: { sections: PlanDraftSection[]; leftOut: LeftOutItem[] }; // from a re-sweep, awaiting review
```

### 4. Test-mode doctrine rewrite (`10-doctrine.md`, `00-base.md`)

Replace "Scoping the plan" with: on the first turn, call `sweep_materials` with
the attached folder and tell the learner the materials are being read (it may
take a few minutes). When the sweep result arrives, the plan is already proposed:
give a two-line summary (point count, coverage line, anything unread) and stop
for review. If the learner gave no folder, ask for it. Keep "Never invent scope
from general knowledge." Remove "outline first". `propose_plan` stays for
learner-requested revisions in chat. The `pdf` job stays available for ad-hoc
questions during sittings.

### 5. Plan review UI (`components/test-prep/plan-review-card.tsx`, `plan-editor.tsx`)

- Above the editor: the coverage line, e.g.
  "Read 14 files · 312 pages (41 looked at by vision) · nothing found on ch4.pdf p. 88–90 · not read: notes.docx".
- Below the editor: collapsed **"Left out (N)"**. Each row: text, reason, source,
  **Promote** → inserts the item as a point into its `suggestedSection` (or the
  first section if missing) in the editor's draft and removes it from the list.
  Promoted items are saved only when the learner saves/confirms, like other edits.
- While the sweep is running, the card (or the chat's dispatch card) shows the
  activity line.
- **After confirmation** *(my call)*: the readiness page
  (`readiness-view.tsx`) shows the coverage line and a persistent collapsed
  "Left out (N)" section. Promote there adds the point (as `unchecked`) via the
  same save path as "Edit plan" and removes it from `leftOut`. Left-out stays
  recoverable for the life of the test.

### 6. Re-sweep (`components/test-prep/readiness-view.tsx` header)

- **"Re-sweep folder"** button next to "Edit plan"; hidden/disabled with a tooltip
  when the test has no stored `folder` (pre-existing tests).
- Runs stages 1–4 on **new or changed** files only (hash compare). Removed files
  are reported in the coverage line but **no points are removed**.
- The merge step receives the existing plan's point texts so it emits only
  genuinely new points/archetypes (no duplicates of existing ones).
- Result lands in `pendingAdditions`, shown on the readiness page as a
  "New from re-sweep" review card: each proposed point with Accept / Drop, plus its
  own Left-out list; "Add accepted" merges them into the plan as `unchecked`
  points. Existing points, statuses, and history are never modified.
- Runs without a chat; progress shown on the readiness page from `sweep.status` /
  `sweep.activity`.
- Lifecycle *(my calls)*: the re-sweep's Left-out items are **appended to the
  test's persistent `leftOut`**; **Drop** on a proposed point moves it to
  `leftOut` with reason "dropped by you" (nothing is deleted); Re-sweep is
  **disabled while `pendingAdditions` is unreviewed** or a sweep is running; the
  re-sweep merger also receives existing `leftOut` texts so it does not
  re-propose items already left out.

### 7. Models / roles

New roles mapped in `ROLE_SLOT` (`src/core/settings.ts:322-335`):
`sweepReader` → vision, `sweepExtractor` → cheap, `sweepMerger` → strong.
They resolve like other background roles (`resolveRoleSpec`), so they follow the
learner's settings and per-role overrides.

## Calls made during design review (owner to check)

1. `sweep_materials` is first-proposal-only; later material changes go through
   Re-sweep. Changing a test's folder is out of scope.
2. `.pptx`: slide text + speaker notes + embedded pictures to vision; no
   full-slide render (would require LibreOffice).
3. Left-out and coverage also live on the readiness page after confirmation.
4. "Couldn't read" is reported separately from "nothing found"; invalid merge
   output is never saved.
5. Re-sweep: dropped/left-out items persist in `leftOut`; one pending review at a
   time; coverage is cumulative for the whole folder.

## Left to the builder

- Whether the sweep is a new `JobKind` (`"sweep"`, touching the ~8 enumeration
  sites listed in `src/core/contracts/jobs.ts`, `runner.ts`, `jobs.ts`,
  `dispatch-card.tsx`) with chat delivery via the existing steer path, or a
  standalone runner that the chat tool and the re-sweep API route both call, with
  a steer delivered to the chat only for the first sweep. Either is fine if: the
  first sweep wakes the test-prep chat on completion, and re-sweep needs no chat.
- API route shape for re-sweep and for accepting additions
  (e.g. `POST /api/tests/[id]/sweep`, `POST /api/tests/[id]/additions`).
- Thresholds for "little/no text" and "high math density", chunk budget,
  concurrency, cache layout, exact prompt wording for extractor and merger
  (must encode the granularity and noise rules above).
- Handling a merge input too large for one strong-model call (e.g. pre-dedupe
  facts mechanically, or merge per outline section then reconcile).
- Tests: unit tests for page classification → vision routing, chunk marker
  preservation, hash-based incremental re-sweep, Left-out promote, additions
  never mutating existing points; prompt tests for the new doctrine.
