# AP prep mode

AP prep is the fourth session type, alongside Teach, Practice and Test prep. It is built around a named AP course: the agent builds the course's units and official topics from College Board's Course and Exam Description, teaches any topic with the ordinary Teach mode, asks newly written multiple-choice questions and real released free-response questions, and tracks readiness per unit and course with a status per topic across sittings.

Use it when you are preparing for an AP exam and want practice that judges your reasoning, not only your final answer.

## Add a course

1. Choose **AP** where you choose Teach, Practice or Test prep.
2. Type the course name (for example, "AP Calculus BC") and send it. Starting a course asks for the name only — there is nothing to attach yet.

The agent finds the course's current official Course and Exam Description on a College Board site, saves it to this computer, and reads it a few pages at a time. It then proposes the course's units, each holding the official numbered topics it covers. Every topic shows the course-description page it came from, in smaller text under it, so you can audit coverage.

If the agent finds the wrong document, or cannot find one, say so in the setup chat. You can paste a College Board link or attach the PDF there, and the agent works from that instead. It never builds the list from general knowledge or from a site that is not College Board's.

## Confirm the units and topics

The proposed list appears as a card in the conversation. In the card you can:

- edit a unit title or a topic's text in place;
- remove a unit or a topic;
- add topics to a unit, or add a new unit.

Then choose **Confirm units and topics**. Confirming saves the list and the card collapses to a summary with a link to the course page. Nothing can be practised until the list is confirmed.

A topic you add yourself has no page in the course description. It is saved with the source **Added by you**, and Learn teaches it without a page reference.

## Released papers and the question index

Once the list is confirmed, the tutor finds the course's released free-response papers and their scoring guidelines on College Board's site, saves each one, and starts indexing them. On a course that is already set up, **Find released papers** in the course page's **Official documents** block opens a new AP session and does the same.

Only College Board documents are downloaded, either in the setup chat for a new course or with **Find released papers** for an existing one. If a document cannot be found, the setup session accepts a College Board link or a PDF you attach.

Indexing is a background job. It reads each saved paper with its scoring guideline once and records every question's pages, its lettered parts, the scoring points for each part, and the topic each part tests. It runs on the Cheap model slot, so a topic tag can be wrong. The tag is shown beside each part's label; if one is wrong, tell the tutor and it corrects it. A correction applies to later gradings only — it does not rewrite a result already recorded.

The indexing result arrives as a message in the session. It says how many questions were indexed and names any paper that failed:

- the card's header is **Released papers indexed** when the papers were read, or **Indexing failed** when none could be;
- the body reports the count and any part left without a topic tag.

Each paper is indexed once. Papers already in the index are skipped, so asking for papers again only indexes what is new. The **Official documents** block on the course page shows each released paper's count — `3 questions indexed`, `1 question indexed`, or `not indexed yet` — and the course total as `Released questions indexed: <n>`.

## The course page

Open **AP** in the sidebar to see every course, or open a course directly. The course page shows:

- the course name and **Ready: N%**, with the number of solid topics out of the total;
- one row per unit with its own solid/total count, percent and progress bar;
- each unit's topics with their status and its **Learn** and **Practise** buttons;
- **Practise weak topics** for a sitting across units;
- **Official documents**: the course description, each released paper with its scoring guideline, each paper's indexed question count, `Released questions indexed: <n>`, and **Find released papers**.

Each topic has one of four statuses:

| Status | Meaning |
| --- | --- |
| `solid` | Answered correctly, unaided, for the right reasons. |
| `gap` | The last answer was a miss. |
| `re-check next sitting` | Missed, then answered correctly later in the same sitting. It must be answered correctly again in a **later** sitting before it counts as solid. |
| `not yet asked` | No practice answer yet. |

A solid topic that is later missed becomes a gap again. Readiness is solid topics divided by all topics, both per unit and overall; 100% is reserved for every topic being solid, and other percentages round down. Learning never changes readiness.

## Start a sitting

**Practise** asks two things. The **scope** is whichever button opened it: a single topic, one whole unit, or **Practise weak topics** across units. The chooser then asks the question **kind**:

- **Multiple-choice** starts a sitting of questions the tutor writes.
- **Free-response** starts a sitting of real released College Board questions.
- **Mixed** alternates between released questions and questions the tutor writes.

Free-response and Mixed need at least one indexed released question. Until the course has one, they stay visible but cannot be selected, and each says `needs released papers`.

Each sitting is its own session, titled with the course, the scope and the kind (for example `AP Calculus BC · Unit 1 Limits · free-response`). Within the scope, topics are ordered weak-first: re-checks first, then topics not yet asked, then remaining gaps. A single-topic sitting asks several different questions on that topic.

## How multiple-choice questions work

A multiple-choice question is newly written by the agent. It is modelled on the official sample questions for the topic's unit in the course description, and tests one topic. Each card is labelled **AP · generated**.

Pick an option. You may also type or dictate your reasoning; the field is **YOUR REASONING (optional)**.

- A bare pick is graded right or wrong.
- With reasoning, the agent judges both. **A right pick reached by flawed reasoning counts as a miss.**
- "I don't know" counts as a miss, and so does asking for a hint, for help, or for the answer before answering.

The card shows no verdict: the app does not mark an option right or wrong, does not reveal the correct option, and shows no confidence slider. The agent's reply is the verdict.

## How free-response questions work

A free-response question is a real released College Board question from the course's question index. Its card is labelled **AP · released** and shows the question's original paper page as an image, so figures and formatting are exactly the official ones. While the question loads, the card says `Loading the question…`.

Below the page there is one answer box per part. Each box is labelled with the part's letter, with the topic the part is tagged with in smaller text beside it. Type or dictate each answer; dictation goes to the box that last had focus, the first box by default. A part you leave blank earns no points.

**Attach photo** adds a photo of your written work, up to six; each can be removed before you submit. The tutor sees a photo while it grades and says what it read from the page before grading. The image is not kept in the session: the answer record lists each attached photo by file name as `Photo attached: <name>`, and the tutor's written read-back is what stays with the transcript.

**I don't know** covers the whole question. It disables the answer boxes and photos and submits every part as blank.

**Submit answer** sends every part at once. After you submit, the conversation keeps a record of your answer: each part under its letter (a blank part is an em dash) and each photo by file name. **Show question** reopens the original page. That record shows no verdict — the score card is the only place a result is shown.

The scoring guideline is never shown before you answer. If the paper is not on this computer (for example on a second computer), the card says `This paper is not on this computer. Download it from the course page.` and links to the course page, where **Download** fetches it again. The indexed questions work without re-indexing once the paper is back. A page that cannot be rendered says `This page could not be shown.`

## After a multiple-choice answer

- **Correct:** the agent says only that it is right and moves on. It does not explain a correct answer.
- **Miss or "I don't know":** the agent gives the correct answer, pinpoints where the reasoning went wrong, and asks a **fresh** question on the same topic straight away. The diagnosis appears with the fresh question. That immediate retry never makes the topic solid. If the fresh question is missed too, the agent tries a different angle.

Only an answered question moves a topic.

## After a free-response answer

The tutor grades every scoring point against the official rubric, point by point, not the final answer alone; a right answer whose required working or justification is missing earns no point. It records the result once for that answer.

A topic counts as correct only when every scoring point on every part tagged to it was earned. A part tagged to no listed topic earns points but moves no topic.

The tutor explains the score in its reply. The score card is the only place a result is shown. Its header reads `2023 FRQ 2 — scored 4/9`, and each part gets a row with its letter, its points as `earned/total`, the topic it tests when tagged, and one of three words:

| Word | Meaning |
| --- | --- |
| `earned` | Every scoring point on that part was earned. |
| `missed` | At least one scoring point on that part was not earned. |
| `not counted` | The part is tagged to no listed topic, so it moves none. |

After points are lost, the tutor gives the correct answer and says which points were lost and why. The retry for each missed topic inside the sitting's scope is a fresh multiple-choice question, with the diagnosis shown alongside it. If you answered **I don't know**, the tutor gives the correct answer to each part and then retries the same way.

## Learn

**Learn** on a unit or a topic opens an ordinary Teach session, with its opening message naming the course and the unit or topic. When the course description is on this computer, the message points to it as reference material. When it is not, the agent says so and teaches from its own knowledge of the AP syllabus.

Teach runs unchanged, including its opening assessment. Learning never changes readiness.

## Edit the units and topics later

**Edit units and topics** on the course page reopens the same editor on the confirmed list. Saving confirms the list again, so practice can continue immediately.

- An edited or reordered topic keeps its status and history.
- A new topic starts `not yet asked`.
- A removed topic's history is dropped.

## Official documents and this computer

The course record holds the units, topics, statuses, answer history and the list of official documents, and syncs with the rest of your learning data at `data/ap/<id>.json`. The question index syncs too, at `data/ap-index/<courseId>.json`: question numbers, pages, topic tags and the text of every scoring point.

The PDFs and their page images do not sync. They stay on this computer under `data/ap-papers/<courseId>/`, and `ap-papers/` is excluded in `data/.gitignore`. Learner photos stay local as well: the image itself is never kept in the session or the synced data, and an answer shows a photo only by file name.

A course opened on another computer therefore has its progress and indexed questions intact, but not its papers. The course page shows **Missing on this computer** beside a missing document, with a **Download** button that fetches it again. Downloads come only from College Board sites. Free-response questions work again once the paper is downloaded; there is no second indexing pass.

## Later stages

Free-response practice uses real released questions. Questions the tutor writes in free-response form, and drawn figures, come in a later stage; multiple-choice questions use text, tables, mathematical notation and inline diagrams only.

## Where progress is stored

Each course's units, topics, statuses and per-topic history are stored under the data directory at `data/ap/<id>.json`, and its released-question index at `data/ap-index/<courseId>.json`. AP sessions also contribute to the knowledge graph like Teach sessions: the ideas the material covers become graph material for later sessions. Only ideas go in. Statuses, answer correctness, and readiness never do.
