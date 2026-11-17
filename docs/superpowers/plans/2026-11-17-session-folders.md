# Session Folders, AP Learn Linking, Graph Intake, Light Default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** This plan makes six changes:
- The sidebar's Tests and AP buttons start new sessions.
- Tests and AP sessions are grouped into per-test and per-course folders.
- AP Learn sessions are linked to their course, and graded checks in them count toward course progress.
- Study sessions feed the knowledge graph after about 1k new tokens.
- Light mode becomes the default.

**Architecture:**
- **Folder grouping** is a pure function in `src/core/session-folders.ts`. It takes the existing `/api/chats` list plus a name map, and the `GET /api/chats` response is extended to carry that map. A new `components/session-folders.tsx` renders the result inside the existing sidebar.
- **Linked Learn sessions** stay `teach` chats. They gain `apCourseId` plus a new `apLearn` scope. The teacher agent gets a scoped `ap_record_result` tool and a short appended instruction, but only when the chat is linked.
- **The extraction trigger threshold** comes from a pure helper.

**Tech Stack:**
- Next.js 16 App Router and React.
- TypeScript run through tsx.
- `node:test` with `renderToStaticMarkup` for tests.
- TypeBox schemas for the agent tools.

**Spec:** `docs/superpowers/specs/2026-11-17-session-folders-design.md`

## Global Constraints

- **Next.js docs:** read the relevant guide in `node_modules/next/dist/docs/` before touching routes or rendering (AGENTS.md).
- **Internal names stay:** keep `LH_*`, `learnharness`, the `lh:`/`lh-` storage keys and the data layout under `data/`.
- **Testing on Windows:**
  - Run the tests in Git Bash: `NODE_ENV=test ./node_modules/.bin/tsx --test --test-concurrency=3 --test-force-exit tests/*.test.ts tests/*.test.tsx`.
  - For a single file: `NODE_ENV=test ./node_modules/.bin/tsx --test tests/<file>`.
  - The baseline has 20 known failing test names, and no new names may fail.
  - `tests/chatgpt-connection-ui.test.tsx` may crash during teardown with a libuv UV_HANDLE_CLOSING error. That is known.
- **Commits:**
  - Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never write the owner's personal email into any file.
- **Study extraction trigger:** `STUDY_EXTRACTION_TRIGGER_TOKENS = 1024`. It applies to chats with `kind` `testprep` or `ap`, or with any `apCourseId`. It changes only when extraction starts. Batch sizing keeps `graph.extractionChunkTokens`.
- **Practice sessions** stay excluded from extraction.
- **What counts as progress:** only answers the tutor grades move progress. Reading a lesson never records a result.
- **Folder rules:**
  - Folders sit under the Tests and AP sections. A Tests folder is keyed by `testId`, and an AP folder by `apCourseId`.
  - A section without a linked test or course gets an "Unfiled" folder. No session ever disappears.
  - Folders are ordered by their newest session, and sessions inside a folder are newest first.
  - Sections start open, and folders start closed. The folder holding the current session opens automatically.
  - Open state is kept in localStorage under `lh:session-folders-open`, with every read and write wrapped in try/catch.
  - Search covers every session. It opens folders that match and hides folders that don't.
  - The Teaching/Practice/All filter applies to the flat list only.
  - ↑/↓ walks only the visible session rows, top to bottom: open folders first, then the flat list.

## Review Focus

1. **A chat whose `testId` or `apCourseId` points at a deleted test or course** still appears in a folder, with the fallback name "Untitled test" or "Untitled course". It is never dropped. (Task 5 test.)
2. **A Learn request with a bad link is rejected cleanly:** a course whose plan isn't confirmed, or a topic or unit not in the course. The tutor tool refuses a `topicId` outside its scope. (Tests in Tasks 3 and 4.)
3. **Corrupt or throwing localStorage** for the folder state falls back to the defaults and never breaks the sidebar. (Task 6 test.)
4. **A search that matches only sessions inside folders** opens those folders and puts them in the ↑/↓ walk. A search with no match anywhere shows the existing empty state. (Task 5 test.)
5. **A user setting `extractionChunkTokens` below 1024** is still honoured for study chats: the trigger is the smaller of the two. (Task 2 test.)

---

### Task 1: Light mode default

**Files:**
- Modify: `src/core/settings.ts:526` (`FACTORY_SETTINGS.appearance.mode`)
- Modify: `app/layout.tsx:24` (the html `className`)
- Modify: `components/settings/theme-boot.ts`
- Test: `tests/settings.test.ts`, `tests/light-mode.test.tsx`

**Interfaces:** Produces nothing that later tasks consume.

- [ ] **Step 1: Update the failing tests.**
  - In `tests/settings.test.ts`, change the pin to `assert.equal(FACTORY_SETTINGS.appearance.mode, "light")`.
  - In `tests/light-mode.test.tsx`, add `it("boot script switches to dark only when the stored preference is dark")`. It evaluates `THEME_BOOT_SCRIPT` with `new Function` against a fake `localStorage` and `document.documentElement.classList`:
    - stored `"dark"` → the class list has `dark` and not `light`;
    - stored `"light"`, `null`, or a throwing `getItem` → it has `light` and not `dark`.
  - Start each case with the classes `["light"]`.
- [ ] **Step 2: Run both files.** The new assertions should fail.
- [ ] **Step 3: Implement.**
  - Factory `mode: "light"`.
  - Layout `className={`light ${nunito.variable}`}`.
  - The boot script removes `light` and adds `dark` when the stored value is exactly `"dark"`. Everything stays inside the existing `try{…}catch(e){}`.
  - Update the file's doc comment so it matches the new behaviour.
- [ ] **Step 4: Rerun.** Both files should pass, along with `tests/brand-theme.test.ts` and `tests/render-settings.test.tsx`.
- [ ] **Step 5: Commit** `feat(theme): light mode is the default`.

### Task 2: Study-chat extraction trigger

**Files:**
- Create: `src/core/extraction-trigger.ts`
- Modify: `src/server/chat-handler.ts:744-755` (pass the computed threshold)
- Test: `tests/extraction-trigger.test.ts`

**Interfaces:**
- Produces: `export const STUDY_EXTRACTION_TRIGGER_TOKENS = 1024;`
- Produces: `export function extractionTriggerTokens(record: Pick<ChatRecord, "kind" | "apCourseId">, configured: number): number`

- [ ] **Step 1: Write the test.** `extractionTriggerTokens(record, configured)` should return:

  | `record` | `configured` | Result |
  |---|---|---|
  | `{kind:"testprep"}` | 4096 | 1024 |
  | `{kind:"ap", apCourseId:"c1"}` | 4096 | 1024 |
  | `{kind:undefined, apCourseId:"c1"}` (linked Learn) | 4096 | 1024 |
  | `{kind:"teach"}` | 4096 | 4096 |
  | `{kind:undefined}` | 4096 | 4096 |
  | `{kind:"testprep"}` | 600 | 600 (the smaller wins) |
- [ ] **Step 2: Run it.** It should fail because the module is missing.
- [ ] **Step 3: Implement the helper.**
  - Study chats get `Math.min(configured, STUDY_EXTRACTION_TRIGGER_TOKENS)`; everything else gets `configured`.
  - At the call site, replace `effective.graph.extractionChunkTokens` in the `triggerExtraction(...)` call with `extractionTriggerTokens(record, effective.graph.extractionChunkTokens)`.
  - Leave the `practice` guard and the pipeline's batch sizing untouched.
- [ ] **Step 4: Run** the test, plus `tests/extraction.test.ts` and `tests/coverage.test.ts`. All should pass.
- [ ] **Step 5: Commit** `feat(graph): study sessions extract after ~1k new tokens`.

### Task 3: Linked Learn sessions — contract, route, course page

**Files:**
- Modify: `src/core/ap.ts` (new type and parser next to `ApSittingScope`, around line 29)
- Modify: `src/core/contracts/chat.ts` (`ChatRecord` around line 51 and `ChatSummary` around line 286: add `apLearn?: ApLearnScope`)
- Modify: `src/store/chats.ts:38-69` (`createChat` persistence)
- Modify: `app/api/chats/route.ts:27-95` (POST validation)
- Modify: `components/start-session.ts:4-17` (`SessionCreation.apLearn?`)
- Modify: `components/ap/course-view.tsx:229-243, 352-417` (`learn()` and both Learn buttons)
- Test: `tests/ap-api.test.ts`, `tests/chat-kind.test.ts`, `tests/ap-course-ui.test.tsx`

**Interfaces:**
- Produces `export type ApLearnScope = { type: "topic"; topicId: string } | { type: "unit"; unitId: string };` in `src/core/ap.ts`.
- Produces `export function parseApLearnScope(value: unknown): ApLearnScope | null`.
- Produces `ChatRecord.apLearn?: ApLearnScope` and `ChatSummary.apLearn?: ApLearnScope`.
- A linked Learn chat is `kind` absent (teach) with both `apCourseId` and `apLearn` set.
- `createChat`'s `ap` argument widens to `{ courseId: string; sitting?: ApSitting; learn?: ApLearnScope }`. It persists `apCourseId` + `apLearn` when `kind` is undefined and `ap.learn` is set. The existing `kind === "ap"` branch is unchanged.
- POST body: `{ title, apCourseId, apLearn }` with no `kind`.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/ap-api.test.ts`.** Seed a course with a confirmed plan (unit `u1`, topic `t1`), using the existing helpers in that file.
    - `it("creates a linked Learn chat for a topic")`: POST `{title:"Teach me", apCourseId, apLearn:{type:"topic",topicId:"t1"}}`. Expect 201 or the same success status the file already asserts. The stored record has no `kind`, has `apCourseId` and `apLearn` deep-equal to the input, and has no `apSitting`.
    - The same for `{type:"unit",unitId:"u1"}`.
    - These all get 400:
      - an `apLearn` topic not in the course;
      - `apLearn` with `kind:"ap"`;
      - `apLearn` with no `apCourseId`;
      - a malformed `apLearn` like `{type:"weak"}`;
      - a course whose plan is not confirmed.
    - An unknown `apCourseId` gets 404.
  - **`tests/chat-kind.test.ts`.** `createChat("t", undefined, undefined, {courseId:"c", learn:{type:"topic",topicId:"t1"}})` persists `apCourseId` and `apLearn`. `listChats()` carries both.
  - **`tests/ap-course-ui.test.tsx`.** Assert that the Learn handlers pass `apCourseId` and `apLearn`. Test this the way the file already tests button wiring; if it only renders markup, export a pure `learnCreation(courseId, scope, title): SessionCreation` from `course-view.tsx` and assert on its output for a topic and a unit.
- [ ] **Step 2: Run the three files.** The new cases should fail.
- [ ] **Step 3: Implement.**
  - `parseApLearnScope` accepts only the two shapes, with non-empty string ids.
  - **Route:**
    - When `apLearn` is present, require `kind` to be absent and `apCourseId` to be present.
    - The course must exist (else 404) and have `planConfirmed` (else 400).
    - Check scope with the existing `sittingScopeProblem(course, scope)`, which accepts topic and unit scopes (else 400).
    - Then call `createChat(title, undefined, undefined, { courseId, learn })`.
    - Don't change any existing branch's behaviour.
  - **`learn()` in `course-view.tsx`:**
    - It takes a `scope: ApLearnScope`.
    - It calls `starter.start({ title, apCourseId: course.id, apLearn: scope }, fetch)`.
    - The unit button passes `{type:"unit",unitId:section.id}`; the topic button passes `{type:"topic",topicId:point.id}`.
    - The `learnPrompt` text is unchanged.
- [ ] **Step 4: Rerun** those three files, plus `tests/chat-flow.test.ts` and `tests/chat-birth-stamp.test.ts`. All should pass.
- [ ] **Step 5: Commit** `feat(ap): Learn sessions link to their course and scope`.

### Task 4: Tutor grading in linked Learn sessions, and deletion cleanup

**Files:**
- Create: `src/agent/tools/ap-learn.ts`
- Modify: `src/agent/tools.ts:410-499` (`TeacherToolContext.apLearn?`; spread the tool into `createTeacherTools`)
- Modify: `src/agent/teacher-agent.ts` (`AgentBuildOptions.appendInstructions?: string[]`, appended in `baseAgentOptions` next to the existing runtime append around line 197)
- Modify: `src/server/chat-handler.ts:628-640` (teach branch: build the context and the appended instruction when `record.apCourseId && record.apLearn`)
- Modify: `src/server/chats.ts:160` (the cleanup condition)
- Test: `tests/ap-learn-tools.test.ts` (new), `tests/ap-session-delete.test.ts`

**Interfaces:**
- Consumes `ApLearnScope` from Task 3, plus `topicInScope` and `locateTopic` from `src/core/ap.ts`.
- Consumes `ApCourseStorePort` from `src/agent/tools/ap.ts:75-80`.
- Produces `export interface ApLearnToolContext { chatId: string; courseId: string; scope: ApLearnScope; courses: Pick<ApCourseStorePort, "get" | "recordResult"> }`.
- Produces `export function apLearnTools(ctx: ApLearnToolContext): { ap_record_result: AgentTool<...> }`.
  - The tool keeps the same name and input schema as the AP sitting tool: reuse `apRecordResultInputObject` (export it from `ap.ts` if needed).
- Produces `export function apLearnInstruction(courseTitle: string, topics: Array<{ id: string; text: string }>): string`. The topics are the in-scope topics.

- [ ] **Step 1: Write the failing tests** in `tests/ap-learn-tools.test.ts`. Use an in-memory fake `courses` port with a recording `recordResult`.
  - `in-scope topic → recordResult called with (courseId, topicId, result, chatId)`.
  - `unit scope accepts any topic in that unit, refuses a topic in another unit` (an invalid-input result; `recordResult` is not called).
  - `refuses unknown topic`.
  - `refuses when the course plan is not confirmed`.
  - `refuses when the course is missing`.
  - `apLearnInstruction lists each topic as "<id> — <text>" and names ap_record_result`.
  - The tool survives `createTeacherTools(ctx, toggles)` when `ctx.apLearn` is set, and is absent when it isn't. Call `createTeacherTools` with the default toggles.
  - **In `tests/ap-session-delete.test.ts`:** deleting a teach chat that has `apCourseId` and `apLearn` calls `forgetChat(courseId, chatId)`, the same way it does for `kind:"ap"`. Deleting a plain teach chat doesn't.
- [ ] **Step 2: Run both files.** They should fail.
- [ ] **Step 3: Implement.**
  - **Gates:** mirror `listingGateProblems` and `topicGateProblems`, minus the sitting requirement, using `topicInScope(course, ctx.scope, topicId)`. Return them through the same `invalidInputResult` helper.
  - **Tool toggles:** if `filterEnabledTools` would drop an unknown tool name, exempt `ap_record_result` the same way the other always-on tools are exempted.
  - **Instruction copy (exact):**

    ```
    This session is linked to an AP course. When you grade the learner's answer to a check question (a quiz item or an explain-it-back), call ap_record_result with the topicId of the topic that check tested and the result: correct, wrong, or dontKnow. Record only answers you actually graded; never record anything for reading or explanation alone.
    Topics in this session:
    <one line per topic: "- <id> — <text>">
    ```

  - **In the handler:** load the course from `stores.apCourseStore.get`. Collect the in-scope topics (one topic, or all topics in the unit). Pass `apLearn` into the teacher ctx and `appendInstructions: [apLearnInstruction(...)]` into the agent options. If the course is missing, skip both silently.
  - **Cleanup condition:** `if (record?.apCourseId)`.
- [ ] **Step 4: Run** both files, plus `tests/ap-tools.test.ts` and `tests/chat-flow.test.ts`. All should pass.
- [ ] **Step 5: Commit** `feat(ap): tutor records graded checks in linked Learn sessions`.

### Task 5: Folder grouping logic and folder names in `/api/chats`

**Files:**
- Create: `src/core/session-folders.ts`
- Modify: `app/api/chats/route.ts:13-24` (the GET response adds `folderNames`)
- Test: `tests/session-folders.test.ts` (new); extend the GET test in `tests/ap-api.test.ts` or `tests/chat-kind.test.ts`

**Interfaces (produced, consumed by Task 6):**

```ts
export type FolderSection = "tests" | "ap";
export interface FolderNames { tests: Record<string, string>; ap: Record<string, string> }
export interface SessionFolder {
  key: string;            // "tests:<id>" | "ap:<id>" | "tests:unfiled" | "ap:unfiled"
  section: FolderSection;
  id: string | null;      // null = Unfiled
  name: string;           // record title | "Untitled test" | "Untitled course" | "Unfiled"
  sessions: ChatListItem[];
}
export interface SessionTree { tests: SessionFolder[]; ap: SessionFolder[]; flat: ChatListItem[] }
export function groupSessions(chats: ChatListItem[], names: FolderNames): SessionTree;
export function openFolderKeys(tree: SessionTree, stored: ReadonlySet<string>, opts: { searching: boolean; currentChatId: string | null }): Set<string>;
export function walkOrder(tree: SessionTree, open: ReadonlySet<string>): ChatListItem[];
export function parseOpenKeys(raw: string | null): Set<string>;
```

- The `GET /api/chats` response becomes `{ chats, folderNames: FolderNames }`, built from `stores.testStore.list()` and `stores.apCourseStore.list()` (id → title).

- [ ] **Step 1: Write the failing tests** in `tests/session-folders.test.ts`. Pass `chats` in newest-first order.
  - `kind "testprep" groups by testId; kind "ap" and any chat with apCourseId (incl. teach Learn) group by apCourseId; others go to flat in input order`.
  - `missing testId/apCourseId → "<section>:unfiled" folder named "Unfiled", placed last in its section`.
  - `id absent from names → name "Untitled test" / "Untitled course", folder kept`.
  - `folders ordered by their first (newest) session; sessions keep input order`.
  - `openFolderKeys: stored keys kept; folder containing currentChatId added; when searching, every folder in the tree is open`.
  - `walkOrder: sessions of open folders (tests section then ap, folder order) followed by flat; closed folders skipped; when "collapsed:tests" or "collapsed:ap" is in the set, that whole section is skipped`.
  - `parseOpenKeys: null, "not json", "{}" and a non-string array → empty set; '["ap:c1"]' → {"ap:c1"}`.
  - **Route test:** GET `/api/chats` returns `folderNames.tests[testId] === test title` and `folderNames.ap[courseId] === course title`.
- [ ] **Step 2: Run.** The tests should fail.
- [ ] **Step 3: Implement.**
  - Write the pure functions, with no React and no I/O.
  - In the route, add `folderNames` next to the existing `chats` mapping.
  - `chats` keeps its exact current shape.
- [ ] **Step 4: Run** the new file, the route test file and `tests/chat-flow.test.ts`. All should pass.
- [ ] **Step 5: Commit** `feat(sidebar): session folder grouping and folder names`.

### Task 6: Sidebar UI — Tests/AP buttons start sessions, folder tree, keyboard walk

**Files:**
- Create: `components/session-folders.tsx`
- Modify: `components/sidebar.tsx`. The areas to change:
  - `SessionDoorLinks` at 408-461;
  - the fetch at 530-546;
  - the filter memo at 514-527;
  - the keyboard handler at 800-827;
  - the list render at 863-894.
- Test: `tests/render-sidebar.test.tsx`, `tests/render-session-folders.test.tsx` (new)

**Interfaces:**
- Consumes everything Task 5 produces.
- Consumes `SessionRow` from `sidebar.tsx`; export it if it isn't exported already.
- Consumes `SessionStarter` from `components/start-session.ts`.
- `SessionDoorLinks` props become `{ onNewTeaching, onNewPractice, onNewTests, onNewAp }`.
  - Tests and AP render as buttons with `data-testid="new-session-tests"` and `"new-session-ap"`.
  - Their handlers push `/chat/new?mode=testprep` and `/chat/new?mode=ap`, the same way the Teaching and Practice handlers push.
- `SessionFolderTree` props: `{ tree: SessionTree; open: ReadonlySet<string>; onToggle(key: string): void; activeId: string | null; kbdId: string | null; onNewTestSession(testId: string): void }`.
  - The `/tests` and `/ap` section headings are links with `data-testid="folder-section-tests"` and `"folder-section-ap"`.
  - Each heading has its own chevron button to collapse the section. The button calls `onToggle("collapsed:tests")` or `onToggle("collapsed:ap")`.
  - Sections are open unless their `collapsed:*` key is in the open-state set, so they start open by default.
  - The same localStorage set holds these keys. `walkOrder` already skips the sessions of a collapsed section (Task 5).
  - Each folder row is a toggle button (`data-testid="folder-<key>"`) showing the name and session count.
  - **The + on a folder:**
    - On a Tests folder with an id, + is a button (`data-testid="folder-new-<key>"`) that calls `onNewTestSession(id)`.
    - On an AP folder with an id, + is a link to `/ap/<id>` with the same testid pattern.
    - Unfiled folders have no +.
  - Rows inside open folders reuse `SessionRow`.
- `onNewTestSession` in the sidebar calls `starter.start({ title: "Continue.", kind: "testprep", testId }, fetch)` and navigates, as in `components/test-prep/readiness-view.tsx:62-68`.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/render-sidebar.test.tsx`:** `SessionDoorLinks` renders `new-session-tests` and `new-session-ap` as `<button>`, and no longer renders `tests-link` or `ap-link`. Update the old assertions.
  - **`tests/render-session-folders.test.tsx`:**
    - Both section headings link to `/tests` and `/ap`.
    - A closed folder shows its name and count, with no session rows.
    - An open folder shows its session rows.
    - A Tests folder's + is a button.
    - An AP folder's + links to `/ap/c1`.
    - An Unfiled folder has no +.
    - An empty section, with no folders, still renders its heading.
- [ ] **Step 2: Run both files.** They should fail.
- [ ] **Step 3: Implement.**
  - **Fetch:** read `folderNames` from the existing `/api/chats` fetch, defaulting to empty maps.
  - **Search:** run the existing fuzzy search across all chats.
  - **Kind filter:** apply it only to `tree.flat`. Do this by grouping the searched list, then filtering `flat` by kind.
  - **Open state:** compute it with `openFolderKeys`. The stored set comes from `parseOpenKeys` of `localStorage["lh:session-folders-open"]`. Read and write inside try/catch, and write on every toggle.
  - **Keyboard walk:** the ↑/↓/Enter handler indexes into `walkOrder(tree, open)` instead of `shown`.
  - **List view:**
    - The flat list keeps its current heading and empty state.
    - The tree renders above the flat list.
    - The search empty state shows only when the walk and the flat list are both empty.
  - **Styling:** follow the existing sidebar row styles and the warm theme tokens. Don't introduce new colours.
- [ ] **Step 4: Run** both render files and `tests/keyboard-toggle-sidebar.test.ts`. Then run the full suite. Typecheck with `npx tsc --noEmit` and lint with `npx eslint .`, which should report 0 errors.
- [ ] **Step 5: Commit** `feat(sidebar): Tests/AP start sessions; folder tree for study sessions`.

---

## After merge (operational, owner-approved)

This runs only after the owner approves the merge.

1. Rebuild and restart the port-3000 app the usual way:
   - stop the task;
   - kill the `next start` process still holding :3000;
   - run `npm run build` (twice, because of the SecurityFatalError nudge);
   - start the task.
2. **Backfill.** Go through the `kind` `testprep`/`ap` chats in `data/chats/*.json`, which should be 8 at the time of writing. For each, POST `http://127.0.0.1:3000/api/graph/coverage/extract` with `{"chatId":"<id>"}` and the app's auth.
   - Run them one at a time.
   - On a 409, wait until that run finishes and retry.
   - Afterwards, confirm that `data/graph/coverage.jsonl` gained entries for those chat ids, and report the node counts.
