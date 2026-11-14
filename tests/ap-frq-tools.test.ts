/**
 * AP FREE-RESPONSE TOOLS (AP prep stage 2, Task 7): ap_frq, ap_rubric,
 * ap_view_photo, ap_record_frq and ap_retag_part, plus ap_progress's real-
 * question block and the record derivations answeredFrq / recordedFrq.
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
	apTools,
	answeredFrqFrom,
	createApViewPhotoTool,
	recordedFrqFrom,
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
writePaper("scoring-2023.pdf");

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
	};
	return { port, retags, current: () => current };
}

function fakeCourses(initial: ApCourseRecord) {
	let current = initial;
	const port: ApCourseStorePort = {
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
	return { port, current: () => current };
}

interface RecordedAttempt {
	courseId: string;
	attempt: ApRealAttempt;
	topics: Array<{ topicId: string; result: AnswerResult }>;
}

function fakeAttempts(initial: ApCourseRecord) {
	let current = initial;
	const records: RecordedAttempt[] = [];
	const port: ApAttemptsPort = {
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
	return { port, records, current: () => current };
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
	recorded?: (questionId: string) => boolean;
}

function harness(options: HarnessOptions = {}) {
	const course = options.course ?? courseOf();
	const courses = fakeCourses(course);
	const papers = fakePapers(options.absent === undefined ? {} : { absent: options.absent });
	const index = fakeIndex(options.index === undefined ? indexOf(questionOf()) : options.index, {
		...(options.retagError === undefined ? {} : { retagError: options.retagError }),
	});
	const attempts = fakeAttempts(course);
	const ctx: ApToolContext = {
		chatId: "chat_now",
		courseId: course.id,
		courses: courses.port,
		papers: papers.port,
		index: index.port,
		attempts: attempts.port,
		answeredFrq: options.answered ?? (() => "none"),
		recordedFrq: options.recorded ?? (() => false),
		...(options.sitting === undefined ? {} : { sitting: options.sitting }),
	};
	return { ctx, course, courses, papers, index, attempts, tools: apTools(ctx) };
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

describe("answeredFrqFrom and recordedFrqFrom", () => {
	it("reports none when no ap_frq call names the question", () => {
		assert.equal(answeredFrqFrom([], "2023-1"), "none");
		const other = [assistantCall("c1", "ap_frq", { questionId: "2023-2" })];
		assert.equal(answeredFrqFrom(other, "2023-1"), "none");
		assert.equal(recordedFrqFrom(other, "2023-1"), false);
	});

	it("reports pending for a posed question with no answer result", () => {
		const messages = [assistantCall("c1", "ap_frq", { questionId: "2023-1" })];
		assert.equal(answeredFrqFrom(messages, "2023-1"), "pending");
		assert.equal(recordedFrqFrom(messages, "2023-1"), false);
	});

	it("reports answered for a non-dismissed answer result", () => {
		const messages = [
			assistantCall("c1", "ap_frq", { questionId: "2023-1" }),
			toolResult("c1", "ap_frq", { kind: "frq", questionId: "2023-1", parts: [] }),
		];
		assert.equal(answeredFrqFrom(messages, "2023-1"), "answered");
	});

	it("treats a dismissed question as none", () => {
		const messages = [
			assistantCall("c1", "ap_frq", { questionId: "2023-1" }),
			toolResult("c1", "ap_frq", { kind: "frq", dismissed: true }),
		];
		assert.equal(answeredFrqFrom(messages, "2023-1"), "none");
		assert.equal(recordedFrqFrom(messages, "2023-1"), false);
	});

	it("reports recorded only after a successful ap_record_frq for that answer", () => {
		const answer = [
			assistantCall("c1", "ap_frq", { questionId: "2023-1" }),
			toolResult("c1", "ap_frq", { kind: "frq", questionId: "2023-1", parts: [] }),
		];
		assert.equal(recordedFrqFrom(answer, "2023-1"), false);
		const recorded = [
			...answer,
			assistantCall("c2", "ap_record_frq", { questionId: "2023-1", parts: [] }),
			toolResult("c2", "ap_record_frq", { questionId: "2023-1" }),
		];
		assert.equal(recordedFrqFrom(recorded, "2023-1"), true);
		const failed = [
			...answer,
			assistantCall("c2", "ap_record_frq", { questionId: "2023-1", parts: [] }),
			toolResult("c2", "ap_record_frq", { tool: "ap_record_frq", problems: ["part \"b\" is missing"] }, true),
		];
		assert.equal(recordedFrqFrom(failed, "2023-1"), false);
		const otherQuestion = [
			...answer,
			assistantCall("c2", "ap_record_frq", { questionId: "2023-2", parts: [] }),
			toolResult("c2", "ap_record_frq", { questionId: "2023-2" }),
		];
		assert.equal(recordedFrqFrom(otherQuestion, "2023-1"), false);
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

	it("requires details after a miss earlier in this chat", async () => {
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
		const refused = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(refused.isError, true);
		assert.match(problemsOf(refused)[0]!, /after a miss, put the short explanation/i);

		const posed = await h.tools.ap_frq!.execute("call_q", {
			questionId: "2023-1",
			details: "The substitution is u = x², not x.",
		} as never);
		assert.equal(posed.isError, undefined);
	});

	it("requires details when one attempt's topics disagree (any non-correct counts)", async () => {
		const at = "2026-11-14T01:00:00.000Z";
		const course = courseOf({
			sections: courseOf().sections.map((section) => ({
				...section,
				points: section.points.map((point) => ({
					...point,
					history: [
						{
							at,
							chatId: "chat_now",
							result: point.id === "t_limits" ? ("correct" as const) : ("wrong" as const),
						},
					],
				})),
			})),
		});
		const h = harness({ course, sitting: FRQ });
		const refused = await h.tools.ap_frq!.execute("call_q", { questionId: "2023-1" } as never);
		assert.equal(refused.isError, true);
		assert.match(problemsOf(refused)[0]!, /after a miss, put the short explanation/i);
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
		assert.match(text, /^Scoring guideline: scoring-2023\.pdf, pages 1$/m);
		assert.equal(result.details, null, "nothing reaches the UI");
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
		assert.match(text, /^Scoring guideline: scoring-2023\.pdf, pages 1$/m);
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

	it("REFUSES a second record for the same answer", async () => {
		const h = harness({ sitting: FRQ, answered: ANSWERED, recorded: () => true });
		const result = await h.tools.ap_record_frq!.execute("call_g", {
			questionId: "2023-1",
			parts: [],
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result), ["the learner's answer to this question is already recorded"]);
		assert.equal(h.attempts.records.length, 0);
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