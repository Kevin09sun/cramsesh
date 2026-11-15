/**
 * AP FREE-RESPONSE TOOLS (AP prep stage 2, Task 7): ap_frq, ap_rubric,
 * ap_view_photo, ap_record_frq and ap_retag_part, plus ap_progress's real-
 * question block and the record derivations answeredFrq / answeredFrqCount.
 *
 * Hermetic: fakes stand in for the course store, the index store and the
 * papers folder; real tiny PDFs stand in for the released paper (the rubric's
 * question text is extracted for real). Refusals never touch a mutating port.
 *
 * The gating law: a released question is posed only in an frq/mixed sitting
 * and only from the index; its rubric is available only after the learner has
 * answered it; a grading is recorded once per answer and follows the shared
 * attemptProblems rule; a pending question cannot be retagged.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";

import { applyResult } from "../src/core/test-prep.ts";
import type { AnswerResult } from "../src/core/test-prep.ts";
import type { ApCourseRecord, ApDocument, ApSitting } from "../src/core/ap.ts";
import type { ApQuestionIndex, ApRealAttempt, ApRealQuestion } from "../src/core/ap-frq.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import {
	AP_SCORING_GUIDELINE_REFUSAL,
	apTools,
	answeredFrqCountFrom,
	answeredFrqFrom,
	createApViewPhotoTool,
	gateScoringGuideline,
	type ApAttemptsPort,
	type ApCourseStorePort,
	type ApIndexPort,
	type ApPapersPort,
	type ApToolContext,
} from "../src/agent/tools/ap.ts";
import type { ReadModel } from "../src/agent/tools/read.ts";
import { MAX_LEARNER_IMAGE_BYTES } from "../src/agent/tools/learner-image-dimensions.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const PAPERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-frq-tools-papers-"));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-frq-tools-"));

after(() => {
	fs.rmSync(PAPERS_DIR, { recursive: true, force: true });
	fs.rmSync(SCRATCH, { recursive: true, force: true });
});

const PAGE_TEXT = "Evaluate the definite integral. Show the substitution and change the limits of integration.";

function writePaper(file: string, text = PAGE_TEXT): void {
	fs.writeFileSync(path.join(PAPERS_DIR, file), tinyPdf([{ runs: [{ text, x: 36, y: 720 }] }]));
}
writePaper("frq-2023.pdf");
writePaper("scoring-2023.pdf", "Award one point for the substitution.");
writePaper("ced.pdf", "The course and exam description.");

function frqDoc(year = 2023): ApDocument {
	return {
		id: `frq-${year}`,
		kind: "frq",
		label: `${year} FRQ`,
		year,
		url: "",
		file: `frq-${year}.pdf`,
		pages: 1,
	};
}

function scoringDoc(year = 2023): ApDocument {
	return {
		id: `scoring-${year}`,
		kind: "scoring",
		label: `${year} Scoring`,
		year,
		url: "",
		file: `scoring-${year}.pdf`,
		pages: 1,
	};
}

const CED: ApDocument = {
	id: "ced",
	kind: "ced",
	label: "Course and Exam Description",
	url: "https://apcentral.collegeboard.org/ced.pdf",
	file: "ced.pdf",
	pages: 3,
};

function courseOf(overrides: Partial<ApCourseRecord> = {}): ApCourseRecord {
	return {
		id: "ap_course_1",
		title: "AP Calculus BC",
		createdAt: "2026-11-14T00:00:00.000Z",
		updatedAt: "2026-11-14T00:00:00.000Z",
		planConfirmed: true,
		documents: [frqDoc(), scoringDoc()],
		sections: [
			{
				id: "unit_limits",
				title: "Unit 1 Limits",
				points: [
					{
						id: "t_limits",
						text: "1.1 Introducing Calculus",
						source: "p. 12",
						status: "unchecked",
						history: [],
					},
				],
			},
			{
				id: "unit_deriv",
				title: "Unit 2 Derivatives",
				points: [
					{
						id: "t_deriv",
						text: "2.1 Definition of the Derivative",
						source: "p. 30",
						status: "unchecked",
						history: [],
					},
				],
			},
		],
		version: 1,
		...overrides,
	};
}

function questionOf(overrides: Partial<ApRealQuestion> = {}): ApRealQuestion {
	return {
		id: "2023-1",
		paperId: "frq-2023",
		scoringId: "scoring-2023",
		year: 2023,
		number: 1,
		pages: [1],
		scoringPages: [1],
		parts: [
			{
				label: "a",
				topicId: "t_limits",
				points: [
					{ id: "a1", text: "States the substitution." },
					{ id: "a2", text: "Evaluates the integral." },
				],
			},
			{ label: "b", topicId: "t_deriv", points: [{ id: "b1", text: "Justifies the step." }] },
		],
		...overrides,
	};
}

function indexOf(...questions: ApRealQuestion[]): ApQuestionIndex {
	return {
		courseId: "ap_course_1",
		version: 1,
		updatedAt: "2026-11-14T00:00:00.000Z",
		questions,
	};
}

const FRQ: ApSitting = { scope: { type: "weak" }, kind: "frq" };
const MCQ: ApSitting = { scope: { type: "weak" }, kind: "mcq" };

// ── fakes ───────────────────────────────────────────────────────────────────

interface RetagCall {
	courseId: string;
	questionId: string;
	label: string;
	topicId: string | undefined;
}

function fakeIndex(initial: ApQuestionIndex | null, options: { retagError?: string } = {}) {
	let current = initial;
	const retags: RetagCall[] = [];
	const port: ApIndexPort = {
		get: (courseId) => (current?.courseId === courseId ? current : null),
		retagPart: (courseId, questionId, label, topicId) => {
			if (options.retagError) throw new Error(options.retagError);
			const question = current?.questions.find((candidate) => candidate.id === questionId);
			if (!current || !question) throw new Error("unknown question");
			if (!question.parts.some((part) => part.label === label)) throw new Error("unknown part");
			retags.push({ courseId, questionId, label, topicId });
			current = {
				...current,
				questions: current.questions.map((candidate) =>
					candidate.id !== questionId
						? candidate
						: {
								...candidate,
								parts: candidate.parts.map((part) =>
									part.label !== label
										? part
										: topicId === undefined
											? { label: part.label, points: part.points }
											: { ...part, topicId },
								),
							},
				),
			};
		},
		forgetPaper: () => false,
	};
	return { port, retags, current: () => current };
}

interface RecordedAttempt {
	courseId: string;
	attempt: ApRealAttempt;
	topics: Array<{ topicId: string; result: AnswerResult }>;
}

/** The course store and the attempt port share ONE current record — exactly
 *  like production, where ap_record_frq re-reads the course file after the
 *  attempt store wrote it. */
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
						const topic = topics.find((candidate) => candidate.topicId === point.id);
						return topic ? applyResult(point, topic.result, attempt.chatId, attempt.at) : point;
					}),
				})),
				realAttempts: [...(current.realAttempts ?? []), attempt],
			};
			return current;
		},
	};
	return { courses, attempts, records, current: () => current };
}

function fakePapers(options: { absent?: string[] } = {}) {
	const presentCalls: Array<{ courseId: string; file: string }> = [];
	const port: ApPapersPort = {
		dir: () => PAPERS_DIR,
		present: (courseId, file) => {
			presentCalls.push({ courseId, file });
			return !(options.absent ?? []).includes(file);
		},
		download: async () => {
			throw new Error("download is not expected");
		},
		importFile: async () => {
			throw new Error("importFile is not expected");
		},
	};
	return { port, presentCalls };
}

type AnswerState = "answered" | "pending" | "none";

interface HarnessOptions {
	course?: ApCourseRecord;
	sitting?: ApSitting;
	index?: ApQuestionIndex | null;
	absent?: string[];
	retagError?: string;
	answered?: (questionId: string) => AnswerState;
	/** How many real answered poses the record holds; defaults to one when
	 *  `answered` says answered. */
	answeredCount?: (questionId: string) => number;
}

function harness(options: HarnessOptions = {}) {
	const course = options.course ?? courseOf();
	const stores = fakeCourseStores(course);
	const papers = fakePapers(options.absent === undefined ? {} : { absent: options.absent });
	const index = fakeIndex(options.index === undefined ? indexOf(questionOf()) : options.index, {
		...(options.retagError === undefined ? {} : { retagError: options.retagError }),
	});
	const answered = options.answered ?? (() => "none");
	const answeredCount =
		options.answeredCount ?? ((questionId: string) => (answered(questionId) === "answered" ? 1 : 0));
	const ctx: ApToolContext = {
		chatId: "chat_now",
		courseId: course.id,
		courses: stores.courses,
		papers: papers.port,
		index: index.port,
		attempts: stores.attempts,
		answeredFrq: answered,
		answeredFrqCount: answeredCount,
		...(options.sitting === undefined ? {} : { sitting: options.sitting }),
	};
	return {
		ctx,
		course,
		courses: stores.courses,
		papers,
		index,
		attempts: { records: stores.records, current: stores.current },
		tools: apTools(ctx),
	};
}

function problemsOf(result: { details: unknown }): string[] {
	return (result.details as { problems?: string[] }).problems ?? [];
}

// ── the record derivations ──────────────────────────────────────────────────

function assistantCall(id: string, name: string, args: unknown): LhMessage {
	return {
		id: `m_${id}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as unknown as LhMessage;
}

function toolResult(id: string, name: string, details: unknown, isError = false): LhMessage {
	return {
		id: `r_${id}`,
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "" }],
		details,
		isError,
		timestamp: 2,
	} as unknown as LhMessage;
}

describe("answeredFrqFrom and answeredFrqCountFrom", () => {
	const answer = (id: string, questionId = "2023-1") => [
		assistantCall(id, "ap_frq", { questionId }),
		toolResult(id, "ap_frq", { kind: "frq", questionId, parts: [] }),
	];

	it("reports none and counts nothing when no ap_frq call names the question", () => {
		assert.equal(answeredFrqFrom([], "2023-1"), "none");
		const other = [assistantCall("c1", "ap_frq", { questionId: "2023-2" })];
		assert.equal(answeredFrqFrom(other, "2023-1"), "none");
		assert.equal(answeredFrqCountFrom(other, "2023-1"), 0);
	});

	it("reports pending for a posed question with no answer result", () => {
		const messages = [assistantCall("c1", "ap_frq", { questionId: "2023-1" })];
		assert.equal(answeredFrqFrom(messages, "2023-1"), "pending");
		assert.equal(answeredFrqCountFrom(messages, "2023-1"), 0);
	});

	it("reports answered for a real free-response answer result", () => {
		assert.equal(answeredFrqFrom(answer("c1"), "2023-1"), "answered");
		assert.equal(answeredFrqCountFrom(answer("c1"), "2023-1"), 1);
	});

	it("does not count a non-free-response result or the question placeholder", () => {
		for (const details of [{ kind: "quiz" }, { kind: "ask" }, {}, null]) {
			const messages = [assistantCall("c1", "ap_frq", { questionId: "2023-1" }), toolResult("c1", "ap_frq", details)];
			assert.equal(answeredFrqFrom(messages, "2023-1"), "none", JSON.stringify(details));
			assert.equal(answeredFrqCountFrom(messages, "2023-1"), 0, JSON.stringify(details));
		}
	});

	it("treats a dismissed question as none", () => {
		const messages = [
			assistantCall("c1", "ap_frq", { questionId: "2023-1" }),
			toolResult("c1", "ap_frq", { kind: "frq", dismissed: true }),
		];
		assert.equal(answeredFrqFrom(messages, "2023-1"), "none");
		assert.equal(answeredFrqCountFrom(messages, "2023-1"), 0);
	});

	it("counts every answered pose of the question", () => {
		const messages = [...answer("c1"), ...answer("c2")];
		assert.equal(answeredFrqCountFrom(messages, "2023-1"), 2);
	});

	it("keeps an earlier answered pose when a later re-pose is dismissed or errors", () => {
		for (const result of [
			{ details: { kind: "frq", dismissed: true }, isError: false },
			{ details: { tool: "ap_frq", problems: ["refused"] }, isError: true },
		]) {
			const messages = [
				...answer("c1"),
				assistantCall("c2", "ap_frq", { questionId: "2023-1" }),
				toolResult("c2", "ap_frq", result.details, result.isError),
			];
			assert.equal(answeredFrqFrom(messages, "2023-1"), "answered");
			assert.equal(answeredFrqCountFrom(messages, "2023-1"), 1);
		}
	});

	it("reports pending for a re-pose with no result yet", () => {
		const messages = [...answer("c1"), assistantCall("c2", "ap_frq", { questionId: "2023-1" })];
		assert.equal(answeredFrqFrom(messages, "2023-1"), "pending");
		assert.equal(answeredFrqCountFrom(messages, "2023-1"), 1);
	});
});

// ── ap_frq ──────────────────────────────────────────────────────────────────

describe("ap_frq", () => {
	it("REFUSES a blank question id first, without reading the course", async () => {
		const h = harness({ sitting: FRQ });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "   " } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["questionId must not be blank"]);
		assert.equal(h.attempts.records.length, 0);
		assert.equal(h.index.retags.length, 0);
	});

	it("REFUSES before the unit and topic list is confirmed", async () => {
		const h = harness({ course: courseOf({ planConfirmed: false }), sitting: FRQ });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, true);
		assert.match(problemsOf(result)[0]!, /not confirmed/i);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES in the setup session", async () => {
		const h = harness();
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, true);
		assert.match(problemsOf(result)[0]!, /setup session/);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES in a multiple-choice sitting", async () => {
		const h = harness({ sitting: MCQ });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["this sitting is multiple-choice only"]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES an unknown question id", async () => {
		const h = harness({ sitting: FRQ });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-9" } as never);
		assert.equal(result.isError, true);
		assert.equal(problemsOf(result)[0], 'question "2023-9" is not in the question index — use an id from ap_progress');
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES a question with no part tagged to a topic in scope", async () => {
		const outOfScope = questionOf({ id: "2023-2", number: 2, parts: [
			{ label: "a", topicId: "t_deriv", points: [{ id: "a1", text: "A point." }] },
		] });
		const h = harness({ sitting: { scope: { type: "topic", topicId: "t_limits" }, kind: "frq" }, index: indexOf(outOfScope) });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-2" } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["question 2023-2 tests nothing in this sitting's scope"]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES when the paper is not on this computer, naming its label", async () => {
		const h = harness({ sitting: FRQ, absent: ["frq-2023.pdf"] });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), [
			"2023 FRQ is not on this computer — the learner can download it from the course page",
		]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("REFUSES an already answered question while an unused eligible question remains", async () => {
		const used = questionOf({ id: "2023-1", number: 1 });
		const unused = questionOf({ id: "2023-2", number: 2 });
		const course = courseOf({
			realAttempts: [
				{ questionId: "2023-1", chatId: "chat_old", at: "2026-11-14T01:00:00.000Z", parts: [] },
			],
		});
		const h = harness({ course, sitting: FRQ, index: indexOf(used, unused) });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["2023-1 was already answered; ask 2023-2 first"]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("poses without details after a miss earlier in this chat", async () => {
		const course = courseOf({
			sections: courseOf().sections.map((section) => ({
				...section,
				points: section.points.map((point) =>
					point.id === "t_limits"
						? { ...point, history: [{ at: "2026-11-14T01:00:00.000Z", chatId: "chat_now", result: "wrong" as const }] }
						: point,
				),
			})),
		});
		const h = harness({ course, sitting: FRQ });
		const posed = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(posed.isError, undefined);
		assert.equal(posed.terminate, true);
	});

	it("allows a used question again when no unused eligible question remains", async () => {
		const course = courseOf({
			realAttempts: [
				{ questionId: "2023-1", chatId: "chat_old", at: "2026-11-14T01:00:00.000Z", parts: [] },
			],
		});
		const h = harness({ course, sitting: FRQ, index: indexOf(questionOf()) });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
	});

	it("REFUSES a question already answered in this chat while another eligible question remains", async () => {
		const used = questionOf({ id: "2023-1", number: 1 });
		const unused = questionOf({ id: "2023-2", number: 2 });
		const h = harness({
			sitting: FRQ,
			index: indexOf(used, unused),
			// No course attempt yet: the answer lives only in this chat's record.
			answeredCount: (questionId) => (questionId === "2023-1" ? 1 : 0),
		});
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["2023-1 was already answered; ask 2023-2 first"]);
	});

	it("allows a question answered in this chat when every other eligible question is used too", async () => {
		const h = harness({
			sitting: FRQ,
			index: indexOf(questionOf({ id: "2023-1", number: 1 }), questionOf({ id: "2023-2", number: 2 })),
			answeredCount: () => 1,
		});
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, undefined, "nothing unused remains, so the question may be re-posed");
		assert.equal(result.terminate, true);
	});

	it("poses the released question as a pending question and ends the turn", async () => {
		const h = harness({ sitting: FRQ });
		const result = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.match((result.content[0] as { text: string }).text, /Question posed/);
		assert.equal(h.tools.ap_frq!.executionMode, "sequential");
		assert.equal(h.attempts.records.length, 0, "posing records nothing");
		assert.equal(h.index.retags.length, 0);
	});
});

// ── ap_rubric ───────────────────────────────────────────────────────────────

describe("ap_rubric", () => {
	it("REFUSES before the learner has answered", async () => {
		for (const answered of ["none", "pending"] as const) {
			const h = harness({ sitting: FRQ, answered: () => answered });
			const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2023-1" } as never);
			assert.equal(result.isError, true);
			assert.deepEqual(problemsOf(result), [
				"the rubric is available only after the learner has answered this question",
			]);
		}
	});

	it("returns the title, extracted question text, topics, points and scoring guideline after an answer", async () => {
		const h = harness({ sitting: FRQ, answered: () => "answered" });
		const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2023-1" } as never);
		assert.equal(result.isError, undefined);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /^2023 FRQ 1/);
		assert.match(text, /Evaluate the definite integral\./);
		assert.match(text, /^\(a\) topic: 1\.1 Introducing Calculus$/m);
		assert.match(text, /^a1: States the substitution\.$/m);
		assert.match(text, /^a2: Evaluates the integral\.$/m);
		assert.match(text, /^\(b\) topic: 2\.1 Definition of the Derivative$/m);
		assert.match(text, /^b1: Justifies the step\.$/m);
		assert.match(text, /^Scoring guideline text \(pages 1\):$/m);
		assert.match(text, /Award one point for the substitution\./);
		assert.doesNotMatch(text, /^Scoring guideline: scoring-2023\.pdf/m);
		assert.equal(result.details, null, "nothing reaches the UI");
	});

	it("caps the guideline text at 15 pages and says so", async () => {
		fs.writeFileSync(
			path.join(PAPERS_DIR, "scoring-2024.pdf"),
			tinyPdf(Array.from({ length: 16 }, (_, index) => ({ runs: [{ text: `Scoring page ${index + 1}`, x: 36, y: 720 }] }))),
		);
		const scoring: ApDocument = {
			id: "scoring-2024",
			kind: "scoring",
			label: "2024 Scoring",
			year: 2024,
			url: "",
			file: "scoring-2024.pdf",
			pages: 16,
		};
		const course = courseOf({ documents: [frqDoc(), scoring] });
		const question = questionOf({
			id: "2024-1",
			scoringId: "scoring-2024",
			scoringPages: Array.from({ length: 16 }, (_, index) => index + 1),
		});
		const h = harness({ course, sitting: FRQ, answered: () => "answered", index: indexOf(question) });
		const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2024-1" } as never);
		assert.equal(result.isError, undefined);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /^Scoring guideline text \(pages 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15; first 15 pages\):$/m);
		assert.match(text, /Scoring page 15/);
		assert.doesNotMatch(text, /Scoring page 16/);
	});

	it("caps the question's own pages at 15 and says so", async () => {
		fs.writeFileSync(
			path.join(PAPERS_DIR, "frq-2027.pdf"),
			tinyPdf(
				Array.from({ length: 20 }, (_, index) => ({
					runs: [{ text: `Question page ${index + 1}`, x: 36, y: 720 }],
				})),
			),
		);
		const paper: ApDocument = {
			id: "frq-2027",
			kind: "frq",
			label: "2027 FRQ",
			year: 2027,
			url: "",
			file: "frq-2027.pdf",
			pages: 20,
		};
		const course = courseOf({ documents: [paper, scoringDoc()] });
		const question = questionOf({
			id: "2027-1",
			paperId: "frq-2027",
			year: 2027,
			number: 1,
			pages: Array.from({ length: 20 }, (_, index) => index + 1),
		});
		const h = harness({ course, sitting: FRQ, answered: () => "answered", index: indexOf(question) });
		const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2027-1" } as never);
		assert.equal(result.isError, undefined);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /^Question text \(pages 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15; first 15 pages\):$/m);
		assert.match(text, /Question page 15/);
		assert.doesNotMatch(text, /Question page 16/);
	});

	it("caps the whole result at 60,000 characters with every rubric point intact", async () => {
		// A single PDF text run is clipped by extraction to roughly a page
		// width, so the long text is emitted as many runs across 15 pages.
		fs.writeFileSync(
			path.join(PAPERS_DIR, "frq-2028.pdf"),
			tinyPdf(
				Array.from({ length: 15 }, () => ({
					runs: Array.from({ length: 50 }, (_, index) => ({
						text: "word ".repeat(30),
						x: 36,
						y: 720 - index * 12,
					})),
				})),
			),
		);
		const paper: ApDocument = {
			id: "frq-2028",
			kind: "frq",
			label: "2028 FRQ",
			year: 2028,
			url: "",
			file: "frq-2028.pdf",
			pages: 15,
		};
		const course = courseOf({ documents: [paper, scoringDoc()] });
		const question = questionOf({
			id: "2028-1",
			paperId: "frq-2028",
			year: 2028,
			number: 1,
			pages: Array.from({ length: 15 }, (_, index) => index + 1),
		});
		const h = harness({ course, sitting: FRQ, answered: () => "answered", index: indexOf(question) });
		const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2028-1" } as never);
		assert.equal(result.isError, undefined);
		const text = (result.content[0] as { text: string }).text;
		assert.ok(text.length <= 60_000, `the result is capped (was ${text.length} characters)`);
		assert.ok(text.endsWith("[rubric output truncated]"), "a truncated result ends with the fixed line");
		assert.match(text, /^a1: States the substitution\.$/m);
		assert.match(text, /^a2: Evaluates the integral\.$/m);
		assert.match(text, /^b1: Justifies the step\.$/m);
		assert.ok(
			text.indexOf("a1: States the substitution.") < text.indexOf("word word"),
			"the points come before the extracted question text",
		);
	});

	it("says the scoring guideline is missing in one line and continues with the rubric", async () => {
		const h = harness({ sitting: FRQ, answered: () => "answered", absent: ["scoring-2023.pdf"] });
		const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2023-1" } as never);
		assert.equal(result.isError, undefined);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /2023 Scoring is not on this computer — the scoring guideline cannot be read here\./);
		assert.match(text, /^a1: States the substitution\.$/m);
	});

	it("falls back for both unreadable files and still returns the rubric", async () => {
		const paper: ApDocument = {
			id: "frq-2025",
			kind: "frq",
			label: "2025 FRQ",
			year: 2025,
			url: "",
			file: "frq-2025.pdf",
			pages: 1,
		};
		const scoring: ApDocument = {
			id: "scoring-2025",
			kind: "scoring",
			label: "2025 Scoring",
			year: 2025,
			url: "",
			file: "scoring-2025.pdf",
			pages: 1,
		};
		const course = courseOf({ documents: [paper, scoring] });
		const question = questionOf({ id: "2025-1", paperId: "frq-2025", scoringId: "scoring-2025" });
		const h = harness({ course, sitting: FRQ, answered: () => "answered", index: indexOf(question) });
		const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2025-1" } as never);
		assert.equal(result.isError, undefined);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /2025 FRQ could not be read on this computer — the question's text is unavailable\./);
		assert.match(text, /2025 Scoring could not be read on this computer — the scoring guideline text is unavailable\./);
		assert.match(text, /^a1: States the substitution\.$/m);
	});

	it("says the paper is missing in one line and continues with the rubric", async () => {
		const h = harness({ sitting: FRQ, answered: () => "answered", absent: ["frq-2023.pdf"] });
		const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2023-1" } as never);
		assert.equal(result.isError, undefined);
		const text = (result.content[0] as { text: string }).text;
		assert.match(
			text,
			/^2023 FRQ is not on this computer — the question's text cannot be read here\.$/m,
		);
		assert.match(text, /^\(a\) topic: 1\.1 Introducing Calculus$/m);
		assert.match(text, /^Scoring guideline text \(pages 1\):$/m);
		assert.match(text, /Award one point for the substitution\./);
	});

	it("says none for a part with no listed topic", async () => {
		const untagged = questionOf({
			parts: [{ label: "a", points: [{ id: "a1", text: "A point." }] }],
		});
		const h = harness({ sitting: FRQ, answered: () => "answered", index: indexOf(untagged) });
		const result = await h.tools.ap_rubric!.execute("call_r", { questionId: "2023-1" } as never);
		assert.match((result.content[0] as { text: string }).text, /^\(a\) topic: none$/m);
	});
});

// ── ap_view_photo ───────────────────────────────────────────────────────────

const IMAGE_MODEL = { input: ["text", "image"], inputLimits: {} } as unknown as ReadModel;
const TEXT_MODEL = { input: ["text"], inputLimits: {} } as unknown as ReadModel;

function picture(): Buffer {
	const canvas = createCanvas(40, 30);
	canvas.getContext("2d").fillRect(0, 0, 40, 30);
	return canvas.toBuffer("image/png");
}

describe("ap_view_photo", () => {
	it("returns the photo as an image with the fixed caption", async () => {
		const file = path.join(SCRATCH, "work.png");
		fs.writeFileSync(file, picture());
		const tool = createApViewPhotoTool(IMAGE_MODEL);
		const result = await tool.execute("call_v", { path: file } as never);
		assert.equal(result.isError, undefined);
		assert.equal((result.content[0] as { text: string }).text, "Photo of the learner's written work.");
		const image = result.content[1] as { type: string; mimeType: string; data: string };
		assert.equal(image.type, "image");
		assert.match(image.mimeType, /^image\/(png|jpeg)$/);
		assert.ok(image.data.length > 0);
		assert.equal(result.details, null, "nothing reaches the UI");
	});

	it("returns the guard message for a non-image, without an image part", async () => {
		const file = path.join(SCRATCH, "notes.txt");
		fs.writeFileSync(file, "not an image");
		const tool = createApViewPhotoTool(IMAGE_MODEL);
		const result = await tool.execute("call_v", { path: file } as never);
		assert.equal(result.isError, undefined);
		assert.match((result.content[0] as { text: string }).text, /not a supported image/);
		assert.equal(result.content.length, 1);
		assert.equal(result.details, null);
	});

	it("returns the guard message for an oversized file", async () => {
		const file = path.join(SCRATCH, "huge.png");
		fs.writeFileSync(file, "x");
		fs.truncateSync(file, MAX_LEARNER_IMAGE_BYTES + 1);
		const tool = createApViewPhotoTool(IMAGE_MODEL);
		const result = await tool.execute("call_v", { path: file } as never);
		assert.equal(result.isError, undefined);
		assert.match((result.content[0] as { text: string }).text, /exceeds 25 MiB/);
		assert.equal(result.content.length, 1);
	});

	it("returns no image and the fixed note for a text-only model", async () => {
		const file = path.join(SCRATCH, "work-text-model.png");
		fs.writeFileSync(file, picture());
		const tool = createApViewPhotoTool(TEXT_MODEL);
		const result = await tool.execute("call_v", { path: file } as never);
		assert.equal(result.isError, undefined);
		assert.equal(
			(result.content[0] as { text: string }).text,
			"This model cannot see images. Say so, and grade the dictated answer only.",
		);
		assert.equal(result.content.length, 1);
	});
});

// ── ap_record_frq ───────────────────────────────────────────────────────────

describe("ap_record_frq", () => {
	const ANSWERED = () => "answered" as const;

	it("REFUSES a question the learner has not answered in this chat", async () => {
		const h = harness({ sitting: FRQ });
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			parts: [],
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), [
			"the learner has not answered this question in this session — ask it first",
		]);
		assert.equal(h.attempts.records.length, 0);
	});

	it("records one answered pose exactly once — a second call back to back is refused", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED });
		const grading = {
			questionId: "2023-1",
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		};
		const first = await h.tools.ap_record_frq!.execute("call_g", grading as never);
		assert.equal(first.isError, undefined);
		assert.equal(h.attempts.records.length, 1);

		const second = await h.tools.ap_record_frq!.execute("call_g", grading as never);
		assert.equal(second.isError, true);
		assert.deepEqual(problemsOf(second), ["the learner's answer to this question is already recorded"]);
		assert.equal(h.attempts.records.length, 1, "the refused second call writes nothing");
		assert.equal(h.attempts.current().realAttempts?.length, 1);
	});

	it("allows one recording per answered pose of a re-posed question", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED, answeredCount: () => 2 });
		const grading = {
			questionId: "2023-1",
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		};
		assert.equal((await h.tools.ap_record_frq!.execute("call_g1", grading as never)).isError, undefined);
		assert.equal((await h.tools.ap_record_frq!.execute("call_g2", grading as never)).isError, undefined);
		assert.equal(h.attempts.records.length, 2);
	});

	it("REFUSES an invalid grading with the shared attemptProblems messages", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED });
		const missing = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			parts: [{ label: "a", earned: ["a1", "a2"] }],
		} as never);
		assert.equal(missing.isError, true);
		assert.deepEqual(problemsOf(missing), ['part "b" is missing']);

		const unknownPoint = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			parts: [
				{ label: "a", earned: ["a1", "a2", "a9"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(unknownPoint.isError, true);
		assert.deepEqual(problemsOf(unknownPoint), ['point "a9" is not a rubric point of part "a"']);
		assert.equal(h.attempts.records.length, 0, "a refused grading writes nothing");
	});

	it("records a full-marks attempt, folds each topic to correct, and returns the score card details", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED });
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		assert.equal(h.attempts.records.length, 1);
		const recorded = h.attempts.records[0]!;
		assert.equal(recorded.courseId, "ap_course_1");
		assert.equal(recorded.attempt.questionId, "2023-1");
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
			questionId: "2023-1",
			title: "2023 FRQ 1",
			earned: 3,
			total: 3,
			parts: [
				{ label: "a", earned: 2, total: 2, topicText: "1.1 Introducing Calculus", outcome: "earned" },
				{ label: "b", earned: 1, total: 1, topicText: "2.1 Definition of the Derivative", outcome: "earned" },
			],
		});
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /^2023 FRQ 1: 3\/3 points\.$/m);
		assert.match(text, /^\(a\) 2\/2$/m);
		assert.match(text, /^\(b\) 1\/1$/m);
		assert.match(text, /^Topic t_limits is now solid\.$/m);
		assert.match(text, /^Overall readiness: \d+% \(\d+\/\d+ points solid\)\.$/m);
	});

	it("records a partial attempt: a missed part folds its topic to wrong", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED });
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
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
		const shared = questionOf({
			parts: [
				{ label: "a", topicId: "t_limits", points: [{ id: "a1", text: "A." }] },
				{ label: "b", topicId: "t_limits", points: [{ id: "b1", text: "B." }] },
			],
		});
		const h = harness({ sitting: FRQ, answered: ANSWERED, index: indexOf(shared) });
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			parts: [
				{ label: "a", earned: ["a1"] },
				{ label: "b", earned: [] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		assert.deepEqual(h.attempts.records[0]!.topics, [{ topicId: "t_limits", result: "wrong" }]);
	});

	it("records an untagged part as not counted and an out-of-scope topic anyway", async () => {
		const mixed = questionOf({
			parts: [
				{ label: "a", topicId: "t_limits", points: [{ id: "a1", text: "A." }] },
				{ label: "b", topicId: "t_deriv", points: [{ id: "b1", text: "B." }] },
				{ label: "c", points: [{ id: "c1", text: "C." }] },
			],
		});
		const h = harness({
			sitting: { scope: { type: "topic", topicId: "t_limits" }, kind: "frq" },
			answered: ANSWERED,
			index: indexOf(mixed),
		});
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			parts: [
				{ label: "a", earned: ["a1"] },
				{ label: "b", earned: ["b1"] },
				{ label: "c", earned: ["c1"] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		// The out-of-scope topic is still recorded (owner-approved design).
		assert.deepEqual(h.attempts.records[0]!.topics, [
			{ topicId: "t_limits", result: "correct" },
			{ topicId: "t_deriv", result: "correct" },
		]);
		const details = result.details as {
			parts: Array<{ label: string; outcome: string; topicText?: string }>;
		};
		const c = details.parts.find((part) => part.label === "c")!;
		assert.equal(c.outcome, "not counted");
		assert.equal("topicText" in c, false);
	});

	it("records every listed topic as dontKnow when the learner did not know", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED });
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			dontKnow: true,
			parts: [
				{ label: "a", earned: ["a1", "a2"] },
				{ label: "b", earned: ["b1"] },
			],
		} as never);
		assert.equal(result.isError, undefined);
		const recorded = h.attempts.records[0]!;
		assert.equal(recorded.attempt.dontKnow, true);
		assert.deepEqual(recorded.topics, [
			{ topicId: "t_limits", result: "dontKnow" },
			{ topicId: "t_deriv", result: "dontKnow" },
		]);
		const details = result.details as { earned: number; total: number };
		assert.equal(details.earned, 0);
		assert.equal(details.total, 3);
	});

	it("fills every part itself when the learner did not know and parts are omitted", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED });
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			dontKnow: true,
		} as never);
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

	it("still validates given parts when the learner did not know", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED });
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
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
});

// ── ap_retag_part ───────────────────────────────────────────────────────────

describe("ap_retag_part", () => {
	it("REFUSES while the question is on screen", async () => {
		const h = harness({ sitting: FRQ, answered: () => "pending" });
		const result = await h.tools.ap_retag_part!.execute("call_t", {
			questionId: "2023-1",
			part: "a",
			topicId: "t_deriv",
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["a question on screen cannot be retagged — wait for the answer"]);
		assert.equal(h.index.retags.length, 0);
	});

	it("REFUSES a topic id not in the confirmed list", async () => {
		const h = harness({ sitting: FRQ });
		const result = await h.tools.ap_retag_part!.execute("call_t", {
			questionId: "2023-1",
			part: "a",
			topicId: "t_ghost",
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), [
			'topicId "t_ghost" is not in the confirmed list — use an id from the list the learner confirmed',
		]);
		assert.equal(h.index.retags.length, 0);
	});

	it("retags a part in any AP session and reports the new tag", async () => {
		const h = harness();
		const result = await h.tools.ap_retag_part!.execute("call_t", {
			questionId: "2023-1",
			part: "a",
			topicId: "t_deriv",
		} as never);
		assert.equal(result.isError, undefined);
		assert.deepEqual(h.index.retags, [
			{ courseId: "ap_course_1", questionId: "2023-1", label: "a", topicId: "t_deriv" },
		]);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /Part \(a\) of 2023 FRQ 1 is now tagged to 2\.1 Definition of the Derivative\./);
		assert.equal(h.index.current()!.questions[0]!.parts[0]!.topicId, "t_deriv");
	});

	it("clears a tag with an empty topic id", async () => {
		const h = harness();
		const result = await h.tools.ap_retag_part!.execute("call_t", {
			questionId: "2023-1",
			part: "a",
			topicId: "",
		} as never);
		assert.equal(result.isError, undefined);
		assert.deepEqual(h.index.retags, [
			{ courseId: "ap_course_1", questionId: "2023-1", label: "a", topicId: undefined },
		]);
		assert.equal(h.index.current()!.questions[0]!.parts[0]!.topicId, undefined);
		assert.match((result.content[0] as { text: string }).text, /is now untagged\./);
	});

	it("returns the store's refusal as a retryable problem", async () => {
		const h = harness({ retagError: "unknown part" });
		const result = await h.tools.ap_retag_part!.execute("call_t", {
			questionId: "2023-1",
			part: "z",
			topicId: "t_limits",
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["unknown part"]);
	});
});

// ── ap_progress ─────────────────────────────────────────────────────────────

describe("ap_progress — released questions", () => {
	it("shows each document's kind and year and the indexed count", async () => {
		const h = harness({ course: courseOf({ documents: [CED, frqDoc(), scoringDoc()] }) });
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /^ced\.pdf · ced · Course and Exam Description · 3 pages$/m);
		assert.match(text, /^frq-2023\.pdf · frq 2023 · 2023 FRQ · 1 pages$/m);
		assert.match(text, /^scoring-2023\.pdf · scoring 2023 · 2023 Scoring · 1 pages$/m);
		assert.match(text, /^Released questions indexed: 1$/m);
	});

	it("lists up to 20 eligible real questions in an frq sitting", async () => {
		const h = harness({
			sitting: { scope: { type: "topic", topicId: "t_limits" }, kind: "frq" },
			index: indexOf(questionOf()),
		});
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /^Real questions:$/m);
		assert.match(
			text,
			/^2023-1 · unused · a→1\.1 Introducing Calculus; b→2\.1 Definition of the Derivative$/m,
		);
	});

	it("marks a real question's paper missing on this computer", async () => {
		const h = harness({
			sitting: FRQ,
			index: indexOf(questionOf()),
			absent: ["frq-2023.pdf"],
		});
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(
			text,
			/^2023-1 · unused · a→1\.1 Introducing Calculus; b→2\.1 Definition of the Derivative · PAPER MISSING on this computer$/m,
		);
	});

	it("says none for the scope when nothing is eligible", async () => {
		const outOfScope = questionOf({ parts: [
			{ label: "a", topicId: "t_deriv", points: [{ id: "a1", text: "A." }] },
		] });
		const h = harness({
			sitting: { scope: { type: "topic", topicId: "t_limits" }, kind: "mixed" },
			index: indexOf(outOfScope),
		});
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /^Real questions: none for this scope$/m);
	});

	it("omits the real-question block in a multiple-choice sitting", async () => {
		const h = harness({ sitting: MCQ, index: indexOf(questionOf()) });
		const result = await h.tools.ap_progress!.execute("call_p", {} as never);
		assert.doesNotMatch((result.content[0] as { text: string }).text, /Real questions:/);
	});
});

// ── the scoring-guideline gate on the AP pdf tools ──────────────────────────

describe("the scoring-guideline gate on the AP pdf tools", () => {
	const REFUSAL = AP_SCORING_GUIDELINE_REFUSAL;

	type PdfToolName = "pdf_info" | "pdf_extract" | "pdf_search";
	const PDF_TOOLS: PdfToolName[] = ["pdf_info", "pdf_extract", "pdf_search"];

	function inputFor(tool: PdfToolName, file: string) {
		return tool === "pdf_info"
			? { path: file }
			: tool === "pdf_extract"
				? { path: file, pages: "1" }
				: { path: file, query: "Evaluate" };
	}

	it("REFUSES every spelling of the scoring guideline before AND after an answer", async () => {
		for (const answered of [() => "none" as const, () => "answered" as const]) {
			for (const file of ["SCORING-2023.PDF", "scoring-2023.pdf.", "./scoring-2023.pdf"]) {
				for (const name of PDF_TOOLS) {
					const h = harness({ sitting: FRQ, answered });
					const result = await h.tools[name]!.execute("call_pdf", inputFor(name, file) as never);
					assert.equal(result.isError, true, `${name} ${file}`);
					assert.deepEqual(problemsOf(result), [REFUSAL], `${name} ${file}`);
				}
			}
		}
	});

	it("REFUSES an unknown file during a sitting", async () => {
		for (const name of PDF_TOOLS) {
			const h = harness({ sitting: FRQ, answered: () => "answered" });
			const result = await h.tools[name]!.execute("call_pdf", inputFor(name, "mystery.pdf") as never);
			assert.equal(result.isError, true, name);
			assert.deepEqual(problemsOf(result), [REFUSAL], name);
		}
	});

	it("allows the course description under any spelling and passes the stored name", async () => {
		const course = courseOf({ documents: [CED, frqDoc(), scoringDoc()] });
		for (const name of PDF_TOOLS) {
			const h = harness({ course, sitting: FRQ });
			const result = await h.tools[name]!.execute("call_pdf", inputFor(name, "CED.PDF") as never);
			assert.equal(result.isError, undefined, name);
		}
		const h = harness({ course, sitting: FRQ });
		const seen: string[] = [];
		const probe = gateScoringGuideline(
			{
				name: "pdf_info",
				label: "pdf_info",
				description: "",
				parameters: {},
				execute: async (_toolCallId: string, input: unknown) => {
					seen.push((input as { path: string }).path);
					return { content: [{ type: "text" as const, text: "ok" }], details: null };
				},
			} as never,
			h.ctx,
			"pdf_info",
		);
		const allowed = await probe.execute!("call_p", { path: "CED.PDF" });
		assert.equal(allowed.isError, undefined);
		await probe.execute!("call_p", { path: "./ced.pdf" });
		assert.deepEqual(seen, ["ced.pdf", "ced.pdf"]);
	});

	it("allows a released paper under any spelling", async () => {
		const course = courseOf({ documents: [CED, frqDoc(), scoringDoc()] });
		for (const file of ["frq-2023.pdf", "FRQ-2023.PDF"]) {
			for (const name of PDF_TOOLS) {
				const h = harness({ course, sitting: FRQ });
				const result = await h.tools[name]!.execute("call_pdf", inputFor(name, file) as never);
				assert.equal(result.isError, undefined, `${name} ${file}`);
			}
		}
	});

	it("allows all three in a setup session", async () => {
		for (const name of PDF_TOOLS) {
			const h = harness();
			const result = await h.tools[name]!.execute("call_pdf", inputFor(name, "scoring-2023.pdf") as never);
			assert.equal(result.isError, undefined, name);
			assert.doesNotMatch(JSON.stringify(result.content), /only the course description/, name);
		}
	});

	it("composes with the 15-page cap on pdf_extract", async () => {
		fs.writeFileSync(
			path.join(PAPERS_DIR, "frq-2024.pdf"),
			tinyPdf(Array.from({ length: 16 }, (_, index) => ({ runs: [{ text: `Page ${index + 1}`, x: 36, y: 720 }] }))),
		);
		const paper: ApDocument = {
			id: "frq-2024",
			kind: "frq",
			label: "2024 FRQ",
			year: 2024,
			url: "",
			file: "frq-2024.pdf",
			pages: 16,
		};
		const course = courseOf({ documents: [frqDoc(), scoringDoc(), paper] });
		const h = harness({
			course,
			sitting: FRQ,
			index: indexOf(questionOf({ id: "2024-1", paperId: "frq-2024" })),
		});
		const result = await h.tools.pdf_extract!.execute("call_pdf", {
			path: "frq-2024.pdf",
			pages: "all",
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), [
			"Read at most 15 pages of the course description per call; ask for a specific page range.",
		]);
	});
});
