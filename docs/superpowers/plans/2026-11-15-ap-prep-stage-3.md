# AP Prep Stage 3 (Generated Free-Response and Drawn Figures) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AP tutor can write its own multi-part free-response questions with a rubric it commits before posing, and can put a drawn figure in a generated question of either kind after looking at it.

**Architecture:** A generated free-response question travels whole in the tutor's tool call (stem, parts, committed answers and rubric points), exactly as a multiple-choice question's answer key does today; the screens read only its display fields. Grading reuses stage 2's per-point scoring against that committed rubric. Figures come from the existing drawing job: the tutor starts one, later looks at the finished drawing through a new tool, and only then may name it in a question; the question shows it from a new route that serves the drawing as an image.

**Tech Stack:** Next.js (this repo's version; read `node_modules/next/dist/docs/` first), TypeScript, `@earendil-works/pi-agent-core`, TypeBox, `@resvg/resvg-js` (already used to rasterise drawings), node:test via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-13-ap-prep-design.md` (sections 5, 6, "Stages" item 3, and in "Decided by Claude": free-response retry, generated figures arrive late, weak-first order across a mixed sitting), plus its "Stage 2 amendments", plus the owner decision below.

## Owner decision for this stage (2026-11-15)

- **Released first, then generated.** In a free-response sitting the tutor uses an unused released question for a topic when one exists and writes its own when none fits or all are used. Free-response sittings therefore work for a course with no released papers, and the chooser no longer says `needs released papers`.

## Decided by Claude (owner can override at plan approval)

- **Names.** Tools `ap_frq_gen` (pose a generated free-response question), `ap_record_gen` (record its grading), `ap_view_figure` (look at a finished drawing); the existing drawing tool `visual` joins the AP tutor's tools unchanged; route `/api/chats/[id]/figures/[jobId]`. A generated question's id is `gen-<tool call id>`.
- **The drawing appears in the chat when it is ready**, as it does in Teach, before the question that uses it. Reusing the existing drawing tool and its card keeps one behaviour across modes; the cost is that a drawing the tutor then rejects has been seen.
- **A figure must be looked at before it is used.** `ap_mcq` and `ap_frq_gen` refuse a figure the tutor has not opened with `ap_view_figure` in this session. If the session's model cannot see images, the tutor cannot check a figure and so poses questions without one.
- **The Settings switch for drawings (`visual`) governs figures in AP too.** With it off, the tutor has no drawing tool and writes figure-free questions.
- **Released-first is enforced, with the retry exempt.** `ap_frq_gen` is refused while an unused released question covers one of its topics, unless that topic was missed in this sitting (the retry).
- **A generated question has one to six parts.** The retry after lost points is a short one: one or two parts on the missed topic.
- **The committed rubric is withheld the way a multiple-choice answer key is**: it sits in the tutor's tool call, the question never renders that call's raw input, and the form and the answered card read only the stem, the part prompts and the figure.
- **Scoring and readiness are unchanged**: per rubric point, a topic correct only when every point on every part testing it was earned, one "I don't know" for the whole question, the same score card.
- **This plan also corrects three sentences in the tutor instructions that stage 2 left inaccurate** (when to record a grading, what the PDF tools may read during a sitting, and that `ap_frq` accepts an optional `details` line).

## Global Constraints

- Read `AGENTS.md` first. Before writing or changing any route handler or page, read the relevant guide under `node_modules/next/dist/docs/` and name it in your report.
- Do not change the behaviour of Teach, Practice, Test prep, AP multiple-choice without a figure, or released free-response questions. `src/core/test-prep.ts` is imported, never edited. The drawing job itself (`src/agent/subagents/visual-maker.ts`, the `visual` tool's schema and steer text) is not changed.
- Layering: `src/core/**` imports nothing from `src/agent`, `src/store` or `src/server`. `src/agent/**` imports no store adapter and no server module; stores and job results reach it as injected ports. `app/**` imports only from `src/server/index.ts` and the core barrel. Client components import no server-only code.
- The learner never sees a committed answer, a rubric point or a verdict before answering. No screen prints the raw input of `ap_frq_gen`; the form and the answered card render only `title`, `stem`, each part's `label` and `prompt`, `details` and the figure. `ap_frq_gen`, `ap_record_gen`'s input and `ap_view_figure` get no card that prints raw input.
- The score card is the only verdict surface for a free-response answer and renders only from a successful recording.
- A figure reaches a question only by its job id, only from a finished drawing job of the same chat, and only after `ap_view_figure` succeeded for it in this chat.
- Images viewed by the tutor are not saved in an AP session (stage 2's rule already covers `ap_view_figure`).
- The tutor instruction text in Task 5 is owner-approved wording: copy it exactly.
- Tests on this Windows machine: `npm test`, `npm run typecheck` and `npm run lint` do not work. Use Bash: `NODE_ENV=test ./node_modules/.bin/tsx --test tests/<file>`; `./node_modules/.bin/tsc --noEmit`; `./node_modules/.bin/eslint <files>`. The full suite needs `--test-concurrency=3` (the machine is short on memory), takes about 15 minutes and has 20 known platform failures; run it only in Task 7. Every test touching a store sets `process.env.LH_DATA_DIR` to a temp directory before importing `config.ts`.
- Commits: `feat(ap): …` / `test(ap): …` / `docs(ap): …` / `fix(ap): …`, message ending with a blank line and `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Stage explicit paths only.

## Review Focus

1. **A figure id from another chat, an unfinished or failed drawing, or a job that is not a drawing**: every question tool refuses with a specific message; the figure route 404s; nothing is shown. → Tasks 2, 3.
2. **The tutor poses a question with a figure in the same turn it looked at the figure**: must be allowed (the look happened this turn, before the saved record knows). → Task 3.
3. **The rubric of a generated question on screen**: the form, collapsed bar, answered card, a reloaded session and the markdown export contain no committed answer and no rubric point text. → Tasks 1, 6.
4. **Recording a generated question twice, recording with a point id that was never committed, or recording when no generated question was answered**: refused, nothing written. → Task 4.
5. **A generated question written while an unused released question covers its topic** (not a retry): refused, naming the released question. → Task 4.

---

### Task 1: The generated free-response shape in core

**Files:**
- Modify: `src/core/ap-frq.ts`, `src/core/question-core.ts`, `src/core/pending.ts`, `src/core/tool-parts.ts`, `src/core/native-messages.ts`, `src/core/session-markdown.ts`, `skills/learnharness/scripts/sessions.py`
- Test: `tests/ap-gen-core.test.ts`; extend `tests/question-part-routing.test.ts`, `tests/skills/test_sessions.py`

**Interfaces — Produces:**

```ts
// question-core.ts
export const apFrqGenInputObject = Type.Object({
	title: string,              // short label, e.g. "Rates of change in a cooling model"
	stem: string,               // the shared setup the learner reads
	parts: Type.Array(Type.Object({
		label: string,          // AP_PART_LABEL_PATTERN
		prompt: string,         // what the learner is asked
		topicId: string,        // the one listed topic this part tests
		answer: string,         // committed model answer — never displayed
		points: Type.Array(string),   // committed rubric points — never displayed
	})),
	figure: Type.Optional(string),    // a finished drawing's job id
	details: Type.Optional(string),
});
export type ApFrqGenToolInput = Static<typeof apFrqGenInputObject>;
export function apFrqGenInputProblems(input: ApFrqGenToolInput): string[];
/** What a screen may show of a generated question: no answer, no points. */
export interface ApFrqGenDisplay { title: string; stem: string; parts: { label: string; prompt: string }[]; figure?: string; details?: string }
export function apFrqGenDisplay(input: ApFrqGenToolInput): ApFrqGenDisplay;
// apMcqInputObject gains: figure: Type.Optional(string)

// ap-frq.ts
export function apGenQuestionId(toolCallId: string): string;   // "gen-<toolCallId>"
/** The committed rubric as a scorable question: point ids "<label><n>". */
export function generatedScoringQuestion(input: ApFrqGenToolInput): Pick<ApRealQuestion, "parts">;
// attemptProblems and scoreAttempt accept Pick<ApRealQuestion, "parts">
```

- `apFrqGenInputProblems` messages, exactly: `title must not be blank`; `stem must not be blank`; `between one and six parts are required`; `part labels must be one lower-case letter, sub-parts hyphenated, and distinct`; `part "<label>" needs a prompt`; `part "<label>" needs a committed answer`; `part "<label>" needs at least one rubric point`; `rubric points must not be blank`.
- `QUESTION_TOOLS` gains `"ap_frq_gen"`; `toolQuestionKind("ap_frq_gen")` is `"frq"`. `parseApFrqGenInput` joins `parseQuestionInput`.
- `QuestionAnswerData.frq` and `AnswerRequest.frq` become `{ questionId: string; title: string; file?: string; pages?: number[] }` (a generated question has no file or pages). `buildAnswer` and `compactAnswerForModel` for `ap_frq_gen` behave as for `ap_frq`.
- `AP_FRQ_GEN_ANSWER_FRAME` = `The learner answered the ap_frq_gen question you posed. This tool result IS the learner's answer to each part and, when present, the paths of photos of their written work — look at each photo with ap_view_photo, grade every rubric point you committed, then call ap_record_gen.`
- Markdown export for `ap_frq_gen`: heading `AP free-response (generated)`, the title, the stem, each part's label, prompt and the learner's answer, `Photo attached` per photo. Never `answer` or `points`.
- `sessions.py`: `ap_frq_gen` in its question tools.

- [ ] **Step 1: Write the failing tests**: each problem message; a valid three-part input has no problems; `apFrqGenDisplay` output contains no `answer` or `points` key at any depth; `generatedScoringQuestion` ids are `a1`, `a2`, `b1`; `scoreAttempt` over it (full marks, a partial part, two parts sharing a topic, `dontKnow`); kind and membership; the frame present and absent on dismissal; the export contains the prompts and the learner's answers and none of the committed text; routing of `tool-ap_frq_gen`; an `ap_mcq` input with and without `figure` parses.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, plus `tests/ap-frq-core.test.ts`, `tests/ap-frq-question-core.test.ts`, `tests/ap-question-core.test.ts`, `tests/question-core.test.ts`; `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): generated free-response question shape`

### Task 2: Serving a finished drawing as an image

**Files:**
- Create: `src/server/ap-figures.ts` (export from `src/server/index.ts`), `app/api/chats/[id]/figures/[jobId]/route.ts`
- Test: `tests/ap-figures.test.ts`

**Interfaces — Produces:**

```ts
export type FigureState = "ready" | "pending" | "failed" | "unknown";
/** A drawing job of this chat, by job id. "unknown" covers another chat's job and any other job kind. */
export function figureState(chatId: string, jobId: string): FigureState;
/** PNG of a ready figure, rasterised from its stored SVG. Throws "figure not ready" otherwise. */
export async function figurePng(chatId: string, jobId: string): Promise<Buffer>;
export function setFigureRasteriser(render: (svg: string) => Promise<Buffer>): void;   // test seam; default uses the headless module's native SVG renderer
```

- `figureState` reads the job store: kind must be `visual` and `chatId` must match, else `unknown`; `running` → `pending`; `done` with a non-empty `result.svg` → `ready`; anything else → `failed`.
- `GET /api/chats/[id]/figures/[jobId]` → `image/png`, `Cache-Control: private, no-cache`; 404 unless `ready`. An unexpected rasteriser error is logged and returns 500 `{ error: "Could not render the figure" }`.
- Rasterise at a width of 1200 px (the learner's screen is high-density); an SVG larger than 512 KB is refused as `failed`.

- [ ] **Step 1: Write the failing tests** (fake rasteriser): the four states including a job of another chat and a `research` job (Review Focus 1); `figurePng` for a ready job and its refusal otherwise; the route's bytes, headers, 404s and 500.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, after reading the route-handler guide.
- [ ] **Step 4: Run to verify pass**; `tsc --noEmit`; `eslint`.
- [ ] **Step 5: Commit** — `feat(ap): serve a finished drawing as an image`

### Task 3: Figures in the tutor's tools

**Files:**
- Modify: `src/agent/tools/ap.ts`, `src/agent/teacher-agent.ts` (bind the session model to `ap_view_figure` as `ap_view_photo` is bound), `src/server/chat-handler.ts`
- Test: `tests/ap-figure-tools.test.ts`; extend `tests/ap-tools.test.ts`

**Interfaces:**

```ts
// ApToolContext additions (injected by chat-handler)
figures: { state(jobId: string): FigureState; png(jobId: string): Promise<Buffer> };
/** Figure ids already looked at in this chat, from the saved record. */
viewedFigures: ReadonlySet<string>;
```

- The existing `visual` tool joins the AP registry exactly as Teach registers it (same schema, description, card and Settings switch), registered only when `ctx.jobs` is present.
- **`ap_view_figure({ figure })`** — refusals by state: `figure <id> is not a figure drawn in this session`; `figure <id> is not finished yet`; `figure <id> could not be drawn`. When ready: returns the PNG as an image with the text `Figure <id>, as the learner will see it.` and remembers the id as viewed for the rest of this turn. When the session model lacks image input: no image, text `This model cannot see images, so the figure cannot be checked. Pose the question without a figure.`, and the id is NOT remembered. No card.
- **`ap_mcq`** accepts `figure`. When given, refusals in this order: the three state messages above (with ` — ask a question that needs no figure meanwhile` appended to the not-finished one); then `look at figure <id> with ap_view_figure before using it` unless the id is in `viewedFigures` or was viewed earlier in this turn (Review Focus 2). Without `figure` the tool behaves exactly as today.
- A pure exported `viewedFiguresFrom(messages)` derives the saved set from successful `ap_view_figure` results; `chat-handler.ts` injects it and builds the `figures` port from Task 2.

- [ ] **Step 1: Write the failing tests**: `visual` present in the AP registry with jobs and absent without, and removed by the Settings switch; `ap_view_figure` in each state, with a text-only model, and marking the id viewed; `ap_mcq` with a figure in each refusal state, with an unviewed figure, with a figure viewed in the saved record, and with one viewed earlier in the same turn; `ap_mcq` without a figure unchanged; `viewedFiguresFrom`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, plus `tests/ap-frq-tools.test.ts`, `tests/chat-flow.test.ts`; `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): the tutor can draw a figure, look at it, and use it in a question`

### Task 4: Posing and recording a generated free-response question

**Files:**
- Modify: `src/agent/tools/ap.ts`, `src/server/chat-handler.ts`
- Test: `tests/ap-gen-tools.test.ts`

**Interfaces:**

```ts
// ApToolContext addition (injected by chat-handler, derived from the chat record)
/** Every ap_frq_gen pose in this chat, oldest first. */
generatedFrqs: { toolCallId: string; input: ApFrqGenToolInput; answered: boolean }[];
```

- **`ap_frq_gen(input)`** — a question tool. Refusals, in order: list unconfirmed; not a sitting; sitting kind `mcq` (`this sitting is multiple-choice only`); `apFrqGenInputProblems`; a part whose `topicId` is not in the confirmed list (`part "<label>": unknown topic <id>`); no part's topic inside the sitting's scope (`this question tests nothing in this sitting's scope`); the figure refusals of Task 3 when `figure` is given; released-first (Review Focus 5): for each part topic, when an unused eligible released question covers that topic and the topic is not a miss from this sitting (its status is `gap` and its last history entry is this chat's), refuse with `a released question covers <topic text>: ask <question id> with ap_frq first`.
- **`ap_record_gen({ parts?, dontKnow? })`** — applies to the newest answered generated question in this chat. Refusals: none answered (`no generated free-response question has been answered in this session`); already recorded — the course record holds an attempt with id `gen-<toolCallId>` for this chat (`that question is already recorded`) (Review Focus 4); `attemptProblems` against `generatedScoringQuestion`. With `dontKnow: true` the tool fills every part with nothing earned. It records through the stage 2 attempts port with `questionId` `gen-<toolCallId>` and returns the same text and `details` shape as `ap_record_frq` (`title` is the generated question's title).
- **`ap_progress`** — in a `frq` or `mixed` sitting, after the `Real questions:` block, adds `Topics with no unused released question: <topicId · topic text; …>` (at most 20), or omits the line when every queue topic has one.
- A pure exported `generatedFrqsFrom(messages)` builds the port value; a pose counts as answered when its result is a real, non-dismissed free-response answer (stage 2's `realFrqAnswer` rule).

- [ ] **Step 1: Write the failing tests**: each `ap_frq_gen` refusal in order with zero store calls; the released-first refusal and its retry exemption; the happy path returns the question placeholder; `ap_record_gen` with none answered, a full-marks and a partial grading, two parts sharing a topic, `dontKnow`, a bad point id, a second record refused both from the saved record and back to back in one turn; the `ap_progress` line; `generatedFrqsFrom` (pending, answered, dismissed).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, plus `tests/ap-frq-tools.test.ts`, `tests/ap-tools.test.ts`, `tests/chat-flow.test.ts`; `tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ap): pose and record a generated free-response question`

### Task 5: Tutor instructions (owner-approved wording)

**Files:**
- Modify: `src/agent/prompts/ap/00-base.md`, `src/agent/prompts/ap/10-doctrine.md`
- Test: extend `tests/ap-prompt.test.ts`

**`00-base.md` — replace the paragraph beginning "**`pdf_info`, `pdf_extract`, `pdf_search`**" with:**

```md
**`pdf_info`, `pdf_extract`, `pdf_search`** — read a stored document by the file name `ap_save_document` or `ap_progress` gave you: its page count, the text of a page range, or the pages where a phrase appears. During a sitting only the course description and released papers can be read this way; a scoring guideline reaches you through `ap_rubric`.
```

**`00-base.md` — replace the paragraph beginning "**`ap_mcq`**" with:**

```md
**`ap_mcq`** — asks one multiple-choice question on one topic. `topicId` must name a topic in the confirmed list and inside this sitting's scope. Exactly four options, exactly one correct. `correctAnswer` and `optionNotes` (one line per option: why it is right, or the specific error that leads to it) are your commitment, written before the learner answers and never revised; neither is displayed. `figure`, when the question needs a drawing, is the id of a figure you have drawn and looked at. The learner picks an option and may add their reasoning. One call per turn: pose, then end your turn.
```

**`00-base.md` — replace the paragraph beginning "**`ap_frq`**" with:**

```md
**`ap_frq`** — asks one released free-response question, by its `questionId` from `ap_progress`. The learner sees the original page and answers every part in one go. The question, its parts and its rubric come from the index; besides the id you may pass `details`, a short line shown with the question. One call per turn: pose, then end your turn.
```

**`00-base.md` — replace the paragraph beginning "**`ap_record_frq`**" with:**

```md
**`ap_record_frq`** — applies your grading of one answered released question: for each part, the ids of the rubric points earned. It returns the points per part, each topic's new status, and overall readiness. Call it once per question, after you have said what you read from any photo and before you give the result.
```

**`00-base.md` — insert after the `ap_retag_part` paragraph:**

```md
**`ap_frq_gen`** — asks one free-response question you wrote. You give its `title`, the `stem` the learner reads, and one to six `parts`; each part has a `label`, the `prompt`, the one listed topic it tests, your committed `answer`, and its rubric `points`, each a single separately awarded point. The answers and points are your commitment, written before the learner answers and never revised; neither is displayed. `figure` is the id of a figure you have drawn and looked at. It is refused while an unused released question covers one of its topics, unless that topic was just missed in this sitting. One call per turn: pose, then end your turn.

**`ap_record_gen`** — applies your grading of the generated question the learner just answered: for each part, the ids of the rubric points earned, numbered in the order you wrote them (`a1`, `a2`, `b1`). It returns the points per part, each topic's new status, and overall readiness. Call it once per question.

**`visual`** — starts a background job that draws one precise figure from your brief. It returns at once with the figure's id; the drawing arrives later as a message and appears in the chat. Describe exactly what to draw and every label and value on it; the drawer knows nothing else.

**`ap_view_figure`** — shows you a finished figure, by its id, as the learner will see it. A question accepts only a figure you have looked at this way.
```

**`10-doctrine.md` — replace the three bullets under "A practice sitting" (Multiple-choice / Free-response / Mixed) with:**

```md
- **Multiple-choice** — every question is one you write, with `ap_mcq`.
- **Free-response** — for each topic, ask an unused released question with `ap_frq` when `ap_progress` lists one; when none fits or all are used, write one with `ap_frq_gen`.
- **Mixed** — follow the topic queue, alternating a multiple-choice question you write with a free-response question, released when an unused one covers the topic and written by you otherwise.
```

**`10-doctrine.md` — replace the "Writing a question" section (heading and paragraph) with:**

```md
## Writing a question

Before writing, read the topic's pages in the course description and the official sample questions for its unit, and model the question on them: the same skills, the same level, the same kind of wrong answers. One topic per multiple-choice question. Four options, each wrong option a mistake a real student makes; never a joke option, never "all of the above" or "none of the above".

A free-response question you write is modelled on the released ones for the course: a stem, then parts that build on it, each part testing one listed topic. Write the complete solution first, then the rubric from it: one point for each thing a grader would separately award, worded so that it is plain whether an answer shows it. Never write a part you have not solved.

## Figures

Use a figure only when the question cannot be asked properly without one: a graph to read, a diagram of a physical setup, a geometric construction. Start it with `visual`, giving every value and label, and meanwhile ask a question that needs no figure. When the figure arrives, look at it with `ap_view_figure` and check every value, label and direction against the question you intend to ask. Use it only if it is exactly right; if it is not, say nothing of it and ask the question without a figure, or draw again with a tighter brief. Never describe in words what the figure is meant to show in place of a correct figure, and never ask the learner to imagine one.
```

**`10-doctrine.md` — in "Grading a free-response answer", replace step 1 with:**

```md
1. For a released question, call `ap_rubric`. For a question you wrote, the rubric is the one you committed.
```

**and replace step 4 with:**

```md
4. Record the points earned on each part: `ap_record_frq` for a released question, `ap_record_gen` for one you wrote. A part earns its topic only when every point on it was earned.
```

**and replace the "Points lost" bullet with:**

```md
- **Points lost** — for each part that lost points, give the correct answer and say which points were lost and exactly why. Then, for each missed topic inside this sitting's scope, pose a fresh short free-response question on it with `ap_frq_gen`, one or two parts, different from the one just seen, one topic at a time.
```

**`10-doctrine.md` — in "Standing prohibitions", after "Never read out, quote or summarise the scoring guideline before the learner has answered." add:**

```md
- Never reveal a committed answer or a rubric point before the learner has answered.
- Never use a figure you have not looked at.
```

- [ ] **Step 1: Write the failing tests**: the composed AP prompt contains the first sentence of each replaced or inserted block and each new prohibition, and no longer contains `Use text, tables, mathematical notation and inline diagrams only`, `before you speak`, `You pass nothing else`, or `pose a fresh multiple-choice question on it with`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Apply the edits exactly.** Verify mechanically that each block appears verbatim and every other line of both files is unchanged.
- [ ] **Step 4: Run to verify pass**, plus the prompt-override and settings prompt tests.
- [ ] **Step 5: Commit** — `feat(ap): tutor instructions for generated free-response and figures`

### Task 6: Screens for generated questions and figures

**Files:**
- Create: `components/ap/question-figure.tsx`
- Modify: `components/ap/frq-question.tsx`, `components/question-dock.tsx`, `components/answered-card.tsx`, `components/chat.tsx` (pass the chat id to the dock and the card), `components/artifacts/index.ts` (`ap_record_gen: FrqScoreCard`), `src/core/pending.ts` (`ACTIVITY_LABELS`: `ap_view_figure: "Checking the figure…"`, `ap_record_gen: "Recording the score…"`)
- Test: `tests/ap-gen-ui.test.tsx`; extend `tests/ap-frq-score-card.test.tsx`

**Interfaces:**
- `QuestionFigure({ chatId, figure })` renders `<img>` from `/api/chats/<chatId>/figures/<figure>` with `alt="Figure for this question"`, lazy; a failed image shows `This figure could not be shown.`
- Live form for `ap_frq_gen`: header label `AP · generated`, the title, `details` where `ap_frq` shows it, the figure when given, the stem, then one answer box per part, each headed `(<label>)` and the part's `prompt`. Photo attach, `I don't know`, Submit, dictation and drafts behave exactly as for `ap_frq`. It needs no fetch: everything shown comes from `apFrqGenDisplay` of the call input. Submitting sends `frq: { questionId: apGenQuestionId(toolCallId), title }`. Collapsed bar: `AP · generated` and the teaser `Free-response question`.
- Answered card for `ap_frq_gen`: `AP · generated`, title, figure, stem, each part's label, prompt and the learner's text (`—` when blank), `Photo attached` per photo, `Answered “I don't know”.` when set. No mark.
- `ap_mcq` with a `figure`: the figure renders above the question in the live form and in the answered card. Without one both are unchanged.
- The score card renders from `ap_record_gen` exactly as from `ap_record_frq`. `ap_frq_gen` and `ap_view_figure` stay out of the artifact registry.

- [ ] **Step 1: Write the failing tests**: the generated form shows title, stem, each part's prompt and box, `AP · generated`, and the figure image URL; its HTML contains none of the committed answers or rubric points (Review Focus 3); the answered card likewise; the pure request builder gives `frq.questionId` `gen-<toolCallId>`; `ap_mcq` with a figure shows it and without one is byte-for-byte unchanged; the registry maps `ap_record_gen` and omits `ap_frq_gen` and `ap_view_figure`; the two activity labels.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, following the `ap_frq` branches.
- [ ] **Step 4: Run to verify pass**, plus the dock and answered-card render tests (`grep -rln "question-dock\|answered-card" tests`); `tsc --noEmit`; `eslint`.
- [ ] **Step 5: Commit** — `feat(ap): screens for generated free-response questions and figures`

### Task 7: Sitting chooser, docs, full suite, hand-check

**Files:**
- Modify: `components/ap/start-sitting.tsx` (Free-response and Mixed always startable; the `needs released papers` note and its `indexedQuestions` gate removed), `tests/ap-course-ui.test.tsx`, `docs/ap-prep.md`, `docs/architecture.md`

- [ ] **Step 1: Write the failing test**: with zero indexed questions `Free-response` and `Mixed` start `{ kind: "frq" }` / `{ kind: "mixed" }` sittings and no note is shown. Run it; see it fail; implement; see it pass.
- [ ] **Step 2: Update the docs**: generated free-response questions (labelled `AP · generated`, rubric committed before posing, same scoring and score card); released first, then generated; the short generated retry after lost points; figures (drawn in the background, appear in the chat, checked by the tutor before use, governed by the drawings switch in Settings, need a model that can see images); architecture notes for the generated question travelling in the tool call, `ap_record_gen`, the figure route and the viewed-before-use rule. Quote on-screen labels exactly. No personal names or machine paths.
- [ ] **Step 3: Run the whole suite** — `NODE_ENV=test ./node_modules/.bin/tsx --test --test-concurrency=3 tests/*.test.ts tests/*.test.tsx`, output to a file; compare the failing set by name with the pre-branch baseline. Expected: the 20 known platform failures and nothing else.
- [ ] **Step 4:** `tsc --noEmit` and `eslint .` — no new errors.
- [ ] **Step 5: Commit** — `feat(ap): free-response sittings without released papers; docs`
- [ ] **Step 6: Hand-check with the owner on the running app** (not markable from tests): start a free-response sitting on a topic with no released question and confirm the tutor writes one, labelled `AP · generated`, with no answer or rubric visible; answer it and check the score card and statuses; lose points and confirm the retry is a short generated free-response question; ask for a topic that needs a graph and confirm the figure appears, the tutor checks it, and the question shows it; turn the drawings switch off and confirm questions come without figures.
