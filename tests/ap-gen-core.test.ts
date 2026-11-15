/**
 * Unit tests — the AP generated free-response question shape (AP prep stage 3,
 * task 1).
 *
 * The tutor writes this question itself: a title, a stem, and one to six
 * parts, each with a committed answer and committed rubric points. Those
 * commitments are NEVER shown; the display projection strips them, and the
 * scoring adapter makes the committed rubric gradeable exactly like a
 * released question's. These pins sit at the pure core seams — the tool
 * schema and its authoring problems, the display projection, the scoring
 * adapter, the answer record and frame, tool-part routing, and the markdown
 * export.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	apFrqGenDisplay,
	apFrqGenInputProblems,
	apMcqInputProblems,
	buildAnswer,
	compactAnswerForModel,
	dismissedAnswer,
	type ApFrqGenToolInput,
	type QuestionData,
} from "../src/core/question-core.ts";
import { apGenQuestionId, generatedScoringQuestion, scoreAttempt } from "../src/core/ap-frq.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "../src/core/pending.ts";
import { parseApFrqGenInput, parseApMcqInput, parseQuestionInput } from "../src/core/tool-parts.ts";
import { AP_FRQ_GEN_ANSWER_FRAME, newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";

type GenPart = ApFrqGenToolInput["parts"][number];

function part(overrides: Partial<GenPart> = {}): GenPart {
	return {
		label: "a",
		prompt: "Find the average rate of change.",
		topicId: "t11",
		answer: "12 degrees per minute",
		points: ["uses the endpoints", "divides correctly"],
		...overrides,
	};
}

function generatedInput(overrides: Partial<ApFrqGenToolInput> = {}): ApFrqGenToolInput {
	return {
		title: "Rates of change in a cooling model",
		stem: "A cup of coffee cools in a room kept at 20 degrees.",
		parts: [
			part(),
			part({ label: "b", prompt: "Interpret your answer.", points: ["states a rate", "with units"] }),
			part({
				label: "c-i",
				prompt: "Explain the model's assumption.",
				topicId: "t12",
				answer: "The room stays at 20 degrees.",
				points: ["names a constant ambient temperature"],
			}),
		],
		details: "Show your work.",
		...overrides,
	};
}

/** Every key name in a nested value, at any depth. */
function keysDeep(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(keysDeep);
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([key, nested]) => [key, ...keysDeep(nested)]);
	}
	return [];
}

describe("apFrqGenInputProblems", () => {
	it("accepts a valid three-part input", () => {
		assert.deepEqual(apFrqGenInputProblems(generatedInput()), []);
	});

	it("requires a title and a stem", () => {
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ title: "  " })), ["title must not be blank"]);
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ stem: "" })), ["stem must not be blank"]);
	});

	it("requires between one and six parts", () => {
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ parts: [] })), [
			"between one and six parts are required",
		]);
		const seven = Array.from({ length: 7 }, (_, index) =>
			part({ label: String.fromCharCode(97 + index) }),
		);
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ parts: seven })), [
			"between one and six parts are required",
		]);
	});

	it("requires lower-case, hyphenatable labels that are distinct after normalisation", () => {
		const message = "part labels must be one lower-case letter, sub-parts hyphenated, and distinct";
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ parts: [part({ label: "a1" })] })), [message]);
		assert.deepEqual(
			apFrqGenInputProblems(generatedInput({ parts: [part({ label: "A" }), part({ label: "a" })] })),
			[message],
		);
	});

	it("requires a prompt, a committed answer and at least one rubric point per part", () => {
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ parts: [part({ prompt: "  " })] })), [
			'part "a" needs a prompt',
		]);
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ parts: [part({ answer: "" })] })), [
			'part "a" needs a committed answer',
		]);
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ parts: [part({ points: [] })] })), [
			'part "a" needs at least one rubric point',
		]);
	});

	it("rejects a blank rubric point", () => {
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ parts: [part({ points: ["ok", "   "] })] })), [
			"rubric points must not be blank",
		]);
	});

	it("names a part by its normalised label", () => {
		assert.deepEqual(apFrqGenInputProblems(generatedInput({ parts: [part({ label: " A ", prompt: "" })] })), [
			'part "a" needs a prompt',
		]);
	});

	it("reports every problem it finds, in the brief's order", () => {
		assert.deepEqual(
			apFrqGenInputProblems({
				title: "",
				stem: "",
				parts: [part({ prompt: "" }), part({ label: "b", answer: "" })],
			}),
			[
				"title must not be blank",
				"stem must not be blank",
				'part "a" needs a prompt',
				'part "b" needs a committed answer',
			],
		);
	});
});

describe("apFrqGenDisplay", () => {
	it("shows title, stem, labelled prompts, figure and details — no answer or points at any depth", () => {
		const input = generatedInput({ figure: "fig-1" });
		const shown = apFrqGenDisplay(input);

		assert.equal(shown.title, input.title);
		assert.equal(shown.stem, input.stem);
		assert.equal(shown.figure, "fig-1");
		assert.equal(shown.details, "Show your work.");
		assert.deepEqual(
			shown.parts.map((shownPart) => shownPart.label),
			["a", "b", "c-i"],
		);
		assert.deepEqual(
			shown.parts.map((shownPart) => shownPart.prompt),
			input.parts.map((inputPart) => inputPart.prompt),
		);

		const keys = keysDeep(shown);
		assert.equal(keys.includes("answer"), false, "no committed answer reaches a screen");
		assert.equal(keys.includes("points"), false, "no rubric point reaches a screen");
	});

	it("normalises a part label exactly as the scoring adapter does", () => {
		const shown = apFrqGenDisplay(generatedInput({ parts: [part({ label: " A " })] }));
		assert.equal(shown.parts[0]!.label, "a");
	});
});

describe("the generated question's scoring adapter", () => {
	const input: ApFrqGenToolInput = {
		title: "Two parts sharing a topic",
		stem: "Setup.",
		parts: [
			part({ label: "a", topicId: "t11", answer: "first", points: ["first", "second"] }),
			part({ label: "b", topicId: "t11", answer: "second", points: ["third"] }),
		],
	};
	const question = generatedScoringQuestion(input);

	it("names point ids '<label><n>' from normalised labels and trims point text", () => {
		assert.deepEqual(
			question.parts.map((questionPart) => questionPart.points.map((point) => point.id)),
			[["a1", "a2"], ["b1"]],
		);
		assert.deepEqual(
			question.parts.map((questionPart) => questionPart.points.map((point) => point.text)),
			[["first", "second"], ["third"]],
		);
		assert.deepEqual(
			question.parts.map((questionPart) => questionPart.topicId),
			["t11", "t11"],
		);
	});

	it("scores a full-mark attempt and folds two parts sharing a topic to one result", () => {
		const score = scoreAttempt(
			question,
			{ parts: [{ label: "a", earned: ["a1", "a2"] }, { label: "b", earned: ["b1"] }] },
			new Set(["t11"]),
		);
		assert.equal(score.earned, 3);
		assert.equal(score.total, 3);
		assert.deepEqual(score.parts.map((scored) => scored.complete), [true, true]);
		assert.deepEqual(score.topics, [{ topicId: "t11", result: "correct" }]);
	});

	it("marks a partially earned part incomplete and its shared topic wrong", () => {
		const score = scoreAttempt(
			question,
			{ parts: [{ label: "a", earned: ["a1"] }, { label: "b", earned: ["b1"] }] },
			new Set(["t11"]),
		);
		assert.equal(score.earned, 2);
		assert.deepEqual(score.parts.map((scored) => scored.complete), [false, true]);
		assert.deepEqual(score.topics, [{ topicId: "t11", result: "wrong" }]);
	});

	it("'I don't know' scores nothing and marks every tagged topic dontKnow", () => {
		const score = scoreAttempt(question, { dontKnow: true, parts: [] }, new Set(["t11"]));
		assert.equal(score.earned, 0);
		assert.equal(score.total, 3);
		assert.deepEqual(score.topics, [{ topicId: "t11", result: "dontKnow" }]);
	});

	it("derives the question id from the tool call id", () => {
		assert.equal(apGenQuestionId("call_1"), "gen-call_1");
	});
});

describe("ap_frq_gen is a free-response question tool", () => {
	it("registers in QUESTION_TOOLS and folds onto the frq kind", () => {
		assert.ok((QUESTION_TOOLS as readonly string[]).includes("ap_frq_gen"));
		assert.equal(toolQuestionKind("ap_frq_gen"), "frq");
	});

	it("parses a valid input, including through parseQuestionInput", () => {
		assert.deepEqual(parseApFrqGenInput(generatedInput()), generatedInput());
		assert.deepEqual(parseQuestionInput("ap_frq_gen", generatedInput()), generatedInput());
		assert.deepEqual(parseApFrqGenInput(generatedInput({ figure: "fig-1" }))?.figure, "fig-1");
	});

	it("rejects an input with no parts or a blank commitment", () => {
		assert.equal(parseApFrqGenInput({ title: "t", stem: "s", parts: [] }), undefined);
		assert.equal(parseApFrqGenInput(generatedInput({ parts: [part({ answer: "  " })] })), undefined);
		assert.equal(parseApFrqGenInput(generatedInput({ parts: [part({ label: "a1" })] })), undefined);
	});
});

const frqBlock = { questionId: "gen-call1", title: "Rates of change in a cooling model" };

function genQD(overrides?: Partial<QuestionData>): QuestionData {
	return {
		id: "gen-call1",
		kind: "frq",
		question: frqBlock.title,
		mode: "text",
		options: [],
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function genAnswer(): ReturnType<typeof buildAnswer> {
	return buildAnswer(
		genQD(),
		{
			parts: [
				{ label: "a", text: "  The coffee loses twelve degrees every minute.  " },
				{ label: "b", text: "" },
			],
			frq: frqBlock,
		},
		"ap_frq_gen",
	);
}

describe("the ap_frq_gen answer record and frame", () => {
	it("keeps the parts and the question block, with no file or pages", () => {
		const answer = genAnswer();
		assert.deepEqual(answer.parts, [
			{ label: "a", text: "The coffee loses twelve degrees every minute." },
			{ label: "b", text: "" },
		]);
		assert.deepEqual(answer.frq, frqBlock);
	});

	it("compacts to the same learner-only shape an ap_frq answer has", () => {
		assert.deepEqual(compactAnswerForModel(genAnswer()), {
			kind: "frq",
			questionId: "gen-call1",
			parts: [
				{ label: "a", text: "The coffee loses twelve degrees every minute." },
				{ label: "b", text: "" },
			],
		});
	});

	it("frames the model-facing result for grading with ap_record_gen", () => {
		const result = newAnswerResult("gen-call1", "ap_frq_gen", genAnswer());
		const text = (result.content[0] as { text: string }).text;
		assert.ok(text.startsWith(AP_FRQ_GEN_ANSWER_FRAME));
	});

	it("carries no frame on a dismissal", () => {
		const result = newAnswerResult("gen-call1", "ap_frq_gen", dismissedAnswer("frq", frqBlock.title));
		const text = (result.content[0] as { text: string }).text;
		assert.equal(text, JSON.stringify({ kind: "frq", dismissed: true }));
	});
});

describe("the ap_frq_gen markdown export", () => {
	it("shows the title, stem, each part's prompt and the learner's answers — never the committed text", () => {
		const input = generatedInput();
		const answer = buildAnswer(
			genQD(),
			{
				parts: [
					{ label: "a", text: "The coffee loses twelve degrees every minute." },
					{ label: "b", text: "The rate is constant." },
				],
				frq: { questionId: "gen-call1", title: input.title },
			},
			"ap_frq_gen",
		);
		const result = newAnswerResult("gen-call1", "ap_frq_gen", answer);
		const messages = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "gen-call1", name: "ap_frq_gen", arguments: input }],
				timestamp: Date.now(),
			},
			{ ...result, id: "r1" },
		] as unknown as LhMessage[];

		const md = sessionMarkdown(messages);
		assert.match(md, /### AP free-response \(generated\)/);
		assert.ok(md.includes(input.title));
		assert.ok(md.includes(input.stem));
		for (const inputPart of input.parts) assert.ok(md.includes(inputPart.prompt), inputPart.prompt);
		assert.ok(md.includes("The coffee loses twelve degrees every minute."));
		assert.ok(md.includes("The rate is constant."));
		for (const inputPart of input.parts) {
			assert.equal(md.includes(inputPart.answer), false, `committed answer leaked: ${inputPart.answer}`);
			for (const point of inputPart.points) {
				assert.equal(md.includes(point), false, `rubric point leaked: ${point}`);
			}
		}
	});
});

describe("ap_mcq's optional figure", () => {
	const good = {
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
	};

	it("parses with and without a figure", () => {
		assert.ok(parseApMcqInput(good), "a figure-less question still parses");
		assert.equal(parseApMcqInput({ ...good, figure: "fig-1" })?.figure, "fig-1");
	});

	it("rejects a field that is present but blank", () => {
		assert.deepEqual(apMcqInputProblems({ ...good, figure: "   " }), ["figure must not be blank"]);
		assert.equal(parseApMcqInput({ ...good, figure: " " }), undefined);
	});
});
