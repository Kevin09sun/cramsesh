/**
 * THE TEST-PREP TOOLS (test prep, 2026-11-10): the test-prep agent's toolset
 * — `propose_plan` (author the section/point plan for learner review),
 * `test_progress` (readiness + the next queue), `check_point` (pose one
 * short-answer question on a plan point; terminates the turn exactly like
 * recall) and `record_result` (apply the learner's graded outcome), plus the
 * read-only learner-filesystem set.
 *
 * The gating law (Review Focus 1/5): nothing touches a test's plan or
 * progress until the learner has confirmed the plan and the point id exists
 * in it — refusals are retryable tool errors and never call a mutating store
 * method. `check_point` is defined HERE, not beside recall: it needs the
 * test context for the point/plan gate, and the teacher must never carry it.
 *
 * Mechanics-only descriptions (the doctrine ruling, 2026-10-04): what to
 * pass and what happens; the test-prep doctrine lives in the system prompt
 * (prompts/testprep/10-doctrine.md).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { explainInputBase, explainInputProblems } from "../../core/question-core.ts";
import { nextQueue, planProblems, readiness, readinessPercent } from "../../core/test-prep.ts";
import type { AnswerResult, PlanDraftSection, TestRecord } from "../../core/test-prep.ts";
import type { SearchProvider } from "../../core/search.ts";
import type { EnabledTools } from "../../core/pending.ts";
import { invalidInputResult, questionResult } from "../tool-execute.ts";
import { healEncodedArguments, healToolRecord } from "./heal.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { dispatchJob, jobTools, type JobToolContext } from "./jobs.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { comparisonPath, resolvePolicy } from "./file-access.ts";
import { tutorWebTools } from "./web.ts";

/** The storage port this toolset closes over — the three test-record
 *  operations it needs, structurally satisfied by store/tests.ts. The agent
 *  layer never imports store adapters (the ports/factories rule), so the
 *  shape is declared here and the composition root injects the real store. */
export interface TestPrepStore {
	get(id: string): TestRecord | null;
	savePlan(id: string, draft: PlanDraftSection[], confirm: boolean): TestRecord;
	recordResult(id: string, pointId: string, result: AnswerResult, chatId: string): TestRecord;
	/** Record the materials folder a sweep reads (test material sweep). */
	setFolder(id: string, folder: string): TestRecord;
}

/** The record-reading context the gates need (the practice-tools idiom). */
export interface TestPrepToolContext {
	chatId: string;
	testId: string;
	tests: TestPrepStore;
	/** THE RARELY-NEEDED SET (the practice-tools idiom, 2026-11-10): the
	 *  research + pdf + sweep jobs, injected by the composition root. The
	 *  sweep job reads the materials folder and proposes the plan; pdf
	 *  remains for ad-hoc reads. Absent (tests, wiring bugs) = absent from
	 *  the registry. */
	jobs?: JobToolContext;
	/** Direct web tools (2026-11-12): the live search provider seam. Present
	 *  = web_search/web_fetch are registered (behind the settings `web`
	 *  switch); absent = not wired (tests / wiring bug), no web tools. With no
	 *  search key the composition root still passes it and the provider
	 *  resolves null per call, so both tools register — web_fetch works,
	 *  web_search reports search not set up. */
	search?: () => SearchProvider | null;
}

/** Plain-text result (these tools answer the model in prose, not JSON). */
function textResult(text: string): AgentToolResult<string> {
	return { content: [{ type: "text", text }], details: text };
}

/** Readiness from integer counts: the shared count-based rule (100% only
 *  when every point is solid, exact integer percentages never undercount). */
function pct(solid: number, total: number): string {
	return `${readinessPercent(solid, total)}%`;
}

function locatePoint(test: TestRecord, pointId: string) {
	for (const section of test.sections) {
		const point = section.points.find((candidate) => candidate.id === pointId);
		if (point) return { section, point };
	}
	return null;
}

/** The shared pre-write gate (Review Focus 1): the plan must be confirmed
 *  and the point must exist. Empty result = the call may proceed. */
function pointGateProblems(ctx: TestPrepToolContext, pointId: string): string[] {
	const test = ctx.tests.get(ctx.testId);
	if (!test) return [`test "${ctx.testId}" was not found`];
	if (!test.planConfirmed) {
		return [
			"the plan is not confirmed — propose it with propose_plan, then wait for the learner to confirm it before checking or recording points",
		];
	}
	if (!locatePoint(test, pointId)) {
		return [`pointId "${pointId}" is not in the confirmed plan — use an id from the plan the learner confirmed`];
	}
	return [];
}

// ─── propose_plan ───────────────────────────────────────────────────────────

const planPointInputObject = Type.Object({
	id: Type.Optional(
		Type.String({
			description:
				"Optional. Unchanged points keep their progress automatically by matching text (trimmed) — pass ids only when you know them.",
		}),
	),
	text: Type.String({ description: "REQUIRED — one individually testable item." }),
	source: Type.String({
		description: "REQUIRED — the file and page or slide this point came from, so the learner can audit coverage.",
	}),
});

const planSectionInputObject = Type.Object({
	id: Type.Optional(
		Type.String({
			description:
				"Optional. An unchanged section is matched by title (trimmed) without an id; pass ids only when you know them.",
		}),
	),
	title: Type.String({ description: "REQUIRED — the section heading." }),
	points: Type.Array(planPointInputObject, {
		description: "REQUIRED — the individual items this section covers (at least one).",
	}),
});

export const proposePlanInputObject = Type.Object({
	sections: Type.Array(planSectionInputObject, {
		description: "REQUIRED — sections, each with the individual points the test covers.",
	}),
});

export type ProposePlanInput = { sections: PlanDraftSection[] };

function proposePlanTool(ctx: TestPrepToolContext): AgentTool<typeof proposePlanInputObject> {
	return {
		name: "propose_plan",
		label: "propose_plan",
		description:
			"Propose (or revise) the test plan for learner review: sections, each holding " +
			"the individual points the test covers, every point carrying the file and page or slide it came from. " +
			"Validates that every section has a title and at least one point, and that every point has text. Saves the " +
			"plan UNCONFIRMED and ends your move: say nothing further that assumes scope, wait for the learner to review " +
			"and confirm. Call it again whenever the learner asks for changes — including after confirmation; a revision " +
			"is unconfirmed again, so check_point and record_result refuse until the learner confirms it.",
		parameters: proposePlanInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, proposePlanInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = planProblems(input.sections);
			if (problems.length > 0) return invalidInputResult("propose_plan", problems);
			// A missing test is an input problem, not a crash: the store's
			// loadOrThrow would throw out of the tool.
			if (!ctx.tests.get(ctx.testId)) return invalidInputResult("propose_plan", ["test not found"]);
			const saved = ctx.tests.savePlan(ctx.testId, input.sections, false);
			const points = saved.sections.reduce((total, section) => total + section.points.length, 0);
			return textResult(
				`Plan proposed with ${saved.sections.length} section(s) and ${points} point(s). ` +
					"The plan is UNCONFIRMED: end your turn now and wait for the learner to review it — check_point and " +
					"record_result refuse until the learner confirms. If the learner asks for changes, call propose_plan " +
					"again with the revised sections; the revision is unconfirmed again.",
			);
		},
	};
}

// ─── test_progress ──────────────────────────────────────────────────────────

const emptyInputObject = Type.Object({});

function testProgressTool(ctx: TestPrepToolContext): AgentTool<typeof emptyInputObject> {
	return {
		name: "test_progress",
		label: "test_progress",
		description:
			"Report where this test stands: overall readiness and one line per section, then the question queue in " +
			"work order (`pointId · reason · section › point text`, capped at 30 lines). Read-only. Call it at the " +
			"start of every sitting, then work the queue in order.",
		parameters: emptyInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, emptyInputObject) as never,
		executionMode: "sequential",
		execute: async () => {
			const test = ctx.tests.get(ctx.testId);
			if (!test) return invalidInputResult("test_progress", [`test "${ctx.testId}" was not found`]);

			const ready = readiness(test);
			const totals = ready.sections.reduce(
				(acc, section) => ({ solid: acc.solid + section.solid, total: acc.total + section.total }),
				{ solid: 0, total: 0 },
			);
			const lines = [
				`Ready: ${pct(totals.solid, totals.total)} (${totals.solid}/${totals.total} points solid)`,
				...ready.sections.map(
					(section) => `${section.title}: ${pct(section.solid, section.total)} (${section.solid}/${section.total})`,
				),
			];

			const byPoint = new Map<string, { sectionTitle: string; text: string }>();
			for (const section of test.sections) {
				for (const point of section.points) {
					byPoint.set(point.id, { sectionTitle: section.title, text: point.text });
				}
			}
			const queue = nextQueue(test, ctx.chatId).slice(0, 30).map((entry) => {
				const info = byPoint.get(entry.pointId);
				return `${entry.pointId} · ${entry.reason} · ${info?.sectionTitle ?? "?"} › ${info?.text ?? ""}`;
			});
			lines.push("", ...(queue.length > 0 ? ["Queue:", ...queue] : ["Queue: nothing left"]));
			return textResult(lines.join("\n"));
		},
	};
}

// ─── check_point ────────────────────────────────────────────────────────────

export const checkPointInputObject = Type.Object({
	pointId: Type.String({
		description:
			"REQUIRED — the plan point this question checks, exactly as it appears in test_progress. " +
			"Validated against the confirmed plan; an unknown id is rejected.",
	}),
	...explainInputBase.properties,
	// OVERRIDE the inherited explain description: its "shown to him on
	// submit" sentence is false for test prep — the learner sees only the
	// ✓ verdict or the agent's explanation.
	correctAnswer: Type.String({
		description:
			"REQUIRED. The full correct answer in your own words, reasoning included — COMMITTED before the learner " +
			"ever sees the question. The commitment is immutable: when his answer returns, grade it strictly against this " +
			"text — never revise the commitment after seeing his words, and never mark a wrong answer right to be kind. " +
			"The committed answer is NEVER shown to the learner: he sees only a ✓ verdict when right, or your " +
			"explanation when wrong.",
	}),
	// OVERRIDE the inherited explain description: `details` is the VISIBLE
	// channel — after a miss this sitting it carries the explanation.
	details: Type.Optional(
		Type.String({
			description:
				"Optional extra context shown under the question. REQUIRED after a miss this sitting (the point's last " +
				"answer in this chat was wrong or dontKnow): the short explanation, including the right answer — one or " +
				"two sentences. The learner sees it with the fresh question; it is rejected when blank.",
		}),
	),
});

function checkPointTool(ctx: TestPrepToolContext): AgentTool<typeof checkPointInputObject> {
	return {
		name: "check_point",
		label: "check_point",
		description:
			"Ask the learner to EXPLAIN one point from the test plan in his own words — a graded check with NO options: " +
			"he types a free-text answer. THE COMMITMENT RULE: correctAnswer is the FULL correct answer in your own " +
			"words, reasoning included, COMMITTED before he ever sees the question. When his answer returns, grade it " +
			"strictly against the commitment — never revise it after seeing his words. THE COMMITTED ANSWER IS NEVER " +
			"SHOWN TO THE LEARNER: he sees only a ✓ verdict when right, or your explanation when wrong. AFTER A MISS " +
			"(the point's last answer in this sitting was wrong or \"I don't know\") the fresh check_point MUST carry " +
			"the short explanation, including the right answer, in `details` — the learner sees it with the question; " +
			"the call is rejected without it. pointId must name a point in the confirmed plan (validated at call " +
			"time). ONE question per turn: call a single check_point, then end your turn — his answer determines the " +
			"next.",
		parameters: checkPointInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, checkPointInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = pointGateProblems(ctx, input.pointId);
			if (problems.length > 0) return invalidInputResult("check_point", problems);
			const authoring = explainInputProblems(input);
			if (authoring.length > 0) return invalidInputResult("check_point", authoring);
			// THE POST-MISS EXPLANATION (live-testing fix, 2026-11-11): the
			// learner never sees reasoning, so after a miss in THIS sitting the
			// fresh question must carry the explanation on its visible `details`
			// field. Earlier-sitting misses do not gate (a new sitting starts
			// with a clean explanation).
			const test = ctx.tests.get(ctx.testId);
			const located = test ? locatePoint(test, input.pointId) : null;
			const last = located?.point.history.at(-1);
			const missedThisSitting =
				last !== undefined &&
				last.chatId === ctx.chatId &&
				(last.result === "wrong" || last.result === "dontKnow");
			if (missedThisSitting && (input.details ?? "").trim().length === 0) {
				return invalidInputResult("check_point", [
					"after a miss, put the short explanation (including the right answer) in `details` — the learner sees it with the fresh question",
				]);
			}
			return questionResult();
		},
	};
}

// ─── record_result ──────────────────────────────────────────────────────────

export const recordResultInputObject = Type.Object({
	pointId: Type.String({
		description: "REQUIRED — the plan point this outcome belongs to; validated against the confirmed plan.",
	}),
	result: Type.Union([Type.Literal("correct"), Type.Literal("wrong"), Type.Literal("dontKnow")], {
		description:
			"REQUIRED — the graded outcome as a bare word: correct, wrong, or dontKnow. A hint-assisted or " +
			"self-assessed answer is never correct.",
	}),
});

function recordResultTool(ctx: TestPrepToolContext): AgentTool<typeof recordResultInputObject> {
	return {
		name: "record_result",
		label: "record_result",
		description:
			"Record the learner's graded outcome for one plan point. Updates the point's status and returns its new " +
			"status plus overall readiness. Refused before the plan is confirmed and for a point id not in the plan. " +
			"Call it once per check, immediately after grading the learner's answer.",
		parameters: recordResultInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, recordResultInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = pointGateProblems(ctx, input.pointId);
			if (problems.length > 0) return invalidInputResult("record_result", problems);
			const updated = ctx.tests.recordResult(ctx.testId, input.pointId, input.result, ctx.chatId);
			const located = locatePoint(updated, input.pointId);
			const ready = readiness(updated);
			const totals = ready.sections.reduce(
				(acc, section) => ({ solid: acc.solid + section.solid, total: acc.total + section.total }),
				{ solid: 0, total: 0 },
			);
			return textResult(
				`Point ${input.pointId} is now ${located?.point.status ?? "unknown"}.\n` +
					`Overall readiness: ${pct(totals.solid, totals.total)} (${totals.solid}/${totals.total} points solid).`,
			);
		},
	};
}

// ─── sweep_materials (test material sweep) ──────────────────────────────────

export const sweepMaterialsInputObject = Type.Object({
	folder: Type.String({
		// minLength is load-bearing: resolveSourcePath("") means the HOME
		// directory, so an empty string must never reach the resolver.
		minLength: 1,
		description:
			"REQUIRED — the materials folder the learner attached, exactly as they gave it (absolute or home-relative).",
	}),
});

/** Same path, case-insensitively on Windows (where drive casing varies). */
function samePath(a: string, b: string): boolean {
	const left = comparisonPath(a);
	const right = comparisonPath(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const SWEEP_MATERIALS_TEXT =
	"Reading every file in the folder now. End your turn; the plan arrives when the sweep finishes.";

function sweepMaterialsTool(
	ctx: TestPrepToolContext,
	jobs: JobToolContext,
): AgentTool<typeof sweepMaterialsInputObject> {
	return {
		name: "sweep_materials",
		label: "sweep_materials",
		description:
			"Read every file in a materials folder the learner attached and build this test's plan from it. The sweep " +
			"runs in the background; the plan arrives as a new message and is saved UNCONFIRMED for the learner to " +
			"review. Pass the folder exactly as the learner gave it. Refused when this test already has a plan — " +
			"materials added later are read with the Re-sweep folder button on the test page.",
		parameters: sweepMaterialsInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, sweepMaterialsInputObject) as never,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const test = ctx.tests.get(ctx.testId);
			if (!test) return invalidInputResult("sweep_materials", [`test "${ctx.testId}" was not found`]);
			// Review Focus 1: a test with a plan (or a sweep already reading)
			// never starts a second first-sweep over it. The two refusals are
			// distinct so the model tells the learner the right next step.
			if (test.sections.length > 0) {
				return invalidInputResult("sweep_materials", [
					"this test already has a plan — materials added later are read with the Re-sweep folder button on the test page",
				]);
			}
			if (test.sweep?.status === "running") {
				return invalidInputResult("sweep_materials", [
					"a sweep is already running for this test — wait for it to finish",
				]);
			}

			// Empty input would resolve to the home directory (ls's default) —
			// a first sweep must never read the learner's entire home.
			if (!input.folder.trim()) {
				return invalidInputResult("sweep_materials", [
					"folder is required — pass the folder the learner attached",
				]);
			}

			// Same resolution/denial as ls (resolveSourcePath), then the
			// directory must actually be readable.
			let folder: string;
			try {
				folder = resolveSourcePath(input.folder, resolvePolicy());
				// Home or a drive/filesystem root is the same mistake with a
				// non-empty string: refuse it with the same guidance.
				if (samePath(folder, os.homedir()) || samePath(folder, path.parse(folder).root)) {
					return invalidInputResult("sweep_materials", [
						"that is your whole home folder / drive — pass the folder with the test materials",
					]);
				}
				const stat = await fs.stat(folder);
				if (!stat.isDirectory()) throw new Error("not a directory");
				await fs.readdir(folder);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return invalidInputResult("sweep_materials", [
					`folder not found or not a readable directory: ${input.folder} (${reason})`,
				]);
			}

			ctx.tests.setFolder(ctx.testId, folder);
			dispatchJob(jobs, "sweep", toolCallId, SWEEP_MATERIALS_TEXT, { testId: ctx.testId, folder });
			return textResult(SWEEP_MATERIALS_TEXT);
		},
	};
}

// ─── the registry ───────────────────────────────────────────────────────────

/** The test-prep toolset (the test-prep agent's whole registry). */
export function testPrepTools(ctx: TestPrepToolContext, enabled?: EnabledTools): Record<string, AgentTool<any>> {
	// THE RARELY-NEEDED SET (the practice-tools idiom): the research + pdf
	// jobs (demo/visual stay teach-only), absent when no jobs context was
	// injected. The sweep job (below) reads the materials folder to build the
	// initial plan; pdf remains for ad-hoc reads.
	const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
	// healToolRecord — the standard argument heal over the WHOLE registry
	// (the practice/teacher/prober convention). The per-tool prepareArguments
	// above is the composed inner pass; the double heal is idempotent.
	return healToolRecord({
		propose_plan: proposePlanTool(ctx),
		test_progress: testProgressTool(ctx),
		check_point: checkPointTool(ctx),
		record_result: recordResultTool(ctx),
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(jobs?.research ? { research: jobs.research } : {}),
		...(jobs ? { pdf: jobs.pdf! } : {}),
		// The material sweep (test prep, 2026-11-20) runs as a background job:
		// present only when the jobs context is wired, like pdf.
		...(ctx.jobs ? { sweep_materials: sweepMaterialsTool(ctx, ctx.jobs) } : {}),
		// Direct web tools (2026-11-12): the settings `web` switch is the
		// only toggle this registry reads. Absent seam (not wired) = no web
		// tools; with no search key both still register — the provider
		// resolves null per call (web_fetch works, web_search says unset).
		...tutorWebTools(ctx.search, enabled),
	});
}