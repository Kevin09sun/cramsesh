/**
 * Unit tests — the AP `ap_frq` question shape (task 6, stage 2).
 *
 * A released free-response question is answered part by part, with optional
 * photos of the learner's written work. The app shows NO verdict of any
 * kind: the tutor grades against the released rubric after the answer
 * arrives. These pins sit at the pure core seams — the tool schema, the
 * answer record, the model-facing compact form and frame, the learner-facing
 * projection, tool-part routing, and the markdown export.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildAnswer,
	compactAnswerForModel,
	dismissedAnswer,
	type QuestionAnswerData,
	type QuestionData,
} from "../src/core/question-core.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "../src/core/pending.ts";
import { parseApFrqInput, parseQuestionInput } from "../src/core/tool-parts.ts";
import { answerForPresentation } from "../src/core/answer-presentation.ts";
import { AP_FRQ_ANSWER_FRAME, newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";

const frq = { questionId: "2023-2", title: "2023 FRQ 2", file: "frq-2023.pdf", pages: [4, 5] };

function frqQD(overrides?: Partial<QuestionData>): QuestionData {
	return {
		id: "frq1",
		kind: "frq",
		question: frq.title,
		mode: "text",
		options: [],
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const twoParts = [
	{ label: "a", text: "  x + 2  " },
	{ label: "b", text: "   " },
];

const onePhoto = ["C:\\Users\\learner\\Pictures\\work.jpg"];

describe("ap_frq is a kind of its own question tool", () => {
	it("registers in QUESTION_TOOLS and folds onto the frq kind", () => {
		assert.ok((QUESTION_TOOLS as readonly string[]).includes("ap_frq"));
		assert.equal(toolQuestionKind("ap_frq"), "frq");
	});

	it("parses its own minimal input and rejects a malformed one", () => {
		assert.deepEqual(parseApFrqInput({ questionId: "2023-2" }), { questionId: "2023-2" });
		assert.deepEqual(parseApFrqInput({ questionId: "2023-2", details: "Show your work." }), {
			questionId: "2023-2",
			details: "Show your work.",
		});
		assert.equal(parseApFrqInput({}), undefined);
		assert.deepEqual(parseQuestionInput("ap_frq", { questionId: "2023-2" }), { questionId: "2023-2" });
	});
});

describe("the ap_frq answer record", () => {
	it("keeps every part (a blank one as an empty string), the photo paths and the question block", () => {
		const answer = buildAnswer(
			frqQD(),
			{ parts: twoParts, photos: onePhoto, frq },
			"ap_frq",
		);
		assert.equal(answer.kind, "frq");
		assert.deepEqual(answer.parts, [
			{ label: "a", text: "x + 2" },
			{ label: "b", text: "" },
		]);
		assert.deepEqual(answer.photos, onePhoto);
		assert.deepEqual(answer.frq, frq);
		assert.equal(answer.dontKnow, false);
		assert.equal(answer.correct, undefined);
		assert.equal(answer.confidence, undefined);
		assert.equal(answer.committed, undefined);
		assert.equal(answer.explanation, undefined);
	});

	it("records 'I don't know' without a verdict or confidence", () => {
		const answer = buildAnswer(frqQD(), { dontKnow: true, parts: [], frq }, "ap_frq");
		assert.equal(answer.kind, "frq");
		assert.equal(answer.dontKnow, true);
		assert.equal(answer.correct, undefined);
		assert.equal(answer.confidence, undefined);
		assert.equal(answer.committed, undefined);
	});

	it("compacts to the learner-only record the model needs, photo paths included", () => {
		const answer = buildAnswer(frqQD(), { parts: twoParts, photos: onePhoto, frq }, "ap_frq");
		assert.deepEqual(compactAnswerForModel(answer), {
			kind: "frq",
			questionId: "2023-2",
			parts: [
				{ label: "a", text: "x + 2" },
				{ label: "b", text: "" },
			],
			photos: onePhoto,
		});
	});

	it("the learner-facing projection carries no verdict fields", () => {
		const answer = buildAnswer(frqQD(), { parts: twoParts, photos: onePhoto, frq }, "ap_frq");
		const shown = answerForPresentation(answer, { questionId: "2023-2" });
		assert.deepEqual(shown, answer);
		for (const key of ["correct", "correctIndices", "committed", "explanation"]) {
			assert.equal(key in shown, false, key);
		}
	});

	it("leaves the ap_mcq projection's withheld verdict untouched", () => {
		const mcqAnswer: QuestionAnswerData = {
			kind: "quiz",
			tool: "ap_mcq",
			questionText: "Which limit is 1?",
			dontKnow: false,
			answers: [],
			correct: true,
			correctIndices: [1],
			committed: "commitment",
			explanation: "explanation",
			answeredAt: "2026-01-01T00:00:00Z",
		};
		const shown = answerForPresentation({ ...mcqAnswer }, {
			topicId: "t1",
			question: "Which limit is 1?",
			options: [
				{ label: "1", value: "1" },
				{ label: "2", value: "2" },
				{ label: "3", value: "3" },
				{ label: "4", value: "4" },
			],
			correctAnswer: "1",
			optionNotes: ["a", "b", "c", "d"],
		});
		for (const key of ["correct", "correctIndices", "committed", "explanation"]) {
			assert.equal(key in shown, false, key);
		}
	});
});

describe("the ap_frq tool result and export", () => {
	const answer = buildAnswer(frqQD(), { parts: twoParts, photos: onePhoto, frq }, "ap_frq");

	it("the model-facing result is framed for grading and nothing else", () => {
		const result = newAnswerResult("frq1", "ap_frq", answer);
		const text = (result.content[0] as { text: string }).text;
		assert.ok(text.startsWith(AP_FRQ_ANSWER_FRAME));
	});

	it("a dismissal carries no frame", () => {
		const result = newAnswerResult("frq1", "ap_frq", dismissedAnswer("frq", frq.title));
		const text = (result.content[0] as { text: string }).text;
		assert.equal(text, JSON.stringify({ kind: "frq", dismissed: true }));
	});

	it("the markdown export shows the title and each part, claims each photo, and no verdict or path", () => {
		const twoPhotos = [...onePhoto, "C:\\Users\\learner\\Pictures\\back.jpg"];
		const withPhotos = buildAnswer(frqQD(), { parts: twoParts, photos: twoPhotos, frq }, "ap_frq");
		const result = newAnswerResult("frq1", "ap_frq", withPhotos);
		const messages = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "frq1", name: "ap_frq", arguments: { questionId: "2023-2" } }],
				timestamp: Date.now(),
			},
			{ ...result, id: "r1" },
		] as unknown as LhMessage[];
		const md = sessionMarkdown(messages);
		assert.match(md, /### AP free-response/);
		assert.match(md, /2023 FRQ 2/);
		assert.match(md, /\(a\)/);
		assert.match(md, /x \+ 2/);
		assert.equal(md.match(/Photo attached/g)?.length, 2);
		assert.doesNotMatch(md, /work\.jpg|back\.jpg/);
		assert.doesNotMatch(md, /correct|✓|✗/i);
	});
});