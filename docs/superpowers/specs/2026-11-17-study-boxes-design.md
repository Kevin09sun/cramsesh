# Study boxes and graph grouping: design

Date: 2026-11-17. Size: small change (short design). This follows on from `2026-11-17-session-folders-design.md`.

## Intent

The owner wants Tests and AP to be organised as the existing progress **boxes**, not as sidebar dropdown folders: "each test/ap is its own box that I can access through the test/ap page".

The owner also wants the home knowledge graph to group sessions from the same test or course into one region. Today, "MDM4U1 Chapter 3 Test Prep" and its "Continue." session are separate regions, and so are the two E&M sessions.

## Decisions (owner)

1. **Sidebar.**
   - **Tests** and **AP** open `/tests` and `/ap` again. Those pages show the boxes with progress bars.
   - The Tests/AP folder tree is removed from the sidebar.
   - The sidebar session list shows only sessions that are not Tests/AP. A session counts as Tests/AP if it has `kind` `testprep` or `ap`, or has any `apCourseId`.
   - Sidebar **search still finds** Tests/AP sessions by name. Matches appear in the normal result list.
2. **List pages.** `/tests` and `/ap` each get a **+ New** button at the top. It goes to `/chat/new?mode=testprep` or `/chat/new?mode=ap`, the draft that sets up a new test or course. Today that link only appears when the list is empty.
3. **Box detail pages.** `/tests/<id>` and `/ap/<id>` each get a **Sessions** section.
   - It lists every session linked to that test or course: testprep chats by `testId`, and chats with `apCourseId` (AP sittings, setup, find-papers and linked Learn).
   - Each row shows title and age, newest first, and links to `/chat/<id>`.
   - A **+ New session** button sits next to the list:
     - **Tests:** the existing "Continue" start, which POSTs `kind: testprep` with the `testId`.
     - **AP:** scrolls to the existing Learn and Practise controls on the same page. My call: an AP session needs a scope and type, and those controls already ask for them.
   - Empty state: "No sessions yet."
4. **Graph grouping.**
   - Linked sessions share one graph region. A node's region is its birth session's **test** (`testId`) or **course** (`apCourseId`) when the birth chat has one. Otherwise it stays the birth session, as today.
   - The region is labelled with the test or course title.
   - This is the same birth-session rule, one level up. It is still derived on read, with no stored partition and no model call.
   - Chain and implication attachment, the layout settle and the server graph all use the same grouping function, so the regions stay consistent everywhere.

## Kept from the previous change

These stay as they are:
- Learn linking and graded progress
- the 1k extraction trigger and the backfill already done
- light mode
- the `/api/chats` `folderNames` field, which is harmless. My call: the now-unused `components/session-folders.tsx` tree and its sidebar-only helpers are deleted. The pure `groupSessions` stays only if the new pages use it.

## Non-goals

- No semantic or "smart" merging of unrelated Teaching chats. Grouping follows the test/course link only.
- No change to how the boxes themselves look.

## Left to the builder

- How detail pages fetch their sessions: a server-side filter of `listChats()` in the page component is preferred, since those pages are already server-rendered.
- Styling. Reuse the existing card and row styles.
