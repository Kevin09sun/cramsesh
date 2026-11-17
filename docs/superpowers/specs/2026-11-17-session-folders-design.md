# Session folders, AP Learn linking, graph intake, light default — design

Date: 2026-11-17. Size: project (four connected parts).

## Intent

The owner wants Cramsesh to be easier to use and better organised.

Problems today:
- Test-prep and AP sessions pile up in one flat sidebar list. One test already has 2 sessions and one AP course has 5.
- The sidebar's Tests and AP entries can't start a session.
- AP "Learn" sessions float free of their course.
- Study sessions add nothing to the home knowledge graph or to course progress.
- The app opens in dark mode by default.

## Goals

1. Clicking **Tests** or **AP** in the sidebar starts a new session, the same way Teaching and Practice do.
2. Test-prep and AP sessions are grouped into sidebar folders: Tests › test and AP › course.
3. AP **Learn** sessions are linked to their course and topic. They appear in that course's folder, and their graded check questions move the course progress bar.
4. Tests and AP sessions, including Learn, reliably add their concepts to the home knowledge graph. The 8 existing Tests/AP chats are pulled in once.
5. Light mode is the default.

## Non-goals and anti-goals

- **No merging of sessions.** Every session keeps its own history. The owner rejected "one session per topic".
- **No change to how Teaching and Practice sessions are listed.** They stay in a flat list, newest first.
- **Practice sessions stay out of the knowledge graph**, as designed today. The owner asked about Tests and AP sessions only.
- **Progress must stay honest.** Reading a lesson alone never marks a topic solid. Only graded answers count (owner).
- **No data migration of existing chat records.** Folder grouping is derived from fields that already exist on each chat. Old Learn sessions stay unlinked: they carry no record of their course, so there is nothing safe to infer.

## Approaches

**Organisation.** The owner picked A.
- **A. Folders in the sidebar (chosen).** Separate sittings stay separate.
- **B. One session per test or course.** Rejected: long chats get slower and cost more per turn, and separate sittings would blur together.

**Sidebar buttons.** The owner chose to make the Tests and AP buttons start sessions. The alternative was to keep them as links to the list pages and add a "+ New" button on each page.

**Learn tutor.** The owner chose the Teaching tutor plus AP grading. Rejected: the AP tutor in a "Learn" mode. Its checks match the exam, but it would change how Learn teaches.

**Learn credit.** The owner chose graded checks only. Rejected:
- a lighter "studied" mark for finishing a lesson;
- both the "studied" mark and graded checks.

**Graph timing.** The owner chose "every few turns". Rejected:
- extract after a ~10-minute quiet pause;
- extract only on leaving the session.

**Backfill.** The owner chose to backfill once. Rejected: new turns only.

## Design

### 1. Sidebar buttons (owner)

- **Tests** goes to `/chat/new?mode=testprep`. **AP** goes to `/chat/new?mode=ap`.
- Both use the existing draft flow: no record is created until the first message is sent.
- To reach the `/tests` and `/ap` list pages, click the matching folder-section heading.

### 2. Folders (owner: approach A)

```
[Teaching] [Practice] [Tests] [AP]
search…   filter: Teaching | Practice | All
▾ Tests                 ← heading links to /tests
   ▸ Calc midterm (2)  +
▾ AP                    ← heading links to /ap
   ▸ AP Bio (5)        +
── recent ──
   teaching/practice sessions, flat, newest first
```

Grouping:
- A session goes in a Tests folder when `kind: "testprep"`, keyed by `testId`.
- A session goes in an AP folder when it has an `apCourseId`. That covers sittings, find-papers, setup and the new linked Learn sessions.
- Folder names come from the test or course record.
- Folders are ordered by their newest session. Sessions inside a folder are newest first.
- A testprep or AP session with no linked test or course goes in an **Unfiled** folder inside its section. No session ever disappears from the sidebar.

The **+** on a folder (my call; the owner saw it in the sketch):
- **Tests:** starts a new session on that same test. It uses the same path as "Continue where I left off" (POST `kind: testprep` with the `testId`).
- **AP:** opens `/ap/<id>`. An AP session needs a scope and type choice, and the sitting chooser and Learn buttons live there.

Open and closed state (my call):
- Sections start open and folders start closed.
- The folder holding the current session opens automatically.
- Open/closed state is remembered per browser in localStorage, with every read and write wrapped in try/catch.

Search and filter (my call):
- **Search** matches across all sessions. It opens matching folders and hides folders with no match.
- The **Teaching/Practice/All filter** applies only to the flat list.

Keyboard navigation (my call):
- ↑/↓ walks the session rows that are **visible**, top to bottom. That is the sessions inside open folders, then the flat list.
- Closed folders are skipped, and folder rows themselves are not stops.
- Enter opens the selected session, as today.
- During search, matching folders are open, so their matches are walked first.

### 3. AP Learn linked to the course (owner)

- **Learn** on an AP topic **or unit** (owner: both) creates a session linked to that course and its scope. It carries `apCourseId` and the topic or unit, so it files into the course folder automatically.
- **Teaching tutor plus AP grading** (owner):
  - The session stays a Teaching session (`kind: "teach"`). It has the same teacher agent, tools and `learnPrompt` first message as today's Learn, and teaches exactly as it does now.
  - On top of that, a linked Learn session gets one extra tool. The tool records a graded result for an in-scope topic through the same store path that sittings use (`apCourseStore.recordResult` → `applyResult`, with the chat id as the attempt's `chatId`).
- **What counts:** only answers the tutor grades move progress (owner). This covers the teacher's own check formats, the quiz and explain-it-back checks.
  - Each graded check is recorded against the topic it tests.
  - In a unit-scoped session, that is whichever topic in the unit the check covers.
  - Topics outside the session's scope are refused, with the same in-scope rule that sittings have.
- **The teacher prompt** gets a short section that appears only when the session is linked. It says: when you grade a check, record it against the topic it covers.
- **Deletion:** deleting a linked Learn session forgets its recorded answers, the same way AP chat deletion does today (`src/server/chats.ts` deletion cleanup must cover these chats).
- **Builder's call:** the exact field shape, for example `apCourseId` plus an `apLearn: { scope: topic | unit }` field. It must not reuse `apSitting`, which drives the AP agent.

### 4. Tests/AP sessions feed the knowledge graph (owner)

- **Extraction threshold.** Today, extraction after a turn waits until about 4096 uncovered tokens (`graph.extractionChunkTokens`). For `testprep` and `ap` sessions, and for linked Learn sessions (any chat with an `apCourseId`), it fires at about **1024** uncovered tokens instead.
  - My call: this is a fixed threshold, not a new setting.
  - My call: it changes only *when* extraction starts. Batch sizing inside the extraction pipeline keeps using `graph.extractionChunkTokens`.
  - `teach` keeps the existing setting.
  - `practice` stays excluded.
- **One-time backfill** (owner). After the update is built and the server restarted, run the existing manual extraction path (`POST /api/graph/coverage/extract`) once over each of the 8 existing `testprep`/`ap` chats.
  - It is an operational step, not code shipped in the app.
  - It uses the owner's configured models and incurs a one-time model cost, which the owner approved.

### 5. Light default (owner)

- The factory default in `src/core/settings.ts` changes from dark to light.
- The root `<html>` renders `light`, so dark mode no longer flashes in before the page loads.
- The pre-paint theme boot script switches to dark only when the saved preference says dark.
- Saved settings are respected.

## Constraints

- AGENTS.md: read the bundled Next.js docs in `node_modules/next/dist/docs/` before touching routing or rendering code.
- Keep the internal names (`LH_*`, `learnharness`) and the existing data layout under `data/`.
- Windows test baseline: 20 known failing tests by name. No new failures.

## Left to the builder

- **Sidebar components:** how to split `components/sidebar.tsx`. Extracting a folder-tree component is encouraged.
- **Styling:** follow the existing warm theme and the current sidebar row styles.
- **Folder names:** how the sidebar gets test and course names. Prefer one request, for example by extending the sessions list response.
- **Learn sitting data:** the exact field shape, as noted in §3.
