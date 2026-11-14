# AP Prep Stage 2 (Real Free-Response) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AP sitting can ask real released College Board free-response questions, shown as the original page, answered part by part with an optional photo, graded point by point against the official scoring guideline, with a score card and per-topic readiness.

**Architecture:** Released papers and scoring guidelines are saved through the stage 1 paper store. A background job reads each paper pair once and writes a question index (pages, parts, topic tags, rubric points) that syncs with the learning data; PDFs and rendered page images stay local. A new question tool `ap_frq` names a question by id; the server supplies everything shown, and the rubric reaches the tutor only after the learner has answered. Grading is recorded per rubric point and folded to one result per topic by a pure rule, reusing the Test prep status machine unchanged.

**Tech Stack:** Next.js (this repo's version; read `node_modules/next/dist/docs/` first), TypeScript, `@earendil-works/pi-agent-core`, TypeBox, `pdfjs-dist` + `@napi-rs/canvas` (already used by `renderPdfPages`), node:test via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-13-ap-prep-design.md` (sections 1, 3, 5, 6, "Stages", "Storage and sync", "Decided by Claude"), amended by the owner decisions below.

## Owner decisions for this stage (2026-11-14)

1. **Answer form:** all parts shown together, one box per part, one Submit.
2. **Photos:** the tutor sees an attached photo while grading; the image is not kept in the session record. Only its written read-back is saved.
3. **Index sync:** the question index (question numbers, pages, topic tags, rubric point text) syncs with the learning data. PDFs and page images stay on one computer. (This amends the design's "Storage and sync", which kept the index local.)
4. **Adding papers:** a `Find released papers` button on the course page; new courses also do it in the setup chat after the list is confirmed.
5. **Score card:** after grading, a card shows each part's points earned out of available, its topic, and `earned` or `missed`.

## Decided by Claude (owner can override at plan approval)

- **Files and ids.** A released paper is stored as `frq-<year>.pdf` (or `frq-<year>-set<n>.pdf` when a year has several sets) and its scoring guideline as `scoring-<year>.pdf` / `scoring-<year>-set<n>.pdf`; the document id is the file name without `.pdf`. A question's id is `<year>-<number>` or `<year>-s<n>-<number>` (e.g. `2023-2`). The index lives at `data/ap-index/<courseId>.json`.
- **Indexing model.** The indexing job runs on the **Cheap** model slot (a new role `apIndexer`, like the knowledge-graph extractor). It reads text only. Topic tags and rubric points are therefore only as good as that model; the tag is shown with each question and the tutor can correct it (design). Moving the role to another slot is a one-line change.
- **The rubric is withheld by the server, not by trust.** `ap_frq` takes only a question id. The tutor fetches the question text and rubric with `ap_rubric`, which is refused until the learner has answered that question in this session.
- **Images never persist in an AP session.** Rather than trusting the tutor to use one tool, every image a tool returns in an AP session is replaced by a text note when the turn is saved. The tutor keeps the image for the rest of that turn.
- **One "I don't know" for the whole question.** A part left blank earns no points. A question answered "I don't know" records `dontKnow` for every listed topic it tests.
- **Two parts, one topic.** A topic is `correct` only when every rubric point on every part tagged to it was earned (design: "one result per topic touched").
- **Parts outside the sitting's scope** are asked, graded and recorded (design). A retry after a miss is a multiple-choice question and is asked only for missed topics inside the sitting's scope.
- **No released question for the scope.** In a free-response sitting the tutor says so once and asks multiple-choice.
- **Correcting a tag** (`ap_retag_part`) changes future gradings only; it does not rewrite an attempt already recorded.
- **Page images** are rendered at 150 dpi on first view and cached under `data/ap-papers/<courseId>/pages/`.
- **Answer text for a part** is typed or dictated; dictation goes to the part box that has focus (the first box by default).

## Global Constraints

- Read `AGENTS.md` first. Before writing or changing any route handler or page, read the relevant guide under `node_modules/next/dist/docs/` and name it in your report.
- Do not change the behaviour of Teach, Practice, Test prep, or AP multiple-choice. `src/core/test-prep.ts` is imported, never edited.
- Layering: `src/core/**` imports nothing from `src/agent`, `src/store` or `src/server`. `src/agent/**` imports no store adapter and no server module; stores reach it as injected ports. `app/**` imports only from `src/server/index.ts` and the core barrel. Client components import no server-only code.
- Official PDFs are downloaded only through `downloadApPaper` (College Board hosts, every redirect hop checked). No new download path.
- Local only, never in a chat record, job record, or any synced file: PDF bytes, page images, learner photos. Synced: the course record (`data/ap/<id>.json`) and the question index (`data/ap-index/<id>.json`).
- The learner never sees the rubric, the scoring guideline, or any verdict before answering. `ap_frq`'s input carries no rubric; `ap_rubric` is refused before an answer; neither `ap_frq` nor `ap_rubric` is given a card that prints its raw input or output.
- The app shows no right/wrong mark on a free-response answer until the tutor has recorded the grading; the score card is the only verdict surface and renders only from `ap_record_frq`'s result.
- The tutor instruction text in Task 9 is owner-approved wording: copy it exactly.
- Names: tools `ap_frq`, `ap_rubric`, `ap_record_frq`, `ap_retag_part`, `ap_view_photo`, `ap_index_papers`; job kind `ap_index`; role `apIndexer`; routes `/api/ap/[id]/pages/[file]/[page]` and `/api/ap/[id]/questions/[qid]`.
- Tests on this Windows machine: `npm test` does not work. Use Bash: `NODE_ENV=test ./node_modules/.bin/tsx --test tests/<file>`. Typecheck `./node_modules/.bin/tsc --noEmit`; lint `./node_modules/.bin/eslint <files>`. The full suite takes about 8 minutes with 26 known platform failures plus a flaky pair in `tests/custom-provider-restart.test.ts`; run it only in Task 13. Every test touching a store sets `process.env.LH_DATA_DIR` to a temp directory before importing `config.ts`.
- Commits: `feat(ap): …` / `test(ap): …` / `docs(ap): …` / `fix(ap): …`, message ending with a blank line and `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Stage explicit paths only.

## Review Focus

1. **A paper present in the index but missing on this computer** (the second computer): `ap_frq` must refuse with a message telling the learner to download it from the course page; the page route must 404, not throw. → Tasks 4, 7.
2. **The tutor reports a rubric point id that does not exist, omits a part, or names a part twice** in `ap_record_frq`: refused with the exact problem, nothing recorded. → Tasks 1, 7.
3. **The indexing model returns pages out of range, a topic id not in the confirmed list, a part with no points, or duplicate question numbers**: that paper is rejected and reported as failed; other papers still index; nothing half-written. → Task 5.
4. **A photo path that is not an image, is outside the allowed folders, or is larger than the image limit**: `ap_view_photo` returns the guard's refusal; grading proceeds on the dictated answer. → Task 7.
5. **Deleting the session of a free-response attempt**: the attempt disappears from the course record, statuses replay, and the question becomes unused again. → Task 2.

---

### Task 1: Core types and pure rules

**Files:**
- Create: `src/core/ap-frq.ts`; export from `src/core/index.ts`
- Modify: `docs/superpowers/specs/2026-11-13-ap-prep-design.md` (append a section "Stage 2 amendments (2026-11-14)" containing the five owner decisions and the "Decided by Claude" list above, verbatim)
- Test: `tests/ap-frq-core.test.ts`

**Interfaces — Produces:**

```ts
export interface ApRubricPoint { id: string; text: string }            // id unique in the question: "<partLabel><n>", e.g. "a1"
export interface ApRealPart { label: string; topicId?: string; points: ApRubricPoint[] }   // topicId absent = tests nothing in the confirmed list
export interface ApRealQuestion {
	id: string;            // "2023-2" | "2023-s2-2"
	paperId: string;       // ApDocument.id of the frq paper
	scoringId: string;     // ApDocument.id of the scoring guideline
	year: number; set?: number; number: number;
	pages: number[];       // 1-based pages of the paper showing the question
	scoringPages: number[];
	parts: ApRealPart[];
}
export interface ApQuestionIndex { courseId: string; version: 1; updatedAt: string; questions: ApRealQuestion[] }
export interface ApRealAttempt { questionId: string; chatId: string; at: string; dontKnow?: boolean; parts: { label: string; earned: string[] }[] }

export function apPaperFileName(kind: "frq" | "scoring", year: number, set?: number): string;   // "frq-2023.pdf", "scoring-2023-set2.pdf"
export function apQuestionId(year: number, number: number, set?: number): string;
export function apQuestionTitle(q: Pick<ApRealQuestion, "year" | "set" | "number">): string;     // "2023 FRQ 2" | "2023 Set 2 FRQ 2"
export function isApQuestionIndex(value: unknown): value is ApQuestionIndex;

export interface ApPartScore { label: string; earned: number; total: number; topicId?: string; complete: boolean }
export interface ApAttemptScore {
	earned: number; total: number;
	parts: ApPartScore[];
	topics: { topicId: string; result: AnswerResult }[];   // one per distinct tagged topic, in part order
}
/** Problems with a grading the tutor submitted; empty = usable. */
export function attemptProblems(q: ApRealQuestion, parts: { label: string; earned: string[] }[]): string[];
export function scoreAttempt(q: ApRealQuestion, attempt: Pick<ApRealAttempt, "parts" | "dontKnow">, knownTopicIds: ReadonlySet<string>): ApAttemptScore;

export interface ApEligibleQuestion { question: ApRealQuestion; used: boolean; topicIds: string[] }
/** Real questions with at least one part tagged to a topic in scope, ordered by the
 *  weak-first position of their first in-scope topic, unused before used. */
export function eligibleRealQuestions(
	course: Pick<ApCourseRecord, "sections">, index: ApQuestionIndex | null,
	scope: ApSittingScope, chatId: string, attempts: readonly ApRealAttempt[],
): ApEligibleQuestion[];
```

Rules the tests pin:
- `attemptProblems` messages, exactly: `part "<label>" is not a part of this question`; `part "<label>" is listed more than once`; `part "<label>" is missing`; `point "<id>" is not a rubric point of part "<label>"`; `point "<id>" is listed more than once`.
- `scoreAttempt`: a part is `complete` when every point id of the part is in `earned`. A topic's result is `correct` only when every part tagged to it is complete, else `wrong`. With `dontKnow: true` every part scores 0 and every tagged topic is `dontKnow`. A part whose `topicId` is absent or not in `knownTopicIds` is scored but contributes no topic.
- `eligibleRealQuestions`: scope membership uses `topicInScope`; order uses `scopedQueue` position (a topic absent from the queue sorts after those present); `used` is true when `attempts` holds the question id; a `null` index gives `[]`.

- [ ] **Step 1: Write the failing tests** — one per rule above, plus: `apPaperFileName("frq", 2023)` is `frq-2023.pdf` and with set 2 `frq-2023-set2.pdf`; `apQuestionTitle` both forms; `isApQuestionIndex` rejects a question with no parts, a part with no points, duplicate question ids and duplicate point ids within a question.
- [ ] **Step 2: Run to verify failure** — `NODE_ENV=test ./node_modules/.bin/tsx --test tests/ap-frq-core.test.ts`; expected: module not found.
- [ ] **Step 3: Implement `src/core/ap-frq.ts`** and the barrel export. Append the spec amendments.
- [ ] **Step 4: Run to verify pass**, plus `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): free-response question index types and scoring rules`

### Task 2: Index store and attempts on the course record

**Files:**
- Create: `src/store/ap-index.ts`
- Modify: `config.ts` (`PATHS.apIndex` = `data/ap-index`), `src/store/ap-courses.ts`, `src/core/ap.ts` (`ApCourseRecord.realAttempts?: ApRealAttempt[]`), `src/server/stores.ts`
- Test: `tests/ap-index-store.test.ts`; extend `tests/ap-store.test.ts`, `tests/ap-session-delete.test.ts`

**Interfaces — Produces:**

```ts
export const apIndexStore: {
	get(courseId: string): ApQuestionIndex | null;                       // missing/malformed/invalid id → null, never rewritten
	putPaper(courseId: string, paperId: string, questions: ApRealQuestion[]): ApQuestionIndex;   // replaces every question whose paperId matches, keeps the rest, sorted by year desc, set, number
	retagPart(courseId: string, questionId: string, label: string, topicId: string | undefined): ApQuestionIndex;   // throws "unknown question" | "unknown part"
};
// ap-courses.ts additions
recordRealAttempt(id: string, attempt: ApRealAttempt, topics: { topicId: string; result: AnswerResult }[]): ApCourseRecord;
```

- `recordRealAttempt` throws `plan not confirmed` and `unknown topic` like `recordResult`, applies every topic result through `applyResult` with the attempt's `chatId` and `at`, appends the attempt to `realAttempts`, and writes once.
- `forgetChat` also drops that chat's `realAttempts`; it rewrites the file only when something changed (today's rule).
- `isApCourseRecord` accepts a record with or without `realAttempts` and rejects a malformed entry.
- Index writes are atomic (temp + rename, as `writeCourse` does) and emit `"ap-changed"`.

- [ ] **Step 1: Write the failing tests**: `putPaper` replaces only its own paper's questions and keeps order; `get` returns null for a corrupt file and leaves its bytes; `retagPart` sets and clears a tag and throws the two errors; `recordRealAttempt` moves two topics in one write and stores the attempt; an unknown topic records nothing; deleting the chat removes the attempt and replays statuses (Review Focus 5); a stage 1 record without `realAttempts` still loads.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass** (the three test files) and `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): question index store and recorded free-response attempts`

### Task 3: Saving released papers and scoring guidelines

**Files:**
- Modify: `src/agent/tools/ap.ts` (`ap_save_document`)
- Test: extend `tests/ap-tools.test.ts`

**Interfaces:**
- `ap_save_document` input gains optional `set: number`. Kinds: `ced` (unchanged: file `ced.pdf`, id `ced`), `frq`, `scoring`.
- For `frq` / `scoring`: `year` is required (refusal `year is required for a released paper or scoring guideline`); the file name is `apPaperFileName(kind, year, set)` and the id is that name without `.pdf`; the confirmed list is NOT required; saving the same year and set again replaces the document.
- Still refused inside a sitting, with stage 1's message for `ced` and, for the two new kinds, `Released papers are saved only in a setup or papers session, not during a sitting.`
- The result text for the new kinds: `Saved <label> as <file> (<pages> pages).`
- The tool description and the `kind` parameter description are updated to list the three kinds and the year rule (model-facing; mirror the existing register).

- [ ] **Step 1: Write the failing tests**: an frq save with a year downloads to `frq-2023.pdf` and records `{ id: "frq-2023", kind: "frq", year: 2023, … }`; set 2 gives `frq-2023-set2`; a scoring save likewise; missing year refused with no port call; a re-save replaces, not duplicates; refused in a sitting with the new message; `ced` behaviour unchanged.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**; `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): save released papers and scoring guidelines`

### Task 4: Page images and the question display route

**Files:**
- Create: `src/server/ap-pages.ts` (export from `src/server/index.ts`), `app/api/ap/[id]/pages/[file]/[page]/route.ts`, `app/api/ap/[id]/questions/[qid]/route.ts`
- Test: `tests/ap-pages.test.ts`

**Interfaces — Produces:**

```ts
export const AP_PAGE_DPI = 150;
/** PNG bytes of one page of a stored paper; rendered once, then served from
 *  data/ap-papers/<courseId>/pages/<file-without-.pdf>-p<page>.png. */
export async function apPageImage(courseId: string, file: string, page: number): Promise<Buffer>;
export function setApPageRenderer(render: (pdfPath: string, page: number, dpi: number) => Promise<Buffer>): void;  // test seam; default uses renderPdfPages
```

- `apPageImage` validates the course id and file through `apPaperPath`, requires an integer page ≥ 1, throws `paper not on this computer` when the PDF is absent and `no such page` when the renderer returns nothing. The cache write is atomic. The cache folder is inside the already-ignored `ap-papers/`.
- `GET /api/ap/[id]/pages/[file]/[page]` → `image/png` with `Cache-Control: private, max-age=31536000, immutable`; 404 for an unknown course, a file not among the course's documents, an absent paper or an invalid page. It serves only kinds `frq` and `ced`; a `scoring` document is always 404 (the scoring guideline is never shown).
- `GET /api/ap/[id]/questions/[qid]` → `{ id, title, file, pages, present, parts: [{ label, topicId?, topicText? }] }` — no rubric points, no scoring pages. `present` is whether the paper is on this computer. 404 for an unknown course or question.

- [ ] **Step 1: Write the failing tests** (inject a fake renderer returning fixed bytes): first call renders and writes the cache, second call does not call the renderer; absent paper and bad page throw the two messages; the pages route returns the bytes and headers, 404s the four cases, and 404s a scoring file even when present; the questions route returns the projection and its JSON contains no rubric text (assert a known point text is absent).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, after reading the route-handler guide.
- [ ] **Step 4: Run to verify pass**; `tsc --noEmit`; `eslint` on the new files.
- [ ] **Step 5: Commit** — `feat(ap): original page images and the question display route`

### Task 5: Indexing job

**Files:**
- Create: `src/agent/subagents/ap-indexer.ts`
- Modify: `config.ts` (`ModelRole` gains `apIndexer`), `src/core/settings.ts` (`ROLE_SLOT.apIndexer = "cheap"`), `src/core/contracts/jobs.ts` (`JobKind` gains `ap_index`; `ApIndexResult`; steer text; failure test), `src/agent/subagents/runner.ts` (`JobToolInput`, `KIND_ROLE`, `KIND_RUNNERS`, `runApIndexJob`, test override `apIndexModelOverride`, `JobRunnerDeps.apIndex`), `src/agent/tools/ap.ts` (`ap_index_papers`), `src/server/chat-handler.ts` (inject the port), `components/artifacts/index.ts` and `components/artifacts/dispatch-card.tsx` (`KIND_LABEL`), `src/core/pending.ts` (`ACTIVITY_LABELS.ap_index_papers = "Indexing released papers…"`)
- Test: `tests/ap-indexer.test.ts` (model on the job-runner test that injects a fake model)

**Interfaces — Produces:**

```ts
// contracts/jobs.ts
export interface ApIndexResult { brief: string; indexed: { paperId: string; questions: number }[]; failed: { paperId: string; reason: string }[]; untagged: number }
// failure shape: brief starts with "Indexing failed:" (isSubagentFailure for kind ap_index)

// runner.ts
JobRunnerDeps.apIndex?: {
	course(courseId: string): ApCourseRecord | null;
	index(courseId: string): ApQuestionIndex | null;
	putPaper(courseId: string, paperId: string, questions: ApRealQuestion[]): void;
	paperPath(courseId: string, file: string): string | null;   // null = not on this computer
};

// ap-indexer.ts
export async function indexApPaper(input: {
	paper: ApDocument; scoring: ApDocument; paperPath: string; scoringPath: string;
	topics: { id: string; unit: string; text: string }[];
}, opts: { engine: PiEngine | undefined; signal?: AbortSignal; chatId?: string; onUsage: (u: Usage) => void }): Promise<ApRealQuestion[]>;
```

- `ap_index_papers` (no parameters) is refused in a sitting (`Papers are indexed only in a setup or papers session, not during a sitting.`) and when the list is unconfirmed (`confirm the unit and topic list first — questions are tagged against it`). It dispatches one `ap_index` job (the `pdf` tool's dispatch path) with input `{ courseId }` and returns the usual fire-and-forget acknowledgement.
- The job pairs each `frq` document with the `scoring` document of the same year and set. A pair is skipped when the index already holds questions for that `paperId`; a paper without its scoring guideline, or with either file absent, is reported under `failed` (`no scoring guideline saved for this paper` / `not on this computer`).
- `indexApPaper` extracts both PDFs' text page by page (each page prefixed `--- page N ---`), and makes one `runSubmitAgent` call (role `apIndexer`) whose submitted value is `{ questions: [{ number, pages, scoringPages, parts: [{ label, topicId, points: [string] }] }] }` (`topicId` is a confirmed topic id or the empty string). The system prompt (model-facing, not learner-facing) states: index every free-response question; `pages` are the paper's pages showing that question, `scoringPages` the guideline pages scoring it; one entry per lettered part (a question with no lettered parts has a single part labelled `a`); each rubric point is one separately awarded point, quoted or closely paraphrased from the guideline; tag each part with the one listed topic it chiefly tests or leave it empty; never invent a question, part or point.
- `validate` rejects (so the model retries): no questions; duplicate question numbers; a page outside either document's page count; a part with no points; duplicate part labels in a question; a `topicId` that is neither empty nor in the list. Point ids are assigned by the server as `<label><n>`.
- After each successful pair the job calls `putPaper` and updates `activity` (`indexed <paper label>`). One failing pair never discards another's result. The final `brief` reads `Indexed <n> questions from <m> papers.` plus, when present, ` <k> parts have no topic tag.` and ` Failed: <label> (<reason>); …`. If every pair failed: `Indexing failed: <reasons>`.

- [ ] **Step 1: Write the failing tests** with a fake engine that submits a canned index: a good pair is stored with server-assigned point ids; an out-of-range page, an unknown topic id, a part with no points and duplicate numbers are each rejected and reported as failed while a second good pair is still stored (Review Focus 3); an already-indexed paper is skipped; a paper without a scoring guideline and an absent file are reported; the tool's two refusals; the brief strings.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, plus the existing job-runner and settings tests (`grep -rln "KIND_ROLE\|ROLE_SLOT\|runJob" tests`); `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): background job that indexes released papers`

### Task 6: The `ap_frq` question shape in core

**Files:**
- Modify: `src/core/question-core.ts`, `src/core/pending.ts`, `src/core/tool-parts.ts`, `src/core/native-messages.ts`, `src/core/answer-presentation.ts`, `src/core/session-markdown.ts`, `skills/learnharness/scripts/sessions.py`
- Test: `tests/ap-frq-question-core.test.ts`; extend `tests/question-part-routing.test.ts`, `tests/skills/test_sessions.py`

**Interfaces — Produces:**
- `QUESTION_TOOLS` gains `"ap_frq"`; `toolQuestionKind` returns a fourth value `"frq"` for it (update the return type and every exhaustive switch the compiler reports).
- `apFrqInputObject = Type.Object({ questionId: string, details?: string })` and `parseApFrqInput` (in `tool-parts.ts`, beside `parseApMcqInput`).
- `AnswerRequest` and `QuestionAnswerData` gain `parts?: { label: string; text: string }[]` and `photos?: string[]`; `QuestionAnswerData` also gains `frq?: { questionId: string; title: string; file: string; pages: number[] }` (what the answered card needs to show the page again; none of it is secret).
- `buildAnswer` for `ap_frq`: kind `"frq"`, `parts` trimmed with blank parts kept as `text: ""`, `photos` as given, `dontKnow`, no `correct`, no `confidence`, no `committed`.
- `compactAnswerForModel` for kind `"frq"`: `{ kind, dontKnow, questionId, parts: [{label, text}], photos }`.
- `AP_FRQ_ANSWER_FRAME` = `The learner answered the ap_frq question you posed. This tool result IS the learner's answer to each part and, when present, the paths of photos of their written work — call ap_rubric for this question, look at each photo with ap_view_photo, grade every rubric point, then call ap_record_frq.` — prefixed by `newAnswerResult` for `ap_frq` unless dismissed.
- Markdown export: heading `AP free-response`, the question title, each part's label and answer, `Photo attached` once per photo (no path), no verdict.
- `sessions.py`: `ap_frq` in its question tools.

- [ ] **Step 1: Write the failing tests**: kind and membership; `buildAnswer` for a two-part answer with one blank part and one photo; "I don't know"; the compact form; the frame present and absent on dismissal; presentation unchanged for `ap_mcq`; the export; routing (`tool-ap_frq` suppressed while streaming and pending, answered when output is available).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, plus `tests/ap-question-core.test.ts`, `tests/question-core.test.ts`, `tests/session-core.test.ts`; `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): ap_frq multi-part question shape`

### Task 7: Free-response tools and wiring

**Files:**
- Modify: `src/agent/tools/ap.ts`, `src/agent/teacher-agent.ts` (pass `engine.model` to `ap_view_photo` as `createReadTool` receives it), `src/server/chat-handler.ts`
- Test: `tests/ap-frq-tools.test.ts`; extend `tests/ap-tools.test.ts`

**Interfaces:**

```ts
// ApToolContext additions (all injected by chat-handler)
index: { get(courseId: string): ApQuestionIndex | null; retagPart(courseId: string, questionId: string, label: string, topicId: string | undefined): void };
attempts: { record(courseId: string, attempt: ApRealAttempt, topics: { topicId: string; result: AnswerResult }[]): ApCourseRecord };
/** The ap_frq answers already given in this chat: question id → answered. */
answeredFrq: (questionId: string) => "answered" | "pending" | "none";
```

- **`ap_frq({ questionId, details? })`** — a question tool (returns `questionResult()`). Refusals, in order: list unconfirmed; not a sitting; sitting kind is `mcq` (`this sitting is multiple-choice only`); unknown question id; the question has no part tagged to a topic in scope (`question <id> tests nothing in this sitting's scope`); the paper is not on this computer (`<paper label> is not on this computer — the learner can download it from the course page`) (Review Focus 1); the question was already answered while an unused eligible question remains (`<id> was already answered; ask <next unused id> first`). `details` is required when the previous answer in this chat was a miss, as `ap_mcq` requires it.
- **`ap_rubric({ questionId })`** — refused unless `answeredFrq(questionId) === "answered"` (`the rubric is available only after the learner has answered this question`). Returns the question's text (the paper pages via `pdfExtract`), then each part with its topic tag and its rubric points as `<id>: <text>`, then the scoring guideline's file name and pages for `pdf_extract`. No card is registered for it.
- **`ap_view_photo({ path })`** — loads the image with `loadLearnerImage`; returns the image with the text `Photo of the learner's written work.`; when the session model lacks image input, returns no image and the text `This model cannot see images. Say so, and grade the dictated answer only.`; a guard refusal is returned as its message (Review Focus 4). No card.
- **`ap_record_frq({ questionId, parts: [{ label, earned: string[] }], dontKnow? })`** — refused unless that question is answered in this chat and not yet recorded here; refused with `attemptProblems` messages (Review Focus 2). Computes `scoreAttempt`, calls `attempts.record`, and returns text (each part `label earned/total`, each topic's new status, overall readiness) with `details`:
  `{ questionId, title, earned, total, parts: [{ label, earned, total, topicText?, outcome: "earned" | "missed" | "not counted" }] }` (`not counted` = no listed topic).
- **`ap_retag_part({ questionId, part, topicId })`** — `topicId` is a confirmed topic id or `""` for none; unknown ids refused; allowed in any AP session.
- **`ap_progress`** — documents now show their kind and year; adds `Released questions indexed: <n>`; in an `frq` or `mixed` sitting adds a `Real questions:` block from `eligibleRealQuestions`, at most 20 lines: `<id> · <unused|used> · <label>→<topic text>; …`, with ` · PAPER MISSING on this computer` where it applies, or `Real questions: none for this scope`.
- **`ap_mcq`** is unchanged and stays available in every sitting kind (it is the retry after a free-response miss).
- `chat-handler.ts` injects `index`, `attempts` and `answeredFrq` (derived from the chat record's `ap_frq` tool calls and results), and passes `apIndex` to the job runner (Task 5's port) from the stores and `apPaperPath`/`apPaperPresent`.

- [ ] **Step 1: Write the failing tests**: each `ap_frq` refusal in order with zero store calls; the happy path returns the question placeholder; `ap_rubric` refused before an answer and complete after; `ap_view_photo` for an image, a non-image, an oversized file and a text-only model; `ap_record_frq` problems, a full-marks attempt (topics `correct`), a partial attempt (`wrong`), two parts sharing a topic, an untagged part (`not counted`), `dontKnow`, a second record for the same answer refused; `ap_retag_part`; the `ap_progress` block including the missing-paper mark.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, plus `tests/chat-flow.test.ts`; `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): free-response tools: pose, rubric, photo, record, retag`

### Task 8: Images are not kept in an AP session

**Files:**
- Modify: `src/server/turn-service.ts` (`persistTurn`)
- Test: extend the existing `persistTurn` test file (find with `grep -rln "persistTurn" tests`)

**Interfaces:**
- When the chat record's `kind` is `"ap"`, every `toolResult` message being saved has each `{ type: "image" }` content part replaced by one `{ type: "text", text: "[Image viewed during this turn; not kept in the session.]" }` (one note per message, however many images). `details` is untouched. The live turn's message array is not mutated (build a new message).
- Records of every other kind are saved exactly as today.

- [ ] **Step 1: Write the failing tests**: an AP turn with a tool result holding text + two images saves text + one note and leaves the in-memory message's images intact; the same turn in a Teach record saves the images; a later `toLlmMessages` of the saved AP record contains no image part.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**; `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): images viewed in an AP session are not saved`

### Task 9: Tutor instructions (owner-approved wording)

**Files:**
- Modify: `src/agent/prompts/ap/00-base.md`, `src/agent/prompts/ap/10-doctrine.md`
- Test: extend `tests/ap-prompt.test.ts`

**`00-base.md` — replace the `ap_save_document` paragraph with:**

```md
**`ap_save_document`** — saves an official College Board document into the course's local store: from a `url` on a College Board site, or from a `path` the learner attached. `kind` is `ced` for the course description, `frq` for a released free-response paper, `scoring` for that paper's scoring guideline; `frq` and `scoring` need the `year`, and `set` when a year has more than one. It returns the stored file name and page count. Only College Board addresses are accepted.
```

**`00-base.md` — insert after the `ap_record_result` paragraph:**

```md
**`ap_index_papers`** — starts a background job that reads every saved paper with its scoring guideline and builds the question index: each question's pages, its parts, the topic each part tests, and the official rubric points. It returns at once; the result arrives later as a message. Call it once after saving papers, never during a sitting.

**`ap_frq`** — asks one released free-response question, by its `questionId` from `ap_progress`. The learner sees the original page and answers every part in one go. You pass nothing else: the question, its parts and its rubric come from the index. One call per turn: pose, then end your turn.

**`ap_rubric`** — after the learner has answered an `ap_frq` question, returns that question's text, each part's topic, and each official rubric point with its id. It is refused before an answer.

**`ap_view_photo`** — shows you one photo of the learner's written work, by the path in their answer. The image is yours for this turn only and is not kept afterwards.

**`ap_record_frq`** — applies your grading of one answered free-response question: for each part, the ids of the rubric points earned. It returns the points per part, each topic's new status, and overall readiness. Call it once per question, before you speak.

**`ap_retag_part`** — corrects the topic a question part is tagged with, when the learner or the question itself shows the tag is wrong.
```

**`10-doctrine.md` — replace the last paragraph of "Setting up a course" ("Once the learner has confirmed the list, …") with:**

```md
Once the learner has confirmed the list, find the released free-response papers for the course and the scoring guideline for each, on College Board's site, for every year published under the current course framework. Save each with `ap_save_document`, then call `ap_index_papers` once and tell the learner the papers are being indexed and that practice and learning start from the course page. If you find no released papers, say so and stop.

A session may also open with the learner asking you to find released papers for a course that is already set up. Do the same: find, save, index, report. When the indexing result arrives, tell the learner how many questions were indexed and name any paper that failed.
```

**`10-doctrine.md` — replace the paragraph under "A practice sitting" that begins "`ap_progress` gives the sitting's scope" with:**

```md
`ap_progress` gives the sitting's scope, its question kind, the topic queue, and, for free-response and mixed sittings, the released questions that fit the scope. Work in the order it reports. When nothing is left, say so and stop.

- **Multiple-choice** — every question is one you write, with `ap_mcq`.
- **Free-response** — every question is a released one, with `ap_frq`, taking the first unused question listed. If none fits the scope, say so once and ask multiple-choice instead.
- **Mixed** — follow the topic queue; for a topic that has an unused released question, alternate between that question and a multiple-choice question you write.

If `ap_progress` reports a paper missing on this computer, say so, tell the learner the course page can download it again, and ask from what is available.
```

(The sentence "If `ap_progress` reports the course description missing on this computer, say so, tell the learner the course page can download it again, and stop." stays as it is.)

**`10-doctrine.md` — insert a new section after "Grading and after":**

```md
## Grading a free-response answer

The learner's answer to each part, and the paths of any photos, arrive as the result of your `ap_frq` call; grade in that turn.

1. Call `ap_rubric` for the question.
2. If there are photos, look at each with `ap_view_photo` and **say what you read from the page before you grade**. If a photo is unreadable, or you cannot see images, say so and grade the dictated answer alone.
3. Grade every rubric point against what the learner said and wrote. A point is earned only when the answer shows it; never award a point for a right final answer whose required working or justification is missing, and never award one on the strength of what the learner probably meant.
4. Call `ap_record_frq` with the points earned on each part. A part earns its topic only when every point on it was earned.

Then:

- **Every point earned** — say so briefly and move on.
- **Points lost** — for each part that lost points, give the correct answer and say which points were lost and exactly why. Then, for each missed topic inside this sitting's scope, pose a fresh multiple-choice question on it with `ap_mcq`, one at a time, with the diagnosis for that topic in its `details`.
- **"I don't know"** — record it with `dontKnow`, then give the correct answer to each part and continue as for points lost.

If the learner says a part is tagged with the wrong topic, or the question plainly tests a different listed topic, correct it with `ap_retag_part` before you record.
```

**`10-doctrine.md` — in "Standing prohibitions", replace "Never present a question you wrote as a released College Board question." with:**

```md
- Never present a question you wrote as a released College Board question, and never alter a released question.
- Never read out, quote or summarise the scoring guideline before the learner has answered.
```

- [ ] **Step 1: Write the failing tests**: the composed AP prompt contains each inserted block's first sentence, no longer contains `In this version every question is multiple-choice`, and still contains the two stage 1 sentences `tests/ap-prompt.test.ts` already pins.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Apply the edits exactly.** Verify mechanically that each block above appears verbatim in its file.
- [ ] **Step 4: Run to verify pass**, plus the prompt-override and settings prompt tests.
- [ ] **Step 5: Commit** — `feat(ap): tutor instructions for released free-response questions`

### Task 10: The multi-part answer form and answered card

**Files:**
- Create: `components/ap/frq-question.tsx` (the form body), `components/ap/question-pages.tsx` (the page images)
- Modify: `components/question-dock.tsx`, `components/answered-card.tsx`, `components/chat.tsx` (the `toolName` cast; pass `apCourseId` to the dock and the card)
- Test: `tests/ap-frq-ui.test.tsx` (model on `tests/ap-question-ui.test.tsx`)

**Interfaces:**
- Live dock for `ap_frq`: header label `AP · released` followed by the question title (`2023 FRQ 2`); the page images, loaded from `/api/ap/<courseId>/pages/<file>/<page>` after fetching `/api/ap/<courseId>/questions/<questionId>`; under them one answer box per part, labelled `(a)`, `(b)` …, each a `PathInput` with file paths disallowed, dictation going to the focused box (first by default); an `Attach photo` button that opens the native file picker (`requestNativePaths("files")`) and lists each chosen file as a removable chip showing its file name; the `I don't know` control; Submit, enabled when any part has text, or a photo is attached, or "I don't know" is on. `details`, when present, renders where `ap_mcq` renders it. No confidence slider. While the question data loads: `Loading the question…`; when the paper is absent: `This paper is not on this computer. Download it from the course page.` with a link to `/ap/<courseId>` and Submit disabled.
- Submitting builds `AnswerRequest { dontKnow, parts, photos }` and the `frq` block (`questionId`, `title`, `file`, `pages`) for `buildAnswer`.
- Answered card for `ap_frq`: the title, the page images (collapsed behind `Show question`), each part's label and the learner's text (`—` for a blank part), `Photo attached` per photo (file name only), `I don't know` when set. No mark of any kind.
- Collapsed bar label: `AP · released`.

- [ ] **Step 1: Write the failing tests** (server-render with a stubbed fetch, as the AP UI tests do): the form shows one box per part with its label, the title, `AP · released`, `Attach photo`, no `data-testid="confidence-slider"`; Submit disabled with nothing entered and enabled with one part filled; the absent-paper message; the answered card for a two-part answer with a blank part and a photo, containing no rubric text and none of the answered-card verdict test ids.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, following each `ap_mcq` branch in the dock and the card.
- [ ] **Step 4: Run to verify pass**, plus the existing dock and answered-card render tests (`grep -rln "question-dock\|answered-card" tests`); `tsc --noEmit`; `eslint`.
- [ ] **Step 5: Commit** — `feat(ap): multi-part free-response form with page images and photo attach`

### Task 11: Score card and tool cards

**Files:**
- Create: `components/ap/frq-score-card.tsx`
- Modify: `components/artifacts/index.ts` (`ap_record_frq: FrqScoreCard`; `ap_index_papers` → the job dispatch card as `pdf` uses; `ap_retag_part` → `ToolCallCard`), `components/artifacts/tool-call-card.tsx` (`headlineArg`: `questionId` for `ap_retag_part`), `src/core/pending.ts` (`ACTIVITY_LABELS`: `ap_rubric: "Reading the scoring guideline…"`, `ap_view_photo: "Looking at your photo…"`, `ap_record_frq: "Recording the score…"`)
- Test: `tests/ap-frq-score-card.test.tsx`

**Interfaces:**
- `FrqScoreCard` renders from the tool result `details` of `ap_record_frq`: a header `<title> — scored <earned>/<total>`, then one row per part: `(<label>) <earned>/<total>`, the topic text, and `earned`, `missed` or `not counted`. It renders nothing when the part has no valid details (a refused call).
- `ap_frq`, `ap_rubric` and `ap_view_photo` are deliberately NOT in the registry (an unregistered tool renders nothing).

- [ ] **Step 1: Write the failing tests**: the card for the preview's example (6/9; earned, missed, missed); an untagged part reads `not counted`; refused-call output renders nothing; the registry maps the three names and omits `ap_frq`, `ap_rubric`, `ap_view_photo`; the three activity labels.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, plus `tests/ap-course-ui.test.tsx`, `tests/stream-activity.test.ts`; `tsc --noEmit`; `eslint`.
- [ ] **Step 5: Commit** — `feat(ap): free-response score card`

### Task 12: Course page, sitting chooser and "Find released papers"

**Files:**
- Modify: `app/ap/[id]/page.tsx` (load the index summary), `components/ap/course-view.tsx`, `components/ap/start-sitting.tsx`, `app/api/ap/[id]/route.ts` (add `indexedQuestions: number` and, per `frq` document, `questions: number`)
- Test: extend `tests/ap-course-ui.test.tsx`, `tests/ap-routes.test.ts`

**Interfaces:**
- Documents block: each document row shows its label and, for a released paper, `<n> questions indexed` or `not indexed yet`. Under the block: `Released questions indexed: <n>` and a `Find released papers` button. The button creates an AP session for this course with no sitting (`{ title, kind: "ap", apCourseId }`) whose title and first message is `Find the released free-response papers for <course title>.`, sent the way the Learn button sends its prompt, and navigates to it. It is shown only once the list is confirmed.
- Sitting chooser: `Free-response` and `Mixed` start a sitting of that kind when `indexedQuestions > 0`; otherwise they stay disabled with the note `needs released papers` (replacing `multiple-choice only for now`).

- [ ] **Step 1: Write the failing tests**: the route's two new fields; with zero indexed questions the two kinds are disabled with the new note; with some indexed they start `{ kind: "frq" }` / `{ kind: "mixed" }` sittings (assert the creation body); the documents block rows and the button; the button's creation body and first message; the button absent before confirmation.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, after reading the page guide.
- [ ] **Step 4: Run to verify pass**; `tsc --noEmit`; `eslint`.
- [ ] **Step 5: Commit** — `feat(ap): free-response sittings and finding released papers from the course page`

### Task 13: Docs, full suite, hand-check

**Files:**
- Modify: `docs/ap-prep.md` (released papers and indexing; free-response sittings; answering parts; attaching a photo and that it is not kept; the score card; what syncs and what stays local; second-computer download), `docs/architecture.md` (index store, indexing job, page route, the rubric gate, image stripping)

- [ ] **Step 1: Update the docs**, quoting on-screen labels exactly as the code renders them. No personal names or machine paths.
- [ ] **Step 2: Run the whole suite** — `NODE_ENV=test ./node_modules/.bin/tsx --test tests/*.test.ts tests/*.test.tsx`, output to a file; compare the failing set by name with the pre-branch baseline. Expected: the known platform failures (and at most the flaky `custom-provider-restart` timeouts, which must pass when that file runs alone) and nothing else.
- [ ] **Step 3:** `tsc --noEmit` and `eslint .` — no new errors.
- [ ] **Step 4: Commit** — `docs(ap): released free-response questions`
- [ ] **Step 5: Hand-check with the owner on the running app** (not markable from tests): on a confirmed course press `Find released papers` and watch the tutor save papers and start indexing; confirm the course page shows indexed questions and that `data/ap-index/` holds the index while `git -C data status` shows no PDF or PNG; start a free-response sitting, check the original page shows, answer some parts, attach a photo, and confirm the tutor states what it read before grading; check the score card and the topic statuses; reopen the session and confirm the photo is not in it; press Download on the second computer and confirm real questions work there without re-indexing.
