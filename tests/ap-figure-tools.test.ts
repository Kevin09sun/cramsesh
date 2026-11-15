/**
 * AP FIGURES IN THE TUTOR'S TOOLS (AP prep stage 3, 2026-11-15).
 *
 * The existing drawing job (`visual`) joins the AP tutor's registry; a
 * finished drawing is looked at with `ap_view_figure` and only then may be
 * shown with a multiple-choice question through `ap_mcq`'s `figure`.
 *
 * The gates mirror the rest of the AP tools: a figure id from another chat,
 * an unfinished or failed drawing and an id that names no drawing are
 * retryable refusals, and a ready figure must have been looked at (earlier
 * in this chat's saved record, or earlier in this same turn) before a
 * question may name it. `viewedFiguresFrom` is the pure record derivation
 * the composition root injects, and an AP turn's saved record never keeps
 * the figure image (stage 2's persistTurn rule).
 *
 * The record-facing test runs under an isolated LH_DATA_DIR, set before any
 * config-loading import (the ap-figures discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";

import type { ApCourseRecord, ApSitting } from "../src/core/ap.ts";
import type { AnswerResult, PlanDraftSection } from "../src/core/test-prep.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type {
	ApCourseStorePort,
	ApFiguresPort,
	ApIndexPort,
	ApPapersPort,
	ApToolContext,
} from "../src/agent/tools/ap.ts";
import type { ReadModel } from "../src/agent/tools/read.ts";

// ── the store seam, BEFORE any config-loading import ────────────────────────
// The tools module itself loads no config; teacher-agent does (config.ts
// resolves the data root at import time), so it is imported dynamically with
// the isolated root already in place. Store-touching tests live in
// tests/ap-figure-record.test.ts, which follows the same discipline.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-figure-tools-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { apTools, createApViewFigureTool, viewedFiguresFrom } = await import("../src/agent/tools/ap.ts");
const { createApAgent } = await import("../src/agent/teacher-agent.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

// ── fixtures ────────────────────────────────────────────────────────────────

const COURSE: ApCourseRecord = {
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
			points: [
				{ id: "t_unchecked", text: "1.2 Defining Limits", source: "p. 14", status: "unchecked", history: [] },
			],
		},
	],
	version: 1,
};

function courseOf(overrides: Partial<ApCourseRecord> = {}): ApCourseRecord {
	return { ...COURSE, ...overrides };
}

/** The fixture with the topic carrying one prior attempt by this chat. */
function withLastAttempt(result: AnswerResult, chatId: string): ApCourseRecord {
	return courseOf({
		sections: COURSE.sections.map((section) => ({
			...section,
			points: section.points.map((point) => ({
				...point,
				history: [{ at: "2026-11-15T01:00:00.000Z", chatId, result }],
			})),
		})),
	});
}

function fakeCourses(initial: ApCourseRecord): { courses: ApCourseStorePort; current: () => ApCourseRecord } {
	let current = initial;
	const courses: ApCourseStorePort = {
		get: (id) => (current.id === id ? current : null),
		savePlan: (_id, draft: PlanDraftSection[], confirm) => {
			current = { ...current, planConfirmed: confirm, sections: draft.map((section) => ({
				id: section.id ?? "unit",
				title: section.title,
				points: section.points.map((point) => ({
					id: point.id ?? "topic",
					text: point.text,
					source: point.source,
					status: "unchecked" as const,
					history: [],
				})),
			})) };
			return current;
		},
		recordResult: () => current,
		putDocument: () => current,
	};
	return { courses, current: () => current };
}

function fakePapers(): ApPapersPort {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-figure-tools-papers-"));
	return {
		dir: () => dir,
		present: () => true,
		download: async (_courseId, _url, file) => ({ file, bytes: 0 }),
		importFile: async (_courseId, _sourcePath, file) => ({ file, bytes: 0 }),
	};
}

type FigureState = "ready" | "pending" | "failed" | "unknown";

/** The finished-figure port as a scripted map, recording every lookup. */
function fakeFigures(states: Record<string, FigureState>, png = PNG): {
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
			return png;
		},
	};
	return { figures, stateCalls, pngCalls };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("figure")]);

const EMPTY_INDEX: ApIndexPort = { get: () => null, retagPart: () => {}, forgetPaper: () => false };

const WEAK: ApSitting = { scope: { type: "weak" }, kind: "mcq" };

function ctxOf(
	figures: ApFiguresPort,
	options: { viewed?: ReadonlySet<string>; course?: ApCourseRecord } = {},
): ApToolContext {
	const courses = fakeCourses(options.course ?? courseOf()).courses;
	return {
		chatId: "chat_now",
		courseId: "ap_course_1",
		sitting: WEAK,
		courses,
		papers: fakePapers(),
		index: EMPTY_INDEX,
		attempts: { record: (courseId) => courses.get(courseId)! },
		answeredFrq: () => "none",
		answeredFrqCount: () => 0,
		generatedFrqs: [],
		figures,
		viewedFigures: options.viewed ?? new Set<string>(),
	};
}

const JOBS = { chatId: "chat_now", jobStore: null as never, spawn: (() => {}) as never, searchAvailable: () => false };

const MCQ_INPUT = {
	topicId: "t_unchecked",
	question: "What is the limit of (x² − 1)/(x − 1) as x approaches 1?",
	options: [
		{ label: "0", value: "a" },
		{ label: "2", value: "b" },
		{ label: "1", value: "c" },
		{ label: "Does not exist", value: "d" },
	],
	correctAnswer: "b",
	optionNotes: ["No.", "Yes.", "No.", "No."],
};

const IMAGE_MODEL = { input: ["text", "image"], inputLimits: {} } as unknown as ReadModel;
const TEXT_MODEL = { input: ["text"], inputLimits: {} } as unknown as ReadModel;

const OK_TEXT = "Figure fig_ready, as the learner will see it.";
const TEXT_ONLY = "This model cannot see images, so the figure cannot be checked. Pose the question without a figure.";

function problemsOf(result: { details: unknown }): string[] {
	return (result.details as { problems?: string[] }).problems ?? [];
}

// ── the registry ────────────────────────────────────────────────────────────

describe("apTools and the drawing tool", () => {
	it("registers visual only with a jobs context, and the Settings switch removes it", () => {
		const { figures } = fakeFigures({});
		const ctx = ctxOf(figures);

		const withJobs = apTools({ ...ctx, jobs: JOBS });
		assert.ok(withJobs.visual, "the drawing tool joins the AP registry with a jobs context");
		assert.equal(withJobs.visual!.name, "visual");

		assert.equal(apTools(ctx).visual, undefined, "no jobs context → no drawing tool");

		const off = apTools({ ...ctx, jobs: JOBS }, { visual: false });
		assert.equal(off.visual, undefined, "the Settings switch removes the drawing tool");
		assert.ok(off.ap_mcq, "the rest of the registry is untouched");
	});

	it("registers ap_view_figure in the AP registry", () => {
		const { figures } = fakeFigures({});
		const tools = apTools(ctxOf(figures, { viewed: new Set(["fig_saved"]) }));
		assert.ok(tools.ap_view_figure, "the figure viewer is part of the AP registry");
	});
});

// ── ap_view_figure ──────────────────────────────────────────────────────────

describe("ap_view_figure", () => {
	it("REFUSES a blank figure id", async () => {
		const { figures } = fakeFigures({});
		const result = await apTools(ctxOf(figures)).ap_view_figure!.execute("call_v", { figure: "  " } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result as { details: unknown }), ["figure must not be blank"]);
	});

	it("REFUSES an id that is not a drawing of this session", async () => {
		const { figures } = fakeFigures({});
		const result = await apTools(ctxOf(figures)).ap_view_figure!.execute("call_v", { figure: "fig_other" } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result as { details: unknown }), [
			"figure fig_other is not a figure drawn in this session",
		]);
	});

	it("REFUSES a drawing that is not finished yet", async () => {
		const { figures } = fakeFigures({ fig_pending: "pending" });
		const result = await apTools(ctxOf(figures)).ap_view_figure!.execute("call_v", { figure: "fig_pending" } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result as { details: unknown }), ["figure fig_pending is not finished yet"]);
	});

	it("REFUSES a drawing that could not be drawn", async () => {
		const { figures } = fakeFigures({ fig_failed: "failed" });
		const result = await apTools(ctxOf(figures)).ap_view_figure!.execute("call_v", { figure: "fig_failed" } as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result as { details: unknown }), ["figure fig_failed could not be drawn"]);
	});

	it("returns a ready figure as a PNG with the fixed caption and nothing in details", async () => {
		const scripted = fakeFigures({ fig_ready: "ready" });
		const tool = createApViewFigureTool(scripted.figures, new Set<string>(), IMAGE_MODEL);
		const result = await tool.execute("call_v", { figure: "fig_ready" } as never);

		assert.equal(result.isError, undefined);
		assert.equal((result.content[0] as { text: string }).text, OK_TEXT);
		const image = result.content[1] as { type: string; mimeType: string; data: string };
		assert.equal(image.type, "image");
		assert.equal(image.mimeType, "image/png");
		assert.equal(image.data, PNG.toString("base64"));
		assert.equal(result.details, null, "no card: nothing reaches the UI");
		assert.deepEqual(scripted.stateCalls, ["fig_ready"]);
		assert.deepEqual(scripted.pngCalls, ["fig_ready"]);
	});

	it("returns no image and the fixed note for a text-only model, remembering nothing", async () => {
		const scripted = fakeFigures({ fig_ready: "ready" });
		const viewed = new Set<string>();
		const tool = createApViewFigureTool(scripted.figures, viewed, TEXT_MODEL);
		const result = await tool.execute("call_v", { figure: "fig_ready" } as never);

		assert.equal(result.isError, undefined);
		assert.equal((result.content[0] as { text: string }).text, TEXT_ONLY);
		assert.equal(result.content.length, 1, "no image part");
		assert.equal(result.details, null);
		assert.deepEqual(scripted.pngCalls, [], "nothing is rasterised for a model that cannot see it");
		assert.equal(viewed.size, 0, "the id is NOT remembered as viewed");
	});

	it("returns a rasteriser failure as a normal result and does not remember the id", async () => {
		const figures: ApFiguresPort = {
			state: () => "ready",
			png: async () => {
				throw new Error("the drawing could not be rasterised");
			},
		};
		const tools = apTools(ctxOf(figures));

		const looked = await tools.ap_view_figure!.execute("call_v", { figure: "fig_ready" } as never);
		assert.equal(looked.isError, undefined, "a failed render is a normal result, like ap_view_photo's file errors");
		assert.equal((looked.content[0] as { text: string }).text, "the drawing could not be rasterised");
		assert.equal(looked.content.length, 1, "no image part");

		const question = await tools.ap_mcq!.execute("call_q", { ...MCQ_INPUT, figure: "fig_ready" } as never);
		assert.equal(question.isError, true, "the failed look did not mark the figure viewed");
		assert.deepEqual(problemsOf(question as { details: unknown }), [
			"look at figure fig_ready with ap_view_figure before using it",
		]);
	});
});

// ── ap_mcq and its figure ───────────────────────────────────────────────────

describe("ap_mcq with a figure", () => {
	it("REFUSES an id that is not a drawing of this session", async () => {
		const { figures } = fakeFigures({});
		const result = await apTools(ctxOf(figures)).ap_mcq!.execute("call_q", {
			...MCQ_INPUT,
			figure: "fig_other",
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result as { details: unknown }), [
			"figure fig_other is not a figure drawn in this session",
		]);
	});

	it("REFUSES a drawing that is not finished yet, telling the tutor to ask a question without one", async () => {
		const { figures } = fakeFigures({ fig_pending: "pending" });
		const result = await apTools(ctxOf(figures)).ap_mcq!.execute("call_q", {
			...MCQ_INPUT,
			figure: "fig_pending",
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result as { details: unknown }), [
			"figure fig_pending is not finished yet — ask a question that needs no figure meanwhile",
		]);
	});

	it("REFUSES a drawing that could not be drawn", async () => {
		const { figures } = fakeFigures({ fig_failed: "failed" });
		const result = await apTools(ctxOf(figures)).ap_mcq!.execute("call_q", {
			...MCQ_INPUT,
			figure: "fig_failed",
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result as { details: unknown }), ["figure fig_failed could not be drawn"]);
	});

	it("REFUSES a ready figure the tutor has not looked at", async () => {
		const { figures } = fakeFigures({ fig_ready: "ready" });
		const result = await apTools(ctxOf(figures)).ap_mcq!.execute("call_q", {
			...MCQ_INPUT,
			figure: "fig_ready",
		} as never);
		assert.equal(result.isError, true);
		assert.deepEqual(problemsOf(result as { details: unknown }), [
			"look at figure fig_ready with ap_view_figure before using it",
		]);
	});

	it("accepts a figure viewed earlier in this chat's saved record", async () => {
		const { figures } = fakeFigures({ fig_ready: "ready" });
		const result = await apTools(ctxOf(figures, { viewed: new Set(["fig_ready"]) })).ap_mcq!.execute("call_q", {
			...MCQ_INPUT,
			figure: "fig_ready",
		} as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.details, null);
	});

	it("accepts a figure looked at earlier in this same turn", async () => {
		const { figures } = fakeFigures({ fig_ready: "ready" });
		const tools = apTools(ctxOf(figures));

		const looked = await tools.ap_view_figure!.execute("call_v", { figure: "fig_ready" } as never);
		assert.equal(looked.isError, undefined);

		const result = await tools.ap_mcq!.execute("call_q", { ...MCQ_INPUT, figure: "fig_ready" } as never);
		assert.equal(result.isError, undefined, "the look happened this turn, before the saved record knows");
	});

	it("runs the post-miss diagnosis gate before the figure checks", async () => {
		// The post-miss diagnosis gate runs before the figure state gate.
		const { figures } = fakeFigures({});
		const result = await apTools(
			ctxOf(figures, { course: withLastAttempt("wrong", "chat_now") }),
		).ap_mcq!.execute("call_q", { ...MCQ_INPUT, figure: "fig_other" } as never);
		assert.equal(result.isError, true);
		assert.match(problemsOf(result as { details: unknown })[0]!, /after a miss/);
	});

	it("without a figure behaves exactly as before and consults no figure", async () => {
		const scripted = fakeFigures({});
		const result = await apTools(ctxOf(scripted.figures)).ap_mcq!.execute("call_q", MCQ_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.details, null);
		assert.deepEqual(scripted.stateCalls, [], "no figure → no figure lookup");
		assert.deepEqual(scripted.pngCalls, []);
	});
});

// ── viewedFiguresFrom ───────────────────────────────────────────────────────

function assistantCall(id: string, name: string, args: unknown): LhMessage {
	return {
		id: `m_${id}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as unknown as LhMessage;
}

function toolResult(
	id: string,
	text: string,
	options: { isError?: boolean; image?: boolean; toolName?: string } = {},
): LhMessage {
	return {
		id: `m_r_${id}`,
		role: "toolResult",
		toolCallId: id,
		toolName: options.toolName ?? "ap_view_figure",
		content: [
			{ type: "text", text },
			...(options.image ? [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }] : []),
		],
		details: null,
		isError: options.isError ?? false,
		timestamp: 1,
	} as unknown as LhMessage;
}

describe("viewedFiguresFrom", () => {
	it("collects the ids of successful ap_view_figure results", () => {
		const messages = [
			assistantCall("v1", "ap_view_figure", { figure: "fig_one" }),
			toolResult("v1", "Figure fig_one, as the learner will see it.", { image: true }),
			assistantCall("v2", "ap_view_figure", { figure: "fig_two" }),
			toolResult("v2", "Figure fig_two, as the learner will see it.", {
				// The saved record's form: the image replaced by the one note.
				image: false,
			}),
		];
		assert.deepEqual([...viewedFiguresFrom(messages)].sort(), ["fig_one", "fig_two"]);
	});

	it("never counts the text-only-model branch", () => {
		const messages = [
			assistantCall("v1", "ap_view_figure", { figure: "fig_one" }),
			toolResult("v1", TEXT_ONLY),
		];
		assert.equal(viewedFiguresFrom(messages).size, 0);
	});

	it("never counts an errored result", () => {
		const messages = [
			assistantCall("v1", "ap_view_figure", { figure: "fig_one" }),
			toolResult("v1", "Figure fig_one, as the learner will see it.", { isError: true }),
		];
		assert.equal(viewedFiguresFrom(messages).size, 0);
	});

	it("never counts a call without a successful result", () => {
		const messages = [assistantCall("v1", "ap_view_figure", { figure: "fig_one" })];
		assert.equal(viewedFiguresFrom(messages).size, 0);
	});

	it("ignores another tool's result carrying the same text", () => {
		const messages = [
			assistantCall("v1", "read", { path: "figure.png" }),
			toolResult("v1", "Figure fig_one, as the learner will see it.", { toolName: "read" }),
		];
		assert.equal(viewedFiguresFrom(messages).size, 0);
	});
});

// ── the live model binding ──────────────────────────────────────────────────

describe("createApAgent and the figure model", () => {
	it("binds the session model to ap_view_figure: a text-only model gets no image", async () => {
		const faux = createFauxCore({});
		const model = { ...faux.getModel(), input: ["text"] } as never;
		const { figures } = fakeFigures({ fig_ready: "ready" });
		const agent = createApAgent(ctxOf(figures), {
			engine: { model, streamFn: faux.streamSimple } as never,
		});
		const tool = agent.state.tools.find((candidate) => candidate.name === "ap_view_figure")!;
		const result = await tool.execute("call_v", { figure: "fig_ready" } as never);

		assert.equal((result.content[0] as { text: string }).text, TEXT_ONLY);
		assert.equal(result.content.length, 1, "the text-only model receives no image");
	});
});
