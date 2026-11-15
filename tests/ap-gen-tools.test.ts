/**
 * AP GENERATED FREE-RESPONSE TOOLS (AP prep stage 3, Task 4): ap_frq_gen,
 * ap_record_gen, ap_progress's "no unused released question" line and the
 * generatedFrqs record derivation.
 *
 * The gating law mirrors stage 2: a generated question is posed only in an
 * frq/mixed sitting, every part's topic must be in the confirmed list, at
 * least one part must be in scope, a figure must be a finished drawing of
 * this chat the tutor has looked at, and a released question still unused
 * for a topic wins over a written one (the retry after a miss is exempt).
 * Only the committed rubric can grade an attempt; one answer records once.
 *
 * Hermetic: fakes stand in for the course store, the attempt port, the index,
 * the papers folder and the figure port. Refusals never touch a mutating
 * port.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyResult } from "../src/core/test-prep.ts";
import type { AnswerResult, TestPoint } from "../src/core/test-prep.ts";
import type { ApCourseRecord, ApSitting } from "../src/core/ap.ts";
import type { ApQuestionIndex, ApRealAttempt, ApRealQuestion } from "../src/core/ap-frq.ts";
import type { ApFrqGenToolInput } from "../src/core/question-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import {
	apTools,
	generatedFrqsFrom,
	type ApAttemptsPort,
	type ApCourseStorePort,
	type ApFiguresPort,
	type ApIndexPort,
	type ApPapersPort,
	type ApToolContext,
} from "../src/agent/tools/ap.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

function topic(id: string, text: string): TestPoint {
	return { id, text, source: "p. 1", status: "unchecked", history: [] };
}

function courseOf(overrides: Partial<ApCourseRecord> = {}): ApCourseRecord {
	return {
		id: "ap_course_1",
		title: "AP Calculus BC",
		createdAt: "2026-11-15T00:00:00.000Z",
		updatedAt: "2026-11-15T00:00:00.000Z",
		planConfirmed: true,
		documents: [],
		sections: [
			{
				id: "unit_limits",
				title: "Unit 1 Limits",
				points: [topic("t_limits", "1.1 Introducing Calculus")],
			},
			{
				id: "unit_deriv",
				title: "Unit 2 Derivatives",
				points: [topic("t_deriv", "2.1 Definition of the Derivative")],
			},
		],
		version: 1,
		...overrides,
	};
}

/** The fixture with one topic carrying a single prior attempt. */
function withAttempt(
	topicId: string,
	result: AnswerResult,
	chatId: string,
): ApCourseRecord {
	const course = courseOf();
	return courseOf({
		sections: course.sections.map((section) => ({
			...section,
			points: section.points.map((point) =>
				point.id === topicId
					? { ...point, status: result === "correct" ? "solid" : "gap", history: [{ at: "2026-11-15T01:00:00.000Z", chatId, result }] }
					: point,
			),
		})),
	});
}

function releasedQuestion(id = "2023-1", topicId = "t_limits"): ApRealQuestion {
	return {
		id,
		paperId: "frq-2023",
		scoringId: "scoring-2023",
		year: 2023,
		number: 1,
		pages: [1],
		scoringPages: [1],
		parts: [{ label: "a", topicId, points: [{ id: "a1", text: "A point." }] }],
	};
}

function indexOf(...questions: ApRealQuestion[]): ApQuestionIndex {
	return {
		courseId: "ap_course_1",
		version: 1,
		updatedAt: "2026-11-15T00:00:00.000Z",
		questions,
	};
}

const FRQ: ApSitting = { scope: { type: "weak" }, kind: "frq" };
const MIXED: ApSitting = { scope: { type: "weak" }, kind: "mixed" };
const MCQ: ApSitting = { scope: { type: "weak" }, kind: "mcq" };
const TOPIC_LIMITS: ApSitting = { scope: { type: "topic", topicId: "t_limits" }, kind: "frq" };

/** A valid generated question: two parts, one topic each, two and one point. */
function genInput(overrides: Partial<ApFrqGenToolInput> = {}): ApFrqGenToolInput {
	return {
		title: "Cooling model",
		stem: "A cup of coffee cools according to a differentiable model.",
		parts: [
			{
				label: "a",
				prompt: "Find the rate of change at t = 3.",
				topicId: "t_limits",
				answer: "The rate is −3 degrees per minute.",
				points: ["Sets up the derivative.", "Evaluates it at t = 3."],
			},
			{
				label: "b",
				prompt: "Interpret the sign of the rate.",
				topicId: "t_deriv",
				answer: "Negative: the coffee is cooling.",
				points: ["Reads the sign correctly."],
			},
		],
		...overrides,
	};
}

// ── fakes ───────────────────────────────────────────────────────────────────

interface RecordedAttempt {
	courseId: string;
	attempt: ApRealAttempt;
	topics: Array<{ topicId: string; result: AnswerResult }>;
}

/** The course store and the attempt port share ONE current record, exactly
 *  like production: ap_record_gen re-reads the course after the attempt store
 *  wrote it, so a second call in the same turn sees the first. */
function fakeCourseStores(initial: ApCourseRecord) {
	let current = initial;
	const records: RecordedAttempt[] = [];
	const courses: ApCourseStorePort = {
		get: (id) => (current.id === id ? current : null),
		savePlan: () => {
			throw new Error("savePlan is not expected");
		},
		recordResult: () => {
			throw new Error("recordResult is not expected");
		},
		putDocument: () => {
			throw new Error("putDocument is not expected");
		},
	};
	const attempts: ApAttemptsPort = {
		record: (courseId, attempt, topics) => {
			records.push({ courseId, attempt, topics });
			current = {
				...current,
				sections: current.sections.map((section) => ({
					...section,
					points: section.points.map((point) => {
						const scored = topics.find((candidate) => candidate.topicId === point.id);
						return scored ? applyResult(point, scored.result, attempt.chatId, attempt.at) : point;
					}),
				})),
				realAttempts: [...(current.realAttempts ?? []), attempt],
			};
			return current;
		},
	};
	return { courses, attempts, records, current: () => current };
}

function fakeIndex(initial: ApQuestionIndex | null): ApIndexPort {
	return {
		get: (courseId) => (initial?.courseId === courseId ? initial : null),
		retagPart: () => {},
		forgetPaper: () => false,
	};
}

function fakePapers(): ApPapersPort {
	return {
		dir: () => ".",
		present: () => true,
		download: async () => {
			throw new Error("download is not expected");
		},
		importFile: async () => {
			throw new Error("importFile is not expected");
		},
	};
}

type FigureState = "ready" | "pending" | "failed" | "unknown";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("figure")]);

function fakeFigures(states: Record<string, FigureState> = {}): {
	figures: ApFiguresPort;
	stateCalls: string[];
	pngCalls: string[];
} {
	const stateCalls: string[] = [];
	const pngCalls: string[] = [];
	const figures: ApFiguresPort = {
		state: (jobId) => {
			stateCalls.push(jobId);
			return states[jobId] ?? "unknown";
		},
		png: async (jobId) => {
			pngCalls.push(jobId);
			if (states[jobId] !== "ready") throw new Error("figure not ready");
			return PNG;
		},
	};
	return { figures, stateCalls, pngCalls };
}

interface HarnessOptions {
	course?: ApCourseRecord;
	sitting?: ApSitting;
	index?: ApQuestionIndex | null;
	figures?: Record<string, FigureState>;
	viewed?: ReadonlySet<string>;
	generated?: { toolCallId: string; input: ApFrqGenToolInput; answered: boolean }[];
	answeredFrq?: (questionId: string) => "answered" | "pending" | "none";
	answeredFrqCount?: (questionId: string) => number;
}

function harness(options: HarnessOptions = {}) {
	const course = options.course ?? courseOf();
	const stores = fakeCourseStores(course);
	const scripted = fakeFigures(options.figures);
	const index = fakeIndex(options.index === undefined ? null : options.index);
	const ctx: ApToolContext = {
		chatId: "chat_now",
		courseId: course.id,
		courses: stores.courses,
		papers: fakePapers(),
		index,
		attempts: stores.attempts,
		answeredFrq: options.answeredFrq ?? (() => "none"),
		answeredFrqCount: options.answeredFrqCount ?? (() => 0),
		figures: scripted.figures,
		viewedFigures: options.viewed ?? new Set<string>(),
		generatedFrqs: options.generated ?? [],
		...(options.sitting === undefined ? {} : { sitting: options.sitting }),
	};
	return {
		ctx,
		tools: apTools(ctx),
		course,
		index,
		figures: scripted,
		attempts: { records: stores.records, current: stores.current },
	};
}

function problemsOf(result: { details: unknown }): string[] {
	return (result.details as { problems?: string[] }).problems ?? [];
}

// ── the record derivation ───────────────────────────────────────────────────

function assistantCall(id: string, name: string, args: unknown): LhMessage {
	return {
		id: `m_${id}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as unknown as LhMessage;
}

function answerResult(id: string, details: unknown, isError = false): LhMessage {
	return {
		id: `r_${id}`,
		role: "toolResult",
		toolCallId: id,
		toolName: "ap_frq_gen",
		content: [{ type: "text", text: "" }],
		details,
		isError,
		timestamp: 2,
	} as unknown as LhMessage;
}

describe("generatedFrqsFrom", () => {
	it("reads a pending pose, oldest first", () => {
		const input = genInput();
		const messages = [assistantCall("g1", "ap_frq_gen", input)];
		assert.deepEqual(generatedFrqsFrom(messages), [{ toolCallId: "g1", input, answered: false }]);
	});

	it("marks a real free-response answer as answered", () => {
		const input = genInput();
		const messages = [
			assistantCall("g1", "ap_frq_gen", input),
			answerResult("g1", { kind: "frq", parts: [] }),
		];
		const derived = generatedFrqsFrom(messages);
		assert.equal(derived.length, 1);
		assert.equal(derived[0]!.toolCallId, "g1");
		assert.equal(derived[0]!.input.title, input.title);
		assert.equal(derived[0]!.answered, true);
	});

	it("does not count a dismissal, an error or another kind of answer", () => {
		for (const [details, isError] of [
			[{ kind: "frq", dismissed: true }, false],
			[{ kind: "frq", parts: [] }, true],
			[{ kind: "quiz" }, false],
			[{}, false],
		] as const) {
			const messages = [assistantCall("g1", "ap_frq_gen", genInput()), answerResult("g1", details, isError)];
			assert.equal(generatedFrqsFrom(messages)[0]!.answered, false, JSON.stringify(details));
		}
	});

	it("keeps the order of poses and skips unparseable ones and other tools", () => {
		const messages = [
			assistantCall("g1", "ap_frq_gen", genInput({ title: "First" })),
			assistantCall("x1", "ap_frq", { questionId: "2023-1" }),
			assistantCall("g2", "ap_frq_gen", { title: "", stem: "" }),
			assistantCall("g3", "ap_frq_gen", genInput({ title: "Third" })),
			answerResult("g3", { kind: "frq", parts: [] }),
		];
		const derived = generatedFrqsFrom(messages);
		assert.deepEqual(derived.map((entry) => entry.toolCallId), ["g1", "g3"]);
		assert.deepEqual(derived.map((entry) => entry.answered), [false, true]);
		assert.equal(derived[1]!.input.title, "Third");
	});
});

// ── ap_frq_gen ──────────────────────────────────────────────────────────────

describe("ap_frq_gen", () => {
	it("REFUSES before the list is confirmed, before the setup-session refusal", async () => {
		const h = harness({ course: courseOf({ planConfirmed: false }), sitting: MCQ });
		const result = await h.tools.ap_frq_gen!.execute("call_g", genInput() as never);
		assert.equal(result.isError, true);
		assert.match(problemsOf(result)[0]!, /not confirmed/i);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES in the setup session", async () => {
		const h = harness();
		const result = await h.tools.ap_frq_gen!.execute("call_g", genInput() as never);
		assert.equal(result.isError, true);
		assert.match(problemsOf(result)[0]!, /setup session/);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES in a multiple-choice sitting", async () => {
		const h = harness({ sitting: MCQ });
		const result = await h.tools.ap_frq_gen!.execute("call_g", genInput() as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["this sitting is multiple-choice only"]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES authoring problems before the unknown-topic check", async () => {
		const h = harness({ sitting: FRQ });
		const input = genInput({
			title: "",
			parts: [
				{
					label: "a",
					prompt: "Find it.",
					topicId: "t_ghost",
					answer: "It.",
					points: ["A point."],
				},
			],
		});
		const result = await h.tools.ap_frq_gen!.execute("call_g", input as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["title must not be blank"]);
	});

	it("REFUSES a part whose topic is not in the confirmed list", async () => {
		const h = harness({ sitting: FRQ });
		const input = genInput({
			parts: [
				{
					label: "a",
					prompt: "Find it.",
					topicId: "t_ghost",
					answer: "It.",
					points: ["A point."],
				},
			],
		});
		const result = await h.tools.ap_frq_gen!.execute("call_g", input as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ['part "a": unknown topic t_ghost']);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES a blank part topic as unknown", async () => {
		const h = harness({ sitting: FRQ });
		const input = genInput({
			parts: [
				{
					label: "a",
					prompt: "Find it.",
					topicId: "   ",
					answer: "It.",
					points: ["A point."],
				},
			],
		});
		const result = await h.tools.ap_frq_gen!.execute("call_g", input as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ['part "a": unknown topic ']);
	});

	it("REFUSES a question that tests nothing in this sitting's scope", async () => {
		const h = harness({ sitting: TOPIC_LIMITS });
		const input = genInput({
			parts: [
				{
					label: "a",
					prompt: "Find it.",
					topicId: "t_deriv",
					answer: "It.",
					points: ["A point."],
				},
			],
		});
		const result = await h.tools.ap_frq_gen!.execute("call_g", input as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["this question tests nothing in this sitting's scope"]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES the figure states and an unlooked-at ready figure", async () => {
		for (const [state, message] of [
			["unknown", "figure fig_x is not a figure drawn in this session"],
			["pending", "figure fig_x is not finished yet — ask a question that needs no figure meanwhile"],
			["failed", "figure fig_x could not be drawn"],
			["ready", "look at figure fig_x with ap_view_figure before using it"],
		] as const) {
			const h = harness({ sitting: FRQ, figures: { fig_x: state } });
			const result = await h.tools.ap_frq_gen!.execute("call_g", { ...genInput(), figure: "fig_x" } as never);
			assert.equal(result.isError, true, state);
			assert.deepEqual(problemsOf(result), [message], state);
			assert.equal(h.attempts.records.length, 0, state);
		}
	});

	it("accepts a figure seen earlier in the saved record and earlier in this turn", async () => {
		const saved = harness({ sitting: FRQ, figures: { fig_x: "ready" }, viewed: new Set(["fig_x"]) });
		const fromRecord = await saved.tools.ap_frq_gen!.execute("call_g", { ...genInput(), figure: "fig_x" } as never);
		assert.equal(fromRecord.isError, undefined);

		const sameTurn = harness({ sitting: FRQ, figures: { fig_x: "ready" } });
		await sameTurn.tools.ap_view_figure!.execute("call_v", { figure: "fig_x" } as never);
		const result = await sameTurn.tools.ap_frq_gen!.execute("call_g", { ...genInput(), figure: "fig_x" } as never);
		assert.equal(result.isError, undefined, "the look happened this turn, before the saved record knows");
	});

	it("REFUSES while an unused released question covers a part's topic", async () => {
		const h = harness({ sitting: FRQ, index: indexOf(releasedQuestion("2023-1", "t_limits")) });
		const result = await h.tools.ap_frq_gen!.execute("call_g", genInput() as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), [
			"a released question covers 1.1 Introducing Calculus: ask 2023-1 with ap_frq first",
		]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("exempts a topic missed in this sitting (the retry)", async () => {
		const h = harness({
			course: withAttempt("t_limits", "wrong", "chat_now"),
			sitting: FRQ,
			index: indexOf(releasedQuestion("2023-1", "t_limits")),
		});
		const result = await h.tools.ap_frq_gen!.execute("call_g", genInput() as never);
		assert.equal(result.isError, undefined, "a miss this sitting is retried with a written question");
		assert.equal(result.terminate, true);
	});

	it("does not exempt a miss from an earlier chat", async () => {
		const h = harness({
			course: withAttempt("t_limits", "wrong", "chat_old"),
			sitting: FRQ,
			index: indexOf(releasedQuestion("2023-1", "t_limits")),
		});
		const result = await h.tools.ap_frq_gen!.execute("call_g", genInput() as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), [
			"a released question covers 1.1 Introducing Calculus: ask 2023-1 with ap_frq first",
		]);
	});

	it("treats a released question answered in this chat as used", async () => {
		const h = harness({
			sitting: FRQ,
			index: indexOf(releasedQuestion("2023-1", "t_limits")),
			answeredFrqCount: (questionId) => (questionId === "2023-1" ? 1 : 0),
		});
		const result = await h.tools.ap_frq_gen!.execute("call_g", genInput() as never);
		assert.equal(result.isError, undefined);
	});

	it("poses the question as a pending question and ends the turn", async () => {
		const h = harness({ sitting: FRQ });
		const result = await h.tools.ap_frq_gen!.execute("call_g", genInput() as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.match((result.content[0] as { text: string }).text, /Question posed/);
		assert.equal(result.details, null, "no card: nothing reaches the UI");
		assert.equal(h.tools.ap_frq_gen!.executionMode, "sequential");
		assert.equal(h.attempts.records.length, 0, "posing records nothing");
	});
});

// ── ap_record_gen ───────────────────────────────────────────────────────────

describe("ap_record_gen", () => {
	const GENERATED = () => [{ toolCallId: "call_gen", input: genInput(), answered: true }];

	it("REFUSES when no generated question has been answered", async () => {
		for (const generated of [
			[],
			[{ toolCallId: "call_gen", input: genInput(), answered: false }],
		]) {
			const h = harness({ sitting: FRQ, generated });
			const result = await h.tools.ap_record_gen!.execute("call_r", { parts: [] } as never);
			assert.equal(result.isError, true);
			assert.deepEqual(problemsOf(result), [
				"no generated free-response question has been answered in this session",
			]);
			assert.equal(h.attempts.records.length, 0);
		}
	});

	it("records a full-marks attempt and returns the score card shape", async () => {
		const h = harness({ sitting: FRQ, generated: GENERATED() });
		const result = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		assert.equal(h.attempts.records.length, 1);
		const recorded = h.attempts.records[0]!;
		assert.equal(recorded.courseId, "ap_course_1");
		assert.equal(recorded.attempt.questionId, "gen-call_gen");
		assert.equal(recorded.attempt.chatId, "chat_now");
		assert.match(recorded.attempt.at, /^\d{4}-\d{2}-\d{2}T/);
		assert.deepEqual(recorded.attempt.parts, [
			{ label: "a", earned: ["a1", "a2"] },
			{ label: "b", earned: ["b1"] },
		]);
		assert.deepEqual(recorded.topics, [
			{ topicId: "t_limits", result: "correct" },
			{ topicId: "t_deriv", result: "correct" },
		]);
		assert.deepEqual(result.details, {
			questionId: "gen-call_gen",
			title: "Cooling model",
			earned: 3,
			total: 3,
			parts: [
				{ label: "a", earned: 2, total: 2, topicText: "1.1 Introducing Calculus", outcome: "earned" },
				{ label: "b", earned: 1, total: 1, topicText: "2.1 Definition of the Derivative", outcome: "earned" },
			],
		});
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /^Cooling model: 3\/3 points\.$/m);
		assert.match(text, /^\(a\) 2\/2$/m);
		assert.match(text, /^\(b\) 1\/1$/m);
		assert.match(text, /^Topic t_limits is now solid\.$/m);
		assert.match(text, /^Overall readiness: 100% \(2\/2 points solid\)\.$/m);
	});

	it("records a partial grading: a missed part folds its topic to wrong", async () => {
		const h = harness({ sitting: FRQ, generated: GENERATED() });
		const result = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [
				{ label: "a", earned: ["a1"] },
				{ label: "b", earned: [] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		assert.deepEqual(h.attempts.records[0]!.topics, [
			{ topicId: "t_limits", result: "wrong" },
			{ topicId: "t_deriv", result: "wrong" },
		]);
		const details = result.details as { earned: number; parts: Array<{ outcome: string }> };
		assert.equal(details.earned, 1);
		assert.deepEqual(details.parts.map((part) => part.outcome), ["missed", "missed"]);
	});

	it("folds two parts sharing a topic to one result per topic", async () => {
		const shared = genInput({
			parts: [
				{
					label: "a",
					prompt: "First.",
					topicId: "t_limits",
					answer: "A.",
					points: ["A point."],
				},
				{
					label: "b",
					prompt: "Second.",
					topicId: "t_limits",
					answer: "B.",
					points: ["B point."],
				},
			],
		});
		const h = harness({
			sitting: FRQ,
			generated: [{ toolCallId: "call_gen", input: shared, answered: true }],
		});
		const result = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [
				{ label: "a", earned: ["a1"] },
				{ label: "b", earned: [] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		assert.deepEqual(h.attempts.records[0]!.topics, [{ topicId: "t_limits", result: "wrong" }]);
	});

	it("records a part testing a topic outside the sitting's scope anyway", async () => {
		const h = harness({ sitting: TOPIC_LIMITS, generated: GENERATED() });
		const result = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		assert.deepEqual(h.attempts.records[0]!.topics, [
			{ topicId: "t_limits", result: "correct" },
			{ topicId: "t_deriv", result: "correct" },
		]);
	});

	it("fills every part with nothing earned when the learner did not know", async () => {
		const h = harness({ sitting: FRQ, generated: GENERATED() });
		const result = await h.tools.ap_record_gen!.execute("call_r", { dontKnow: true } as never);
		assert.equal(result.isError, undefined);
		const recorded = h.attempts.records[0]!;
		assert.equal(recorded.attempt.dontKnow, true);
		assert.deepEqual(recorded.attempt.parts, [
			{ label: "a", earned: [] },
			{ label: "b", earned: [] },
		]);
		assert.deepEqual(recorded.topics, [
			{ topicId: "t_limits", result: "dontKnow" },
			{ topicId: "t_deriv", result: "dontKnow" },
		]);
		const details = result.details as { earned: number; total: number; parts: Array<{ outcome: string }> };
		assert.equal(details.earned, 0);
		assert.equal(details.total, 3);
		assert.deepEqual(details.parts.map((part) => part.outcome), ["missed", "missed"]);
	});

	it("still validates supplied parts when the learner did not know", async () => {
		const h = harness({ sitting: FRQ, generated: GENERATED() });
		const result = await h.tools.ap_record_gen!.execute("call_r", {
			dontKnow: true,
			parts: [{ label: "a", earned: ["a9"] }],
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), [
			'point "a9" is not a rubric point of part "a"',
			'part "b" is missing',
		]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES a bad point id and a missing part with the shared attemptProblems messages", async () => {
		const h = harness({ sitting: FRQ, generated: GENERATED() });
		const unknownPoint = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [
				{ label: "a", earned: ["a1", "a2", "a9"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(unknownPoint.isError, true);
		assert.deepEqual(problemsOf(unknownPoint), ['point "a9" is not a rubric point of part "a"']);

		const missing = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [{ label: "a", earned: ["a1", "a2"] }],
		} as never);
		assert.equal(missing.isError, true);
		assert.deepEqual(problemsOf(missing), ['part "b" is missing']);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES an attempt the saved course record already holds for this chat", async () => {
		const course = courseOf({
			realAttempts: [
				{
					questionId: "gen-call_gen",
					chatId: "chat_now",
					at: "2026-11-15T01:00:00.000Z",
					parts: [],
				},
			],
		});
		const h = harness({ course, sitting: FRQ, generated: GENERATED() });
		const result = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["that question is already recorded"]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES a second call back to back in one turn", async () => {
		const h = harness({ sitting: FRQ, generated: GENERATED() });
		const grading = {
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		};
		const first = await h.tools.ap_record_gen!.execute("call_r1", grading as never);
		assert.equal(first.isError, undefined);

		const second = await h.tools.ap_record_gen!.execute("call_r2", grading as never);
		assert.equal(second.isError, true);
		assert.deepEqual(problemsOf(second), ["that question is already recorded"]);
		assert.equal(h.attempts.records.length, 1, "the refused second call writes nothing");
		assert.equal(h.attempts.current().realAttempts?.length, 1);
	});

	it("applies to the newest answered generated question", async () => {
		const first = genInput({ title: "First question" });
		const second = genInput({ title: "Second question" });
		const h = harness({
			sitting: FRQ,
			generated: [
				{ toolCallId: "call_one", input: first, answered: true },
				{ toolCallId: "call_two", input: second, answered: true },
			],
		});
		const result = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		assert.equal(h.attempts.records[0]!.attempt.questionId, "gen-call_two");
		assert.equal((result.details as { title: string }).title, "Second question");
	});

	it("ignores a newer pending pose and records the newest answered one", async () => {
		const h = harness({
			sitting: FRQ,
			generated: [
				{ toolCallId: "call_one", input: genInput({ title: "First question" }), answered: true },
				{ toolCallId: "call_two", input: genInput({ title: "Pending question" }), answered: false },
			],
		});
		const result = await h.tools.ap_record_gen!.execute("call_r", {
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		assert.equal(h.attempts.records[0]!.attempt.questionId, "gen-call_one");
	});
});

// ── ap_progress ─────────────────────────────────────────────────────────────

describe("ap_progress — topics with no unused released question", () => {
	it("lists every queue topic when nothing is indexed, in queue order", async () => {
		const h = harness({ sitting: FRQ, index: null });
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(
			text,
			/^Topics with no unused released question: t_limits · 1\.1 Introducing Calculus; t_deriv · 2\.1 Definition of the Derivative$/m,
		);
		assert.match(text, /^Real questions: none for this scope$/m);
	});

	it("omits a topic an unused released question covers", async () => {
		const h = harness({ sitting: MIXED, index: indexOf(releasedQuestion("2023-1", "t_limits")) });
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(
			text,
			/^Topics with no unused released question: t_deriv · 2\.1 Definition of the Derivative$/m,
		);
		assert.match(
			text,
			/^2023-1 · unused · a→1\.1 Introducing Calculus$/m,
			"the released question still appears in its own block",
		);
	});

	it("omits the line when every queue topic has an unused released question", async () => {
		const h = harness({ sitting: TOPIC_LIMITS, index: indexOf(releasedQuestion("2023-1", "t_limits")) });
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		assert.doesNotMatch((result.content[0] as { text: string }).text, /Topics with no unused released question:/);
	});

	it("caps the line at 20 topics", async () => {
		const points = Array.from({ length: 22 }, (_, index) => topic(`t_${index + 1}`, `Topic ${index + 1}`));
		const course = courseOf({ sections: [{ id: "unit_all", title: "Unit All", points }] });
		const h = harness({ course, sitting: FRQ, index: null });
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		const line = (result.content[0] as { text: string }).text
			.split("\n")
			.find((candidate) => candidate.startsWith("Topics with no unused released question:"))!;
		const listed = line.slice("Topics with no unused released question: ".length).split("; ");
		assert.equal(listed.length, 20);
		assert.equal(listed[0], "t_1 · Topic 1");
		assert.equal(listed[19], "t_20 · Topic 20");
	});

	it("omits the line in a multiple-choice sitting", async () => {
		const h = harness({ sitting: MCQ, index: null });
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		assert.doesNotMatch((result.content[0] as { text: string }).text, /Topics with no unused released question:/);
	});
});