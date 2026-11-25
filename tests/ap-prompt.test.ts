/**
 * AP PROMPT (AP prep, 2026-11-13): the AP agent composes its OWN base +
 * doctrine (never the teaching base) and the same CURATED shared appendix
 * as test prep — voice, accuracy, learner files, web lookups and
 * formatting. The question mechanics and confidence chunks stay out: AP has
 * its own doctrine and no quiz or confidence tools.
 *
 * The order pin: own fragments first, then the five allowlisted shared
 * files in filename order — the same composition order the loader uses.
 *
 * TEST-DIR ISOLATION: the GET route reads the settings store, so LH_DATA_DIR
 * must be set before the first import that loads config.ts (same discipline
 * as prompt-overrides.test.ts).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = mkdtempSync(path.join(os.tmpdir(), "lh-ap-prompt-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { listSourceSegments } = await import("../src/agent/prompt-segments.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { isValidSegmentPath } = await import("../src/core/prompt-segments.ts");
const { GET: getPromptSegments } = await import("../app/api/settings/prompts/route.ts");

after(() => {
	rmSync(TMP_DATA, { recursive: true, force: true });
});

const promptText = (relative: string) =>
	readFileSync(new URL(`../src/agent/prompts/${relative}`, import.meta.url), "utf8").trim();

const AP_SHARED = ["10-voice.md", "15-accuracy.md", "30-learner-files.md", "35-web.md", "40-formatting.md"];

describe("ap prompt composition", () => {
	it("composes the doctrine and the formatting appendix — never the teaching base or question mechanics", () => {
		const prompt = composeInstructions("ap");
		// The doctrine's rules are binding content; the wording is ours, so
		// assert the load-bearing instructions themselves.
		for (const rule of [
			"ap_save_document",
			"propose_units",
			"ap_progress",
			"ap_mcq",
			"ap_record_result",
			"dontKnow",
			"Never build the list from general knowledge",
		]) {
			assert.ok(prompt.includes(rule), `missing doctrine rule: ${rule}`);
		}
		// The own fragments compose verbatim…
		assert.ok(prompt.includes(promptText("ap/00-base.md")));
		assert.ok(prompt.includes(promptText("ap/10-doctrine.md")));
		// …and the allowlisted formatting guide is the trailing appendix.
		assert.ok(prompt.includes(promptText("shared/40-formatting.md")));
		// The teaching base and the question/confidence mechanics never compose.
		assert.doesNotMatch(prompt, /install understanding/);
		assert.doesNotMatch(prompt, /## The question tools/);
		assert.doesNotMatch(prompt, /Every quiz answer carries/);
	});

	it("pins the owner-approved doctrine sentences", () => {
		const prompt = composeInstructions("ap");
		assert.ok(prompt.includes("A right option reached by flawed reasoning is `wrong`."));
		assert.ok(prompt.includes("Never build the list from general knowledge or from a site that is not College Board's."));
	});

	it("keeps the confirmed list editable by chat, including in a practice sitting", () => {
		const doctrine = promptText("ap/10-doctrine.md");
		assert.ok(doctrine.includes("Confirmation does not freeze the list."));
		assert.match(doctrine, /when the learner asks to change the unit and topic list instead of answering a question, do not record a result/i);
	});

	it("pins the stage 2 instructions for released free-response questions", () => {
		const prompt = composeInstructions("ap");
		// The first sentence of every block Task 9 inserts or replaces — the
		// tools, the setup and sitting rules, the grading section and the
		// prohibitions.
		for (const sentence of [
			"saves an official College Board document into the course's local store: from a `url` on a College Board site, or from a `path` the learner attached.",
			"starts a background job that reads every saved paper with its scoring guideline and builds the question index: each question's pages, its parts, the topic each part tests, and the official rubric points.",
			"asks one released free-response question, by its `questionId` from `ap_progress`.",
			"returns that question's text, each part's topic, and each official rubric point with its id.",
			"shows you one photo of the learner's written work, by the path in their answer.",
			"corrects the topic a question part is tagged with, when the learner or the question itself shows the tag is wrong.",
			"Once the learner has confirmed the list, find the released free-response papers for the course and the scoring guideline for each, on College Board's site, for every year published under the current course framework.",
			"`ap_progress` gives the sitting's scope, its question kind, the topic queue, and, for free-response and mixed sittings, the released questions that fit the scope.",
			"The learner's answer to each part, and the paths of any photos, arrive as the result of your `ap_frq` call; grade in that turn.",
			"Never present a question you wrote as a released College Board question, and never alter a released question.",
			"Never read out, quote or summarise the scoring guideline before the learner has answered.",
		]) {
			assert.ok(prompt.includes(sentence), `missing stage 2 instruction: ${sentence}`);
		}
		// Stage 1's free-response-not-available line is replaced.
		assert.doesNotMatch(prompt, /In this version every question is multiple-choice/);
		// …and the two stage 1 sentences the prompt already pinned survive.
		assert.ok(prompt.includes("A right option reached by flawed reasoning is `wrong`."));
		assert.ok(prompt.includes("Never build the list from general knowledge or from a site that is not College Board's."));
	});

	it("pins the stage 3 instructions for generated free-response questions and figures", () => {
		const prompt = composeInstructions("ap");
		// The first sentence of every block stage 3 inserts or replaces, and
		// each new prohibition.
		for (const sentence of [
			"read a stored document by the file name `ap_save_document` or `ap_progress` gave you: its page count, the text of a page range, or the pages where a phrase appears.",
			"asks one multiple-choice question on one topic.",
			"asks one released free-response question, by its `questionId` from `ap_progress`.",
			"applies your grading of one answered released question: for each part, the ids of the rubric points earned.",
			"asks one free-response question you wrote.",
			"applies your grading of the generated question the learner just answered: for each part, the ids of the rubric points earned, numbered in the order you wrote them (`a1`, `a2`, `b1`).",
			"starts a background job that draws one precise figure from your brief.",
			"shows you a finished figure, by its id, as the learner will see it.",
			"every question is one you write, with `ap_mcq`.",
			"for each topic, ask an unused released question with `ap_frq` when `ap_progress` lists one; when none fits or all are used, write one with `ap_frq_gen`.",
			"follow the topic queue, alternating a multiple-choice question you write with a free-response question, released when an unused one covers the topic and written by you otherwise.",
			"Before writing, read the topic's pages in the course description and the official sample questions for its unit, and model the question on them: the same skills, the same level, the same kind of wrong answers.",
			"Use a figure only when the question cannot be asked properly without one: a graph to read, a diagram of a physical setup, a geometric construction.",
			"For a released question, call `ap_rubric`.",
			"Record the points earned on each part: `ap_record_frq` for a released question, `ap_record_gen` for one you wrote.",
			"for each part that lost points, give the correct answer and say which points were lost and exactly why.",
			"Never reveal a committed answer or a rubric point before the learner has answered.",
			"Never use a figure you have not looked at.",
		]) {
			assert.ok(prompt.includes(sentence), `missing stage 3 instruction: ${sentence}`);
		}
		// The stage 2 wordings stage 3 replaces are gone. The old ap_record_frq
		// tail is asserted as its full sentence, because `before you speak`
		// also appears in ap_record_result, which stage 3 leaves byte-for-byte
		// unchanged.
		assert.doesNotMatch(prompt, /Use text, tables, mathematical notation and inline diagrams only/);
		assert.doesNotMatch(prompt, /Call it once per question, before you speak\./);
		assert.doesNotMatch(prompt, /You pass nothing else/);
		assert.doesNotMatch(prompt, /pose a fresh multiple-choice question on it with/);
	});

	it("lists own fragments first, then exactly the five allowlisted shared files", () => {
		assert.deepEqual(
			listSourceSegments("ap").map((segment) => segment.path),
			[
				"ap/00-base.md",
				"ap/10-doctrine.md",
				...AP_SHARED.map((file) => `shared/${file}`),
			],
		);
		assert.ok(!listSourceSegments("ap").some((segment) => segment.path === "system-prompt.md"));
	});

	it("GET /api/settings/prompts exposes the ap segments", async () => {
		const response = await getPromptSegments();
		assert.equal(response.status, 200);
		const view = await response.json();
		assert.ok(Array.isArray(view.ap), "the ap key is present");
		assert.deepEqual(view.ap.map((s: { path: string }) => s.path), listSourceSegments("ap").map((s) => s.path));
	});

	it("accepts ap segment paths", () => {
		assert.equal(isValidSegmentPath("ap/10-doctrine.md"), true);
	});
});