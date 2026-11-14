/**
 * Unit tests — AP real free-response core (pure logic, no fs, no server).
 *
 * The question index shape, the scoring guideline's rubric points, scoring an
 * attempt by point, and which real questions a sitting may ask live in
 * src/core/ap-frq.ts; later tasks (index job, stores, tools, UI) import these.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	apPaperFileName,
	apQuestionId,
	apQuestionTitle,
	attemptProblems,
	eligibleRealQuestions,
	isApQuestionIndex,
	scoreAttempt,
	type ApQuestionIndex,
	type ApRealAttempt,
	type ApRealQuestion,
} from "../src/core/ap-frq.ts";
import type { ApCourseRecord } from "../src/core/ap.ts";

function question(overrides: Partial<ApRealQuestion> = {}): ApRealQuestion {
	return {
		id: "2023-2",
		paperId: "frq-2023",
		scoringId: "scoring-2023",
		year: 2023,
		number: 2,
		pages: [3, 4],
		scoringPages: [5],
		parts: [
			{ label: "a", topicId: "t11", points: [{ id: "a1", text: "first point" }, { id: "a2", text: "second point" }] },
			{ label: "b", topicId: "t12", points: [{ id: "b1", text: "third point" }] },
			{ label: "c", points: [{ id: "c1", text: "fourth point" }] },
		],
		...overrides,
	};
}

function index(overrides: Partial<ApQuestionIndex> = {}): ApQuestionIndex {
	return {
		courseId: "apcalc",
		version: 1,
		updatedAt: "2026-11-14T00:00:00.000Z",
		questions: [question()],
		...overrides,
	};
}

function rawQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...question(), ...overrides };
}

function rawIndex(
	questions: unknown[],
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		courseId: "apcalc",
		version: 1,
		updatedAt: "2026-11-14T00:00:00.000Z",
		questions,
		...overrides,
	};
}

describe("AP free-response file names, ids and titles", () => {
	it("apPaperFileName names a paper and its scoring guideline, with sets when present", () => {
		assert.equal(apPaperFileName("frq", 2023), "frq-2023.pdf");
		assert.equal(apPaperFileName("scoring", 2023), "scoring-2023.pdf");
		assert.equal(apPaperFileName("frq", 2023, 2), "frq-2023-set2.pdf");
		assert.equal(apPaperFileName("scoring", 2023, 2), "scoring-2023-set2.pdf");
	});

	it("apQuestionId includes the set only when there is one", () => {
		assert.equal(apQuestionId(2023, 2), "2023-2");
		assert.equal(apQuestionId(2023, 2, 2), "2023-s2-2");
	});

	it("apQuestionTitle reads as the paper's heading", () => {
		assert.equal(apQuestionTitle({ year: 2023, number: 2 }), "2023 FRQ 2");
		assert.equal(apQuestionTitle({ year: 2023, set: 2, number: 2 }), "2023 Set 2 FRQ 2");
	});
});

describe("isApQuestionIndex", () => {
	it("accepts a well-formed index", () => {
		assert.equal(isApQuestionIndex(index()), true);
	});

	it("rejects a question with no parts", () => {
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ parts: [] })])), false);
	});

	it("rejects a part with no points", () => {
		assert.equal(
			isApQuestionIndex(rawIndex([rawQuestion({ parts: [{ label: "a", topicId: "t11", points: [] }] })])),
			false,
		);
	});

	it("rejects duplicate question ids", () => {
		assert.equal(isApQuestionIndex(rawIndex([question(), question()])), false);
	});

	it("rejects a question with an empty pages list, but allows empty scoringPages", () => {
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ pages: [] })])), false);
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ scoringPages: [] })])), true);
	});

	it("rejects duplicate part labels", () => {
		assert.equal(
			isApQuestionIndex(
				rawIndex([
					rawQuestion({
						parts: [
							{ label: "a", topicId: "t11", points: [{ id: "a1", text: "one" }] },
							{ label: "a", topicId: "t12", points: [{ id: "b1", text: "two" }] },
						],
					}),
				]),
			),
			false,
		);
	});

	it("rejects duplicate point ids within one question, across its parts", () => {
		assert.equal(
			isApQuestionIndex(
				rawIndex([
					rawQuestion({
						parts: [
							{ label: "a", topicId: "t11", points: [{ id: "p1", text: "one" }] },
							{ label: "b", topicId: "t12", points: [{ id: "p1", text: "again" }] },
						],
					}),
				]),
			),
			false,
		);
	});

	it("checks field types strictly", () => {
		assert.equal(isApQuestionIndex(null), false);
		assert.equal(isApQuestionIndex([]), false);
		assert.equal(isApQuestionIndex("index"), false);
		assert.equal(isApQuestionIndex(42), false);
		assert.equal(isApQuestionIndex(rawIndex([question()], { version: 2 })), false);
		assert.equal(isApQuestionIndex(rawIndex([question()], { courseId: 7 })), false);
		assert.equal(isApQuestionIndex(rawIndex([question()], { updatedAt: null })), false);
		assert.equal(isApQuestionIndex(rawIndex([question()], { questions: "none" })), false);
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ id: "" })])), false);
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ pages: [0] })])), false);
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ scoringPages: [1.5] })])), false);
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ number: "2" })])), false);
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ parts: [{ label: "", points: [{ id: "a1", text: "x" }] }] })])), false);
		assert.equal(isApQuestionIndex(rawIndex([rawQuestion({ parts: [{ label: "a", points: [{ id: "a1", text: "x" }] }], id: "" })])), false);
	});
});

describe("attemptProblems", () => {
	it("returns no problems for a grading that covers every part and point", () => {
		assert.deepEqual(
			attemptProblems(question(), [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
				{ label: "c", earned: ["c1"] },
			]),
			[],
		);
	});

	it("names a part that is not on the question", () => {
		assert.deepEqual(
			attemptProblems(question(), [
				{ label: "z", earned: [] },
				{ label: "a", earned: ["a1"] },
				{ label: "b", earned: ["b1"] },
				{ label: "c", earned: ["c1"] },
			]),
			['part "z" is not a part of this question'],
		);
	});

	it("names a part listed more than once", () => {
		assert.deepEqual(
			attemptProblems(question(), [
				{ label: "a", earned: ["a1"] },
				{ label: "a", earned: ["a2"] },
				{ label: "b", earned: ["b1"] },
				{ label: "c", earned: ["c1"] },
			]),
			['part "a" is listed more than once'],
		);
	});

	it("names a part that is missing", () => {
		assert.deepEqual(
			attemptProblems(question(), [
				{ label: "a", earned: ["a1"] },
				{ label: "b", earned: ["b1"] },
			]),
			['part "c" is missing'],
		);
	});

	it("names a point that is not a rubric point of its part", () => {
		assert.deepEqual(
			attemptProblems(question(), [
				{ label: "a", earned: ["a9"] },
				{ label: "b", earned: ["b1"] },
				{ label: "c", earned: ["c1"] },
			]),
			['point "a9" is not a rubric point of part "a"'],
		);
	});

	it("names a point listed more than once", () => {
		assert.deepEqual(
			attemptProblems(question(), [
				{ label: "a", earned: ["a1", "a1"] },
				{ label: "b", earned: ["b1"] },
				{ label: "c", earned: ["c1"] },
			]),
			['point "a1" is listed more than once'],
		);
	});
});

describe("scoreAttempt", () => {
	it("scores each part by earned points and folds parts to one result per topic", () => {
		const score = scoreAttempt(
			question(),
			{
				parts: [
					{ label: "a", earned: ["a1"] },
					{ label: "b", earned: ["b1"] },
					{ label: "c", earned: ["c1"] },
				],
			},
			new Set(["t11", "t12"]),
		);

		assert.equal(score.earned, 3);
		assert.equal(score.total, 4);
		assert.deepEqual(score.parts, [
			{ label: "a", earned: 1, total: 2, topicId: "t11", complete: false },
			{ label: "b", earned: 1, total: 1, topicId: "t12", complete: true },
			{ label: "c", earned: 1, total: 1, complete: true },
		]);
		assert.deepEqual(score.topics, [
			{ topicId: "t11", result: "wrong" },
			{ topicId: "t12", result: "correct" },
		]);
	});

	it("a topic is correct only when every part tagged to it is complete", () => {
		const shared: ApRealQuestion = question({
			parts: [
				{ label: "a", topicId: "t11", points: [{ id: "a1", text: "one" }] },
				{ label: "b", topicId: "t11", points: [{ id: "b1", text: "two" }] },
			],
		});

		const score = scoreAttempt(
			shared,
			{ parts: [{ label: "a", earned: ["a1"] }, { label: "b", earned: [] }] },
			new Set(["t11"]),
		);

		assert.deepEqual(score.topics, [{ topicId: "t11", result: "wrong" }]);
	});

	it("a topic is correct when every part tagged to it is complete", () => {
		const shared: ApRealQuestion = question({
			parts: [
				{ label: "a", topicId: "t11", points: [{ id: "a1", text: "one" }] },
				{ label: "b", topicId: "t11", points: [{ id: "b1", text: "two" }] },
			],
		});

		const score = scoreAttempt(
			shared,
			{ parts: [{ label: "a", earned: ["a1"] }, { label: "b", earned: ["b1"] }] },
			new Set(["t11"]),
		);

		assert.deepEqual(score.topics, [{ topicId: "t11", result: "correct" }]);
	});

	it("'I don't know' scores every part 0 and every tagged topic dontKnow", () => {
		const score = scoreAttempt(
			question(),
			{
				dontKnow: true,
				parts: [
					{ label: "a", earned: ["a1", "a2"] },
					{ label: "b", earned: ["b1"] },
					{ label: "c", earned: ["c1"] },
				],
			},
			new Set(["t11", "t12"]),
		);

		assert.equal(score.earned, 0);
		assert.equal(score.total, 4);
		assert.deepEqual(score.parts, [
			{ label: "a", earned: 0, total: 2, topicId: "t11", complete: false },
			{ label: "b", earned: 0, total: 1, topicId: "t12", complete: false },
			{ label: "c", earned: 0, total: 1, complete: false },
		]);
		assert.deepEqual(score.topics, [
			{ topicId: "t11", result: "dontKnow" },
			{ topicId: "t12", result: "dontKnow" },
		]);
	});

	it("a part whose topic is absent or outside the confirmed list is scored but contributes no topic", () => {
		const score = scoreAttempt(
			question(),
			{
				parts: [
					{ label: "a", earned: ["a1", "a2"] },
					{ label: "b", earned: ["b1"] },
					{ label: "c", earned: ["c1"] },
				],
			},
			new Set(["t11"]),
		);

		assert.deepEqual(score.topics, [{ topicId: "t11", result: "correct" }]);
		assert.deepEqual(score.parts[1], { label: "b", earned: 1, total: 1, complete: true });
		assert.deepEqual(score.parts[2], { label: "c", earned: 1, total: 1, complete: true });
	});
});

const course: ApCourseRecord = {
	id: "apcalc",
	title: "AP Calculus BC",
	createdAt: "2026-11-13T00:00:00.000Z",
	updatedAt: "2026-11-13T00:00:00.000Z",
	planConfirmed: true,
	sections: [
		{
			id: "u1",
			title: "Unit 1 Limits",
			points: [
				{ id: "t11", text: "1.1 Limits intro", source: "CED p. 1", status: "unchecked", history: [] },
				{ id: "t12", text: "1.2 Limits at infinity", source: "CED p. 2", status: "gap", history: [] },
			],
		},
		{
			id: "u2",
			title: "Unit 2 Derivatives",
			points: [
				{ id: "t21", text: "2.1 Definition of derivative", source: "CED p. 3", status: "unchecked", history: [] },
				{ id: "t22", text: "2.2 Derivative rules", source: "CED p. 4", status: "solid", history: [] },
			],
		},
	],
	documents: [],
	version: 1,
};

/** A released question whose parts are tagged with the given topics, in order. */
function tagged(id: string, ...topicIds: Array<string | undefined>): ApRealQuestion {
	return {
		id,
		paperId: "frq-2023",
		scoringId: "scoring-2023",
		year: 2023,
		number: Number(id.split("-")[1]),
		pages: [1],
		scoringPages: [2],
		parts: topicIds.map((topicId, partIndex) => {
			const label = String.fromCharCode(97 + partIndex);
			return {
				label,
				...(topicId === undefined ? {} : { topicId }),
				points: [{ id: `${label}1`, text: `${label} point` }],
			};
		}),
	};
}

describe("eligibleRealQuestions", () => {
	const q1 = tagged("2023-1", "t22");
	const q2 = tagged("2023-2", "t12");
	const q3 = tagged("2023-3", "t11");
	const q4 = tagged("2023-4", "t21", "t11");
	const q5 = tagged("2023-5", "t11");
	const q6 = tagged("2023-6", "gone");

	// Deliberately unordered; the function owns the order.
	const idx = index({ questions: [q2, q1, q4, q3, q5, q6] });
	const attempts: ApRealAttempt[] = [{ questionId: "2023-5", chatId: "c1", at: "2026-11-14T00:00:00.000Z", parts: [] }];

	it("returns [] when there is no index yet", () => {
		assert.deepEqual(eligibleRealQuestions(course, null, { type: "weak" }, "c1", []), []);
	});

	it("keeps questions tagged to a topic in scope, weak-first, unused before used", () => {
		const eligible = eligibleRealQuestions(course, idx, { type: "weak" }, "c1", attempts);

		// Weak queue order is t11, t21, t12 (t22 is solid, so absent from it).
		// 2023-4 tests t21 and t11, so its best position is t11's.
		assert.deepEqual(
			eligible.map((entry) => entry.question.id),
			["2023-4", "2023-3", "2023-2", "2023-1", "2023-5"],
		);
		assert.deepEqual(
			eligible.map((entry) => entry.used),
			[false, false, false, false, true],
		);
	});

	it("orders a question by its weakest in-scope topic, not the topic of its first part", () => {
		// t22 is solid, so it is absent from the weak queue; t11 is the earliest
		// entry and t12 is mid-queue. A question whose first part tests the
		// absent topic still sorts first because its second part tests t11.
		const lateThenEarly = tagged("2023-9", "t22", "t11");
		const onlyMid = tagged("2023-10", "t12");
		const eligible = eligibleRealQuestions(
			course,
			index({ questions: [onlyMid, lateThenEarly] }),
			{ type: "weak" },
			"c1",
			[],
		);

		assert.deepEqual(
			eligible.map((entry) => entry.question.id),
			["2023-9", "2023-10"],
		);
	});

	it("lists the in-scope topics a question tests, in part order", () => {
		const eligible = eligibleRealQuestions(course, idx, { type: "weak" }, "c1", []);
		const byId = new Map(eligible.map((entry) => [entry.question.id, entry]));

		assert.deepEqual(byId.get("2023-4")!.topicIds, ["t21", "t11"]);
		assert.deepEqual(byId.get("2023-3")!.topicIds, ["t11"]);
	});

	it("drops parts outside the sitting's scope", () => {
		const unitIndex = index({ questions: [q2, q3, q6] });
		const eligible = eligibleRealQuestions(course, unitIndex, { type: "unit", unitId: "u1" }, "c1", []);

		assert.deepEqual(
			eligible.map((entry) => entry.question.id),
			["2023-3", "2023-2"],
		);
	});

	it("in a single-topic sitting keeps only questions that test that topic", () => {
		const topicIndex = index({ questions: [q4] });
		const eligible = eligibleRealQuestions(course, topicIndex, { type: "topic", topicId: "t11" }, "c1", []);

		assert.deepEqual(eligible.map((entry) => entry.question.id), ["2023-4"]);
		assert.deepEqual(eligible[0]!.topicIds, ["t11"]);
	});
});