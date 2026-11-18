# Study Boxes and Graph Grouping: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Tests and AP sessions move out of the sidebar and into their test or course "boxes" (the `/tests` and `/ap` pages and their detail pages).
- The knowledge graph groups linked sessions into one region per test or course.

**Architecture:** One small pure module, `src/core/study-sessions.ts`, decides two things: whether a chat is a study session, and which group it belongs to. Three consumers use it:
- the sidebar, which hides study sessions unless you are searching;
- the server-rendered detail pages, which list a box's sessions;
- the graph's birth-session partition, which maps each birth chat to its group.

**Tech Stack:** Next.js 16 App Router (server pages with `force-dynamic`), React, TypeScript, and `node:test` with `renderToStaticMarkup`.

**Spec:** `docs/superpowers/specs/2026-11-17-study-boxes-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before touching pages or routes (AGENTS.md).
- Keep the internal names (`LH_*`, `learnharness`, the `lh:`/`lh-` keys) and the data layout under `data/`.
- Windows tests run in Git Bash.
  - Single file: `NODE_ENV=test ./node_modules/.bin/tsx --test tests/<file>`.
  - Full suite: `NODE_ENV=test ./node_modules/.bin/tsx --test --test-concurrency=3 --test-force-exit tests/*.test.ts tests/*.test.tsx`.
  - The base has 23 known failures. No new failure names are allowed.
  - Also run `npx tsc --noEmit` and `npx eslint .` (0 errors).
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No personal email goes into any file.
- **Study session:** `kind === "testprep"`, or `kind === "ap"`, or `apCourseId !== undefined`.
- **Study group key:**
  - `"test:<testId>"` for testprep chats with a `testId`;
  - `"course:<apCourseId>"` for chats with an `apCourseId`;
  - otherwise `null`.
- Graph region labels are the test or course title. The fallbacks are `"Untitled test"` and `"Untitled course"`.
- Sidebar search still finds study sessions by title.

## Review Focus

1. **A study chat whose test or course was deleted.** Its sessions still appear in graph regions, labelled "Untitled test" or "Untitled course". It never crashes, and the detail page for a missing id is still a 404. (Task 4 test.)
2. **Search while the kind filter is "Teaching".** A matching AP or Tests session still shows. Study sessions show whenever there is a query, whatever the filter. (Task 2 test.)
3. **A course with zero sessions.** The detail page shows "No sessions yet." plus the New button. (Task 3 test.)
4. **Graph regions that used to be keyed by chat id.** Every UI consumer of `clusters[].id` that treated it as a chat id (links, the session panel) still works for `test:`/`course:` ids. (Task 4 test.)
5. **A testprep chat with no `testId`.** It stays its own region, under its chat id. (Task 1/4 test.)

---

### Task 1: Study-session helpers

**Files:**
- Create: `src/core/study-sessions.ts`
- Modify: `src/core/index.ts` (re-export)
- Test: `tests/study-sessions.test.ts`

**Interfaces (produced):**

```ts
type StudyFields = Pick<ChatSummary, "kind" | "testId" | "apCourseId">;
export function isStudySession(chat: StudyFields): boolean;
export function studyGroupKey(chat: StudyFields): string | null; // "test:<id>" | "course:<id>" | null
export function sessionsForTest<T extends StudyFields>(chats: readonly T[], testId: string): T[];
export function sessionsForCourse<T extends StudyFields>(chats: readonly T[], courseId: string): T[];
```

`sessionsForTest` and `sessionsForCourse` keep the input order. `listChats()` is already newest-first.

- [ ] **Step 1: Write the tests.**
  - `isStudySession`:
    - testprep → true; ap → true;
    - teach with `apCourseId` → true;
    - teach, practice, or `kind` undefined → false.
  - `studyGroupKey`:
    - testprep `t1` → `"test:t1"`;
    - testprep without `testId` → null;
    - ap `c1` → `"course:c1"`;
    - teach with `apCourseId` `c1` → `"course:c1"`;
    - teach → null.
  - `sessionsForTest` and `sessionsForCourse`:
    - they pick exactly the matching chats, including the linked teach Learn chat for a course;
    - they keep the input order;
    - they exclude other ids.
- [ ] **Step 2: Run.** The tests should FAIL because the module is missing.
- [ ] **Step 3: Implement.** Write the module and add `export * from "./study-sessions.ts"` in `src/core/index.ts`.
- [ ] **Step 4: Run.** The tests should PASS, and `npx tsc --noEmit` should be clean.
- [ ] **Step 5: Commit.** Message: `feat(core): study-session helpers`.

### Task 2: Sidebar: back to page links, folders removed

**Files:**
- Modify: `components/sidebar.tsx`. The parts to change are:
  - the imports (lines 20-21);
  - the folder state and effects (505-536, 597-622);
  - `newTestSession` (549-567);
  - the memo (575-589);
  - the walk and keyboard (926-953);
  - the list block (989-1021);
  - `SessionDoorLinks` (410-465) and its call site (895-900).
- Delete: `components/session-folders.tsx`, `src/core/session-folders.ts`, `tests/render-session-folders.test.tsx`, `tests/session-folders.test.ts`, `tests/chat-folder-names.test.ts`.
- Modify: `src/core/index.ts` (drop the session-folders export) and `app/api/chats/route.ts` (drop `folderNames` from GET and its imports).
- Test: `tests/render-sidebar.test.tsx`, and a new `tests/sidebar-sessions.test.ts`.

**Interfaces:**
- Consumes `isStudySession` from Task 1.
- Produces, in `src/core/study-sessions.ts` (append):

  ```ts
  export function sidebarSessions<T extends StudyFields & { title: string }>(chats: readonly T[], opts: { query: string; kindFilter: "teach" | "practice" | "all" }): T[]
  ```

  The rules:
  - **No query:** drop study sessions, then apply the kind filter as today (`(c.kind ?? "teach") === kindFilter`, unless the filter is `"all"`).
  - **Query:** apply the kind filter only to non-study chats. Study chats always pass. Then run the existing `fuzzyScore(query, title)` filter and sort, the same as today.
- `SessionDoorLinks` props become `{ onNewTeaching, onNewPractice }` again.
  - Tests and AP render as `<Link href="/tests" data-testid="tests-link">` and `<Link href="/ap" data-testid="ap-link">`, with the same `DOOR_CLASS` styling.
  - Keep the labels "Tests" and "AP".

- [ ] **Step 1: Write the tests.**
  - `tests/sidebar-sessions.test.ts`:
    - With no query, study chats are hidden and the kind filter applies.
    - With a query, an AP chat matching the query shows even when the filter is `"teach"`.
    - With a query, a practice chat is still hidden when the filter is `"teach"`.
    - Fuzzy order is kept: the best match comes first.
  - `tests/render-sidebar.test.tsx`: the doors suite asserts the test ids `new-session`, `new-session-practice`, `tests-link`, `ap-link`. `tests-link` has `href="/tests"` and `ap-link` has `href="/ap"`. There is no `new-session-tests` or `new-session-ap`.
- [ ] **Step 2: Run.** The tests should FAIL.
- [ ] **Step 3: Implement.**
  - Rendering:
    - The list is `sidebarSessions(chats, { query, kindFilter })`.
    - ↑/↓/Enter walk that list. Restore the simple index-into-shown behaviour.
    - Keep the scroll-into-view on `session-row-kbd`.
    - Keep `renderRow` (rename and context menu) as is.
  - Empty states:
    - Not searching and the list is empty → "No sessions yet.".
    - Searching and the list is empty → "No sessions match.".
  - Remove everything to do with folders: the state, the localStorage key use, the auto-open effect, `newTestSession` and the imports.
  - Fix the stale "Two doors, STACKED" comment.
  - Delete the listed files.
  - Remove `folderNames` from the GET route. `chats` keeps its exact shape.
- [ ] **Step 4: Run.** Run the two test files, `tests/keyboard-toggle-sidebar.test.ts`, `tests/chat-flow.test.ts` and `tests/ap-api.test.ts`. Then run tsc and eslint, and the full suite once.
- [ ] **Step 5: Commit.** Message: `feat(sidebar): Tests/AP open their pages; study sessions live in their boxes`.

### Task 3: Box pages: New buttons and a Sessions list

**Files:**
- Create: `components/study-session-list.tsx`.
- Modify:
  - `app/tests/page.tsx` and `app/ap/page.tsx`: add the top **+ New** button.
  - `app/tests/[id]/page.tsx` and `app/ap/[id]/page.tsx`: load the sessions server-side.
  - `components/test-prep/readiness-view.tsx` (`ReadinessView` and `ReadinessPage` props) and `components/ap/course-view.tsx` (`CourseView` and `CoursePage` props): render the list.
- Test: a new `tests/render-study-session-list.test.tsx`; extend `tests/ap-course-ui.test.tsx` and the existing readiness render test, if one exists (search `tests/` for `ReadinessView`).

**Interfaces:**
- Consumes `sessionsForTest` and `sessionsForCourse` (Task 1), plus `listChats` from `@/src/server`.
- Produces:

  ```ts
  export function StudySessionList(props: {
    sessions: ReadonlyArray<Pick<ChatSummary, "id" | "title" | "updatedAt">>;
    newSession: { label: string; onClick: () => void; disabled?: boolean; testId: string };
  }): JSX.Element
  ```

  - The heading is "Sessions" (`data-testid="study-sessions"`).
  - Each row is `<Link href="/chat/<id>" data-testid="study-session-<id>">`, showing the title and a relative age. Reuse `timeAgo` from `components/sidebar.tsx` if it is exported; otherwise export it.
  - The empty state is "No sessions yet.".
  - The button carries the given `testId`.
- `ReadinessView` and `ReadinessPage` gain `sessions: ChatSummary[]`. The detail page passes `sessionsForTest(listChats(), id)`.
  - The New button (`testId: "new-test-session"`, label "New session") calls the existing `start()` / `continueSession` path. The existing "Continue where I left off" button stays.
- `CourseView` and `CoursePage` gain `sessions: ChatSummary[]`, from `sessionsForCourse(listChats(), id)`.
  - The New button (`testId: "new-course-session"`, label "New session") scrolls to `[data-testid="course-units"]` with `scrollIntoView({ behavior: "smooth", block: "start" })`.
  - When there is no `course-units` element (the plan isn't confirmed), it scrolls to the plan editor instead, or it is disabled.
- List pages:
  - `/tests` gets `<Link href="/chat/new?mode=testprep" data-testid="new-test">+ New test</Link>` in the header.
  - `/ap` gets `<Link href="/chat/new?mode=ap" data-testid="new-course">+ New course</Link>` in the header.
  - Both are shown always. The empty-state link can stay.
- Placement: put the Sessions block below the readiness or units content, and above the documents section on AP.

- [ ] **Step 1: Write the tests.**
  - `StudySessionList`:
    - It renders the rows with the right hrefs, in the given order.
    - It shows "No sessions yet." when empty.
    - The button has the given test id and label.
  - The course render, via the existing CourseView test setup, includes `study-sessions` with the passed sessions and a `new-course-session` button.
  - The readiness render includes `new-test-session`.
  - The list pages: if the page components can be rendered in tests, assert the `new-test`/`new-course` hrefs. Otherwise extract the header into a small exported component and test that.
- [ ] **Step 2: Run.** The tests should FAIL.
- [ ] **Step 3: Implement.** Use the existing card and row classes and no new colours.
- [ ] **Step 4: Run.** Run the new and changed test files, `tests/ap-course-ui.test.tsx`, `tests/ap-routes.test.ts`, tsc, eslint, and the full suite once.
- [ ] **Step 5: Commit.** Message: `feat(boxes): sessions list and New buttons on test and course pages`.

### Task 4: Graph regions grouped by test or course

**Files:**
- Modify:
  - `src/core/session-clusters.ts`: add an optional `groupOf` to the partition and to the imp attachment.
  - `src/core/graph.ts`: add `GraphDeps.studyTitles?`; use the group key at about lines 566-584 for the clusters and the label join.
  - `src/core/layout-settle.ts`: add an optional `groupOf` param.
  - Its server caller(s): grep `settleGraphLayout(`.
  - `src/server/graph.ts`: pass `studyTitles` built from `stores.testStore.list()` and `stores.apCourseStore.list()`; drop the unused `birthSessionPartition` import.
  - Any UI consumer that treats `clusters[].id` as a chat id: grep `components/graph-view.tsx`, `components/graph-canvas.ts` and the session panel for cluster id → `/chat/` links.
- Test: `tests/session-clusters.test.ts` and `tests/graph.test.ts`.

**Interfaces:**
- Consumes `studyGroupKey` (Task 1).
- Change `birthSessionPartition(nodes, groupOf?: (birthId: string) => string)`. The default is the identity. A cluster's `id` is `groupOf(birth)`.
- Change `attachImpToCommunities(communities, propositions, chains, groupOf?)`. `impClusterKey`'s birth lookup maps through `groupOf`, so implication nodes join the grouped community.
- `GraphDeps.studyTitles?: { tests: Readonly<Record<string, string>>; courses: Readonly<Record<string, string>> }`.
- In `graphSnapshot`:
  - Build `groupOf(chatId)` from `deps.chatStore.getChat(chatId)` and `studyGroupKey(chat) ?? chatId`, memoised per call. Notes source ids (`src_…`) and missing chats map to themselves.
  - Label for `test:<id>`: `studyTitles.tests[id] ?? "Untitled test"`. Label for `course:<id>`: `studyTitles.courses[id] ?? "Untitled course"`. Otherwise use the existing label logic.
  - `MIN_CLUSTER_SIZE` applies to the grouped community.
  - `graphSessionIndex` and `graphSessionPropositions` stay per session, so they are unchanged.
- `settleGraphLayout(graphStore, groupOf?)` passes `groupOf` to both calls. Its server caller builds `groupOf` the same way, from `stores.chatStore`. Extract one helper, `studyGroupOf(chatStore): (birthId) => string`, in `src/core/graph.ts` or `study-sessions.ts`, so the snapshot and the settle share it.

- [ ] **Step 1: Write the tests.**
  - `session-clusters`:
    - A partition with a `groupOf` that maps `chatA` and `chatB` → `"test:t1"` yields one community with all their members.
    - With no `groupOf`, the output is unchanged.
    - Imp attachment with `groupOf`: a chain whose premises were born in `chatA` and `chatB` joins `"test:t1"`.
  - `graphSnapshot`, using the existing `tests/graph.test.ts` or `tests/session-clusters.test.ts` setup:
    - Two testprep chats with the same `testId` and 2 propositions each → one cluster `id: "test:<id>"`, labelled with the `studyTitles` title. This also proves the 3+ hull rule applies after grouping.
    - An unknown title gives "Untitled test".
    - A teach chat stays its own cluster, labelled with its chat title.
    - A testprep chat without a `testId` stays under its chat id.
  - Every existing cluster test still passes unchanged.
- [ ] **Step 2: Run.** The new tests should FAIL.
- [ ] **Step 3: Implement.**
  - Do the grep for cluster-id consumers. If any one builds `/chat/<cluster.id>`, change it as follows:
    - `test:` ids link to `/tests/<id>`;
    - `course:` ids link to `/ap/<id>`;
    - anything else keeps today's link.
  - Add a test for that mapping as a small pure function.
- [ ] **Step 4: Run.** Run `tests/session-clusters.test.ts`, `tests/graph.test.ts`, `tests/layout.test.ts`, `tests/clusters.test.ts`, tsc, eslint, and the full suite once.
- [ ] **Step 5: Commit.** Message: `feat(graph): one region per test or course`.
