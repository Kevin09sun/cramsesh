/**
 * THE AP TOOLS (AP prep stage 1, 2026-11-13): the AP tutor's toolset —
 * `ap_save_document` (store the official College Board course description,
 * released free-response papers and their scoring guidelines),
 * the three pdf readers over the course's local papers folder,
 * `propose_units` (author the unit/topic list for learner review),
 * `ap_progress` (session kind, readiness, documents, the scoped queue),
 * `ap_mcq` (pose one multiple-choice question; terminates the turn exactly
 * like recall) and `ap_record_result` (apply the graded outcome), plus the
 * read-only learner-filesystem set.
 *
 * The gating law mirrors Test prep's Review Focus 1/5: nothing asks a
 * question or records a result until the learner has confirmed the unit and
 * topic list, the session is a practice sitting, and the topic id is inside
 * the sitting's scope — refusals are retryable tool errors and never call a
 * mutating store method. The committed answer and option notes stay hidden:
 * the app never marks an answer, the tutor's reply is the verdict.
 *
 * Mechanics-only descriptions (the doctrine ruling): the AP method lives in
 * the system prompt (prompts/ap/).
 */

import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { apFrqInputObject, apMcqInputObject, apMcqInputProblems } from "../../core/question-core.ts";
import { planProblems, readiness, readinessPercent } from "../../core/test-prep.ts";
import type { AnswerResult, PlanDraftSection } from "../../core/test-prep.ts";
import { scopedQueue, sittingLabel, sittingScopeProblem, topicInScope } from "../../core/ap.ts";
import type { ApCourseRecord, ApDocument, ApSitting } from "../../core/ap.ts";
import { apPaperFileName, attemptProblems, eligibleRealQuestions, scoreAttempt } from "../../core/ap-frq.ts";
import { apQuestionTitle } from "../../core/ap-frq.ts";
import type { ApQuestionIndex, ApRealAttempt } from "../../core/ap-frq.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import type { SearchProvider } from "../../core/search.ts";
import type { EnabledTools } from "../../core/pending.ts";
import { invalidInputResult, questionResult, serverExecute } from "../tool-execute.ts";
import { parsePageSpec, pdfExtract, pdfInfo, pdfPageCount } from "../subagents/pdf-ops.ts";
import { loadLearnerImage } from "./learner-image.ts";
import type { ReadModel } from "./read.ts";
import { createPdfReadTools } from "./pdf-read.ts";
import { healEncodedArguments, healToolRecord } from "./heal.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { dispatchJob, jobTools, type JobToolContext } from "./jobs.ts";
import { tutorWebTools } from "./web.ts";

/** The course-storage port this toolset closes over — the four course-record
 *  operations it needs, structurally satisfied by store/ap-courses.ts. The
 *  agent layer never imports store adapters (the ports/factories rule), so
 *  the shape is declared here and the composition root injects the real
 *  store. */
export interface ApCourseStorePort {
	get(id: string): ApCourseRecord | null;
	savePlan(id: string, draft: PlanDraftSection[], confirm: boolean): ApCourseRecord;
	recordResult(id: string, topicId: string, result: AnswerResult, chatId: string): ApCourseRecord;
	putDocument(id: string, doc: ApDocument): ApCourseRecord;
}

/** The local-paper port: the course's folder, presence on this computer, and
 *  the two ways a file arrives — a College Board download or a learner file.
 *  Structurally satisfied by server/ap-papers.ts. */
export interface ApPapersPort {
	dir(courseId: string): string;
	present(courseId: string, file: string): boolean;
	download(courseId: string, url: string, file: string): Promise<{ file: string; bytes: number }>;
	importFile(courseId: string, sourcePath: string, file: string): Promise<{ file: string; bytes: number }>;
}

/** The synced question-index port: read the course's indexed released
 *  questions and correct one part's topic tag. Structurally satisfied by
 *  store/ap-index.ts. */
export interface ApIndexPort {
	get(courseId: string): ApQuestionIndex | null;
	retagPart(courseId: string, questionId: string, label: string, topicId: string | undefined): void;
}

/** The real-attempt port: record one graded free-response attempt and fold
 *  its per-topic outcomes into the course record. Structurally satisfied by
 *  store/ap-courses.ts. */
export interface ApAttemptsPort {
	record(
		courseId: string,
		attempt: ApRealAttempt,
		topics: { topicId: string; result: AnswerResult }[],
	): ApCourseRecord;
}

/** Whether the learner has answered one released question in this chat:
 *  "none" = never posed (or dismissed), "pending" = on screen, "answered" =
 *  the answer result has come back. */
export type ApFrqAnswerState = "answered" | "pending" | "none";

/** The record-reading context the gates need (the practice-tools idiom). */
export interface ApToolContext {
	chatId: string;
	courseId: string;
	/** Absent = the course's setup session. */
	sitting?: ApSitting;
	courses: ApCourseStorePort;
	papers: ApPapersPort;
	/** The synced released-question index. */
	index: ApIndexPort;
	/** The graded free-response attempts (stage 2). */
	attempts: ApAttemptsPort;
	/** Derived from the chat record's messages (answeredFrqFrom). */
	answeredFrq: (questionId: string) => ApFrqAnswerState;
	/** Derived from the chat record's messages (recordedFrqFrom). */
	recordedFrq: (questionId: string) => boolean;
	/** THE RARELY-NEEDED SET (the practice-tools idiom): the research job,
	 *  injected by the composition root. Absent (tests, wiring bugs) = absent
	 *  from the registry. */
	jobs?: JobToolContext;
	/** Direct web tools (2026-11-12): the live search provider seam. Present
	 *  = web_search/web_fetch are registered (behind the settings `web`
	 *  switch); absent = not wired (tests / wiring bug), no web tools. */
	search?: () => SearchProvider | null;
}

/** The course description's fixed identity in stage 1. */
const CED_FILE = "ced.pdf";
const CED_ID = "ced";
const CED_FIRST =
	"save the course description with ap_save_document first — the unit and topic list must come from it";

/** The document kinds ap_save_document stores: the course description plus
 *  stage 2's released papers and their scoring guidelines. */
const DOCUMENT_KINDS = ["ced", "frq", "scoring"] as const;

function isDocumentKind(kind: string): kind is (typeof DOCUMENT_KINDS)[number] {
	return (DOCUMENT_KINDS as readonly string[]).includes(kind);
}

/** A sitting could otherwise replace a saved document — every kind is a
 *  setup-session write, with the description's own stage 1 wording. */
const CED_SITTING_REFUSAL =
	"The course description is saved only in the course's setup session, not during a sitting.";
const RELEASED_SITTING_REFUSAL =
	"Released papers are saved only in a setup or papers session, not during a sitting.";

/** The course description is read a few pages at a time: one pdf_extract call
 *  may resolve to at most this many pages, so a whole 200-page CED cannot
 *  flood the model's context or the saved session. */
export const AP_PDF_EXTRACT_MAX_PAGES = 15;
const AP_PDF_EXTRACT_REFUSAL = `Read at most ${AP_PDF_EXTRACT_MAX_PAGES} pages of the course description per call; ask for a specific page range.`;

/** Plain-text result (these tools answer the model in prose, not JSON). */
function textResult(text: string): AgentToolResult<string> {
	return { content: [{ type: "text", text }], details: text };
}

/** Model-facing prose with NOTHING in details (the rubric must never reach
 *  the UI before grading). */
function proseResult(text: string): AgentToolResult<null> {
	return { content: [{ type: "text", text }], details: null };
}

/** The course document behind a question's paper or scoring id. */
function documentFor(course: ApCourseRecord, id: string): ApDocument | undefined {
	return course.documents.find((document) => document.id === id);
}

/** The local file name a document id names (ids are file names without .pdf). */
function documentFile(course: ApCourseRecord, id: string): string {
	return documentFor(course, id)?.file ?? `${id}.pdf`;
}

/** The human label a question's paper is named by in refusals. */
function documentLabel(course: ApCourseRecord, id: string): string {
	return documentFor(course, id)?.label ?? documentFile(course, id);
}

/** Readiness from integer counts: the shared count-based rule (100% only
 *  when every topic is solid, exact integer percentages never undercount). */
function pct(solid: number, total: number): string {
	return `${readinessPercent(solid, total)}%`;
}

function locateTopic(course: ApCourseRecord, topicId: string) {
	for (const unit of course.sections) {
		const topic = unit.points.find((candidate) => candidate.id === topicId);
		if (topic) return { unit, topic };
	}
	return null;
}

/** The shared pre-write gate (Review Focus 1): the course must exist, its
 *  unit and topic list must be confirmed, and the session must be a practice
 *  sitting. Empty result = the call may proceed. */
function listingGateProblems(course: ApCourseRecord | null, sitting: ApSitting | undefined, courseId: string): string[] {
	if (!course) return [`course "${courseId}" was not found`];
	if (!course.planConfirmed) {
		return [
			"the unit and topic list is not confirmed — propose it with propose_units, then wait for the learner to confirm it before asking or recording questions",
		];
	}
	if (!sitting) {
		return [
			"this is the setup session — questions are asked in a practice sitting started from the course page",
		];
	}
	return [];
}

/** The topic half of the same gate: it must exist in the confirmed list and
 *  fall inside the sitting's scope. */
function topicGateProblems(course: ApCourseRecord, sitting: ApSitting, topicId: string): string[] {
	if (!locateTopic(course, topicId)) {
		return [`topicId "${topicId}" is not in the confirmed list — use an id from the list the learner confirmed`];
	}
	if (!topicInScope(course, sitting.scope, topicId)) {
		return [`topicId "${topicId}" is outside this sitting's scope`];
	}
	return [];
}

/** Has the learner missed a question in this chat? The store-derived rule
 *  ap_mcq uses for one topic, widened to the whole course record: the latest
 *  graded history entry in this chat decides, and anything other than
 *  "correct" (wrong or "I don't know") is a miss. A free-response attempt
 *  writes one history entry per tagged topic, so any topic of that attempt
 *  other than correct counts. */
function missedThisChat(course: ApCourseRecord, chatId: string): boolean {
	let latestAt: string | null = null;
	let latestResults: AnswerResult[] = [];
	for (const unit of course.sections) {
		for (const topic of unit.points) {
			const last = topic.history.at(-1);
			if (!last || last.chatId !== chatId) continue;
			if (latestAt === null || last.at > latestAt) {
				latestAt = last.at;
				latestResults = [last.result];
			} else if (last.at === latestAt) {
				// One attempt writes the same `at` for every topic it covered;
				// ANY of its topics other than correct is a miss.
				latestResults.push(last.result);
			}
		}
	}
	return latestResults.some((result) => result !== "correct");
}

// ─── the answered/recorded derivations ──────────────────────────────────────

interface FrqCall {
	toolCallId: string;
	questionId: string | null;
	messageIndex: number;
}

function frqCalls(messages: readonly LhMessage[], toolName: string): FrqCall[] {
	const calls: FrqCall[] = [];
	messages.forEach((message, messageIndex) => {
		if (message.role !== "assistant") return;
		for (const part of message.content) {
			if (part.type !== "toolCall" || part.name !== toolName) continue;
			const args = part.arguments as { questionId?: unknown } | undefined;
			calls.push({
				toolCallId: part.id,
				questionId: typeof args?.questionId === "string" ? args.questionId : null,
				messageIndex,
			});
		}
	});
	return calls;
}

interface FrqResult {
	messageIndex: number;
	isError: boolean;
	details: unknown;
}

function frqResult(messages: readonly LhMessage[], toolCallId: string): FrqResult | null {
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]!;
		if (message.role === "toolResult" && message.toolCallId === toolCallId) {
			return { messageIndex, isError: message.isError === true, details: message.details };
		}
	}
	return null;
}

function isDismissed(details: unknown): boolean {
	return typeof details === "object" && details !== null && (details as { dismissed?: unknown }).dismissed === true;
}

/** The last pose of this question, and what became of it. */
function lastAnswer(messages: readonly LhMessage[], questionId: string): {
	call: FrqCall;
	result: FrqResult | null;
} | null {
	const call = frqCalls(messages, "ap_frq")
		.filter((candidate) => candidate.questionId === questionId)
		.at(-1);
	return call === undefined ? null : { call, result: frqResult(messages, call.toolCallId) };
}

/** "answered" | "pending" | "none" for one released question, from the chat
 *  record's native messages. A refused pose and a dismissal pose nothing, so
 *  both read "none". */
export function answeredFrqFrom(messages: readonly LhMessage[], questionId: string): ApFrqAnswerState {
	const answer = lastAnswer(messages, questionId);
	if (!answer) return "none";
	if (!answer.result) return "pending";
	if (answer.result.isError || isDismissed(answer.result.details)) return "none";
	return "answered";
}

/** True once a successful ap_record_frq for this question's answer is in the
 *  record. A refused grading does not count. */
export function recordedFrqFrom(messages: readonly LhMessage[], questionId: string): boolean {
	const answer = lastAnswer(messages, questionId);
	if (!answer?.result || answer.result.isError || isDismissed(answer.result.details)) return false;
	return frqCalls(messages, "ap_record_frq").some((call) => {
		if (call.questionId !== questionId || call.messageIndex <= answer.result!.messageIndex) return false;
		const result = frqResult(messages, call.toolCallId);
		return result !== null && !result.isError;
	});
}

// ─── ap_save_document ───────────────────────────────────────────────────────

const apSaveDocumentInputObject = Type.Object({
	kind: Type.String({
		description:
			'REQUIRED — the document kind: "ced" (the Course and Exam Description), "frq" (a released ' +
			'free-response paper) or "scoring" (a released paper\'s scoring guideline). "frq" and "scoring" ' +
			"require a year (1990–2100) and may take a set (1–9).",
	}),
	label: Type.String({ description: "REQUIRED — a human label, e.g. \"Course and Exam Description (2026)\"." }),
	year: Type.Optional(
		Type.Integer({
			description:
				'The document\'s edition year. REQUIRED for "frq" and "scoring" (1990–2100); optional for the ' +
				"course description.",
		}),
	),
	set: Type.Optional(
		Type.Integer({
			description:
				'Optional. The released paper\'s set number (1–9) when that year has several sets; only for "frq" ' +
				'and "scoring".',
		}),
	),
	url: Type.Optional(
		Type.String({
			description:
				"An official College Board link to the PDF. Pass exactly one of url or path — never both, never neither.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"A local PDF path the learner attached. Pass exactly one of url or path — never both, never neither.",
		}),
	),
});

function apSaveDocumentTool(ctx: ApToolContext): AgentTool<typeof apSaveDocumentInputObject> {
	return {
		name: "ap_save_document",
		label: "ap_save_document",
		description:
			"Save an official AP document into the course's local papers folder — from a College Board `url` or " +
			'from a learner file `path` (exactly one). Kinds: "ced" (the Course and Exam Description), "frq" (a ' +
			'released free-response paper) and "scoring" (its scoring guideline); "frq" and "scoring" require a ' +
			"four-digit `year` (1990–2100) and may take a `set` (1–9), and their file name is built from them. " +
			"Returns the stored file name and page count; pdf_info, pdf_extract and pdf_search read it by that " +
			"file name. A refused download returns the reason as a retryable error.",
		parameters: apSaveDocumentInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apSaveDocumentInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if (!isDocumentKind(input.kind)) {
				return invalidInputResult("ap_save_document", [
					`kind "${input.kind}" is not a document kind — use "ced", "frq" or "scoring"`,
				]);
			}
			const kind = input.kind;
			// A sitting could otherwise replace a saved paper and break every
			// topic's source page — every kind is a setup-session write.
			if (ctx.sitting) {
				return invalidInputResult("ap_save_document", [
					kind === "ced" ? CED_SITTING_REFUSAL : RELEASED_SITTING_REFUSAL,
				]);
			}

			// The description keeps stage 1's fixed identity; a released paper
			// or scoring guideline is named and identified by its year and set,
			// so re-saving the same one replaces the document.
			let file: string;
			let id: string;
			if (kind === "ced") {
				file = CED_FILE;
				id = CED_ID;
			} else {
				const year = input.year;
				if (year === undefined || !Number.isInteger(year) || year < 1990 || year > 2100) {
					return invalidInputResult("ap_save_document", [
						"year is required for a released paper or scoring guideline",
					]);
				}
				const set = input.set;
				if (set !== undefined && (!Number.isInteger(set) || set < 1 || set > 9)) {
					return invalidInputResult("ap_save_document", ["set must be a whole number from 1 to 9"]);
				}
				file = apPaperFileName(kind, year, set);
				id = file.slice(0, -".pdf".length);
			}

			const hasUrl = typeof input.url === "string" && input.url.trim().length > 0;
			const hasPath = typeof input.path === "string" && input.path.trim().length > 0;
			if (hasUrl === hasPath) {
				return invalidInputResult("ap_save_document", [
					hasUrl
						? "pass exactly one of url or path — not both"
						: "pass one of url or path — a College Board link or a local PDF path",
				]);
			}

			let pages: number;
			try {
				if (hasUrl) await ctx.papers.download(ctx.courseId, input.url!, file);
				else await ctx.papers.importFile(ctx.courseId, input.path!, file);
				// The description keeps the PDF tools' own info function (the page
				// count the learner will see); a released paper only needs the
				// cheap page count.
				const stored = path.join(ctx.papers.dir(ctx.courseId), file);
				pages = kind === "ced" ? (await pdfInfo(stored)).page_count : await pdfPageCount(stored);
			} catch (error) {
				return invalidInputResult("ap_save_document", [
					error instanceof Error ? error.message : String(error),
				]);
			}

			const doc: ApDocument = {
				id,
				kind,
				label: input.label,
				...(input.year !== undefined ? { year: input.year } : {}),
				url: hasUrl ? input.url!.trim() : "",
				file,
				pages,
			};
			ctx.courses.putDocument(ctx.courseId, doc);
			if (kind !== "ced") {
				return textResult(`Saved ${input.label} as ${file} (${pages} page${pages === 1 ? "" : "s"}).`);
			}
			return textResult(
				`Saved ${CED_FILE} (${pages} page${pages === 1 ? "" : "s"}) to this course's papers folder. ` +
					`pdf_info, pdf_extract and pdf_search read it by the file name "${CED_FILE}".`,
			);
		},
	};
}

// ─── propose_units ──────────────────────────────────────────────────────────

const unitTopicInputObject = Type.Object({
	id: Type.Optional(
		Type.String({
			description:
				"Optional. An unchanged topic keeps its progress automatically by matching text (trimmed) — pass ids only when you know them.",
		}),
	),
	text: Type.String({ description: "REQUIRED — one official numbered topic, written as its number and title." }),
	source: Type.String({
		description: "REQUIRED — the course description page this topic came from, so the learner can audit coverage.",
	}),
});

const unitInputObject = Type.Object({
	id: Type.Optional(
		Type.String({
			description:
				"Optional. An unchanged unit is matched by title (trimmed) without an id; pass ids only when you know them.",
		}),
	),
	title: Type.String({ description: "REQUIRED — the unit heading, as the course description writes it." }),
	points: Type.Array(unitTopicInputObject, {
		description: "REQUIRED — the official numbered topics this unit covers (at least one).",
	}),
});

export const proposeUnitsInputObject = Type.Object({
	sections: Type.Array(unitInputObject, {
		description:
			"REQUIRED — the course description's units in its order, each with the numbered topics it covers.",
	}),
});

function proposeUnitsTool(ctx: ApToolContext): AgentTool<typeof proposeUnitsInputObject> {
	return {
		name: "propose_units",
		label: "propose_units",
		description:
			"Propose (or revise) the course's unit and topic list for learner review: units from the course " +
			"description, each holding the official numbered topics it covers, every topic carrying the course " +
			"description page it came from. Validates that every unit has a title and at least one topic, and that " +
			"every topic has text and a source. Refused until the course description has been stored with " +
			"ap_save_document and is present on this computer. Saves the list UNCONFIRMED and ends your move: say " +
			"nothing further that assumes scope, wait for the learner to review and confirm. Call it again whenever " +
			"the learner asks for changes; a revision is unconfirmed again, so ap_mcq and ap_record_result refuse " +
			"until the learner confirms it.",
		parameters: proposeUnitsInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, proposeUnitsInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			// The design's law: the tutor never changes the unit and topic
			// list during practice — that belongs to the setup session or the
			// course page. Refuse before any store call.
			if (ctx.sitting) {
				return invalidInputResult("propose_units", [
					"The unit and topic list changes only in the course's setup session or on the course page, not during a sitting.",
				]);
			}
			const course = ctx.courses.get(ctx.courseId);
			if (!course) return invalidInputResult("propose_units", [`course "${ctx.courseId}" was not found`]);
			const ced = course.documents.find((document) => document.kind === "ced");
			if (!ced || !ctx.papers.present(ctx.courseId, ced.file)) {
				return invalidInputResult("propose_units", [CED_FIRST]);
			}
			const problems = planProblems(input.sections);
			if (problems.length > 0) return invalidInputResult("propose_units", problems);
			const saved = ctx.courses.savePlan(ctx.courseId, input.sections, false);
			const topics = saved.sections.reduce((total, unit) => total + unit.points.length, 0);
			return textResult(
				`Units proposed with ${saved.sections.length} unit(s) and ${topics} topic(s). ` +
					"The list is UNCONFIRMED: end your turn now and wait for the learner to review it — ap_mcq and " +
					"ap_record_result refuse until the learner confirms. If the learner asks for changes, call " +
					"propose_units again with the revised units; the revision is unconfirmed again.",
			);
		},
	};
}

// ─── ap_progress ────────────────────────────────────────────────────────────

const emptyInputObject = Type.Object({});

function apProgressTool(ctx: ApToolContext): AgentTool<typeof emptyInputObject> {
	return {
		name: "ap_progress",
		label: "ap_progress",
		description:
			"Report where this AP course stands: whether this is the setup session or a practice sitting (with its " +
			"scope and question kind), the readiness overall and per unit, the stored documents — each named with " +
			"its kind and year and whether it is present on this computer — the number of released questions " +
			"indexed, and — in a practice sitting — the topic queue in work order " +
			"(`topicId · reason · unit › topic`, capped at 30). In a `frq` or `mixed` sitting it also lists the " +
			"eligible released questions (at most 20) as `<id> · <unused|used> · <part>→<topic>`, marking a paper " +
			"missing on this computer, or says none for this scope. Read-only. Call it at the start of every " +
			"session, then work the queue in order.",
		parameters: emptyInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, emptyInputObject) as never,
		executionMode: "sequential",
		execute: async () => {
			const course = ctx.courses.get(ctx.courseId);
			if (!course) return invalidInputResult("ap_progress", [`course "${ctx.courseId}" was not found`]);

			const sitting = ctx.sitting;
			const lines: string[] = [
				sitting ? `Session: practice — ${sittingLabel(course, sitting)}` : "Session: setup",
			];
			if (sitting) {
				const scopeProblem = sittingScopeProblem(course, sitting.scope);
				if (scopeProblem) lines.push(scopeProblem);
			}
			if (!course.planConfirmed) {
				lines.push(
					"Units and topics: UNCONFIRMED — propose them with propose_units and wait for the learner to confirm before asking questions.",
				);
			}

			const ready = readiness(course);
			const totals = ready.sections.reduce(
				(acc, unit) => ({ solid: acc.solid + unit.solid, total: acc.total + unit.total }),
				{ solid: 0, total: 0 },
			);
			lines.push(`Ready: ${pct(totals.solid, totals.total)} (${totals.solid}/${totals.total} points solid)`);
			for (const unit of ready.sections) {
				lines.push(`${unit.title}: ${pct(unit.solid, unit.total)} (${unit.solid}/${unit.total})`);
			}

			lines.push("", "Documents:");
			for (const document of course.documents) {
				const present = ctx.papers.present(ctx.courseId, document.file);
				const identity = document.year === undefined ? document.kind : `${document.kind} ${document.year}`;
				lines.push(
					present
						? `${document.file} · ${identity} · ${document.label} · ${document.pages ?? 0} pages`
						: `${document.file} · ${identity} · ${document.label} · MISSING on this computer`,
				);
			}
			const index = ctx.index.get(ctx.courseId);
			lines.push(`Released questions indexed: ${index?.questions.length ?? 0}`);

			if (sitting) {
				const byTopic = new Map<string, { unitTitle: string; text: string }>();
				for (const unit of course.sections) {
					for (const topic of unit.points) {
						byTopic.set(topic.id, { unitTitle: unit.title, text: topic.text });
					}
				}
				const queue = scopedQueue(course, sitting.scope, ctx.chatId)
					.slice(0, 30)
					.map((entry) => {
						const info = byTopic.get(entry.pointId);
						return `${entry.pointId} · ${entry.reason} · ${info?.unitTitle ?? "?"} › ${info?.text ?? ""}`;
					});
				lines.push("", ...(queue.length > 0 ? ["Queue:", ...queue] : ["Queue: nothing left"]));

				if (sitting.kind === "frq" || sitting.kind === "mixed") {
					const eligible = eligibleRealQuestions(
						course,
						index,
						sitting.scope,
						ctx.chatId,
						course.realAttempts ?? [],
					);
					if (eligible.length === 0) {
						lines.push("", "Real questions: none for this scope");
					} else {
						const listed = eligible.slice(0, 20).map((entry) => {
							const file = documentFile(course, entry.question.paperId);
							const parts = entry.question.parts.map((part) => {
								const topic = part.topicId === undefined ? undefined : byTopic.get(part.topicId);
								return `${part.label}→${topic?.text ?? "none"}`;
							});
							const missing = ctx.papers.present(ctx.courseId, file)
								? ""
								: " · PAPER MISSING on this computer";
							return `${entry.question.id} · ${entry.used ? "used" : "unused"} · ${parts.join("; ")}${missing}`;
						});
						lines.push("", "Real questions:", ...listed);
					}
				}
			}
			return textResult(lines.join("\n"));
		},
	};
}

// ─── ap_mcq ─────────────────────────────────────────────────────────────────

function apMcqTool(ctx: ApToolContext): AgentTool<typeof apMcqInputObject> {
	return {
		name: "ap_mcq",
		label: "ap_mcq",
		description:
			"Ask one multiple-choice question on one topic in this sitting's scope. Exactly four options, exactly " +
			"one correct. correctAnswer and optionNotes (one line per option: why it is right or the specific error " +
			"that leads to it) are your COMMITMENT, written before the learner answers and never revised; NEITHER " +
			"is shown to the learner, and the app never marks the answer — your next reply is the verdict. topicId " +
			"must name a topic in the confirmed list and inside this sitting's scope. ONE question per turn: pose, " +
			"then end your turn. AFTER A MISS this sitting (the topic's last answer in this chat was wrong or " +
			"\"I don't know\") the fresh question MUST carry the short diagnosis in `details` — the right answer and " +
			"where the thinking went wrong; the call is rejected without it.",
		parameters: apMcqInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apMcqInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const course = ctx.courses.get(ctx.courseId);
			const sitting = ctx.sitting;
			const listingProblems = listingGateProblems(course, sitting, ctx.courseId);
			if (listingProblems.length > 0) return invalidInputResult("ap_mcq", listingProblems);
			// The gates above return only when course and sitting are present.
			const confirmedCourse = course!;
			const confirmedSitting = sitting!;
			const topicProblems = topicGateProblems(confirmedCourse, confirmedSitting, input.topicId);
			if (topicProblems.length > 0) return invalidInputResult("ap_mcq", topicProblems);
			const authoring = apMcqInputProblems(input);
			if (authoring.length > 0) return invalidInputResult("ap_mcq", authoring);
			// THE POST-MISS DIAGNOSIS: after a miss in THIS sitting the fresh
			// question must carry the diagnosis on its visible `details`
			// field. Earlier-sitting misses do not gate.
			const located = locateTopic(confirmedCourse, input.topicId);
			const last = located?.topic.history.at(-1);
			const missedThisSitting =
				last !== undefined &&
				last.chatId === ctx.chatId &&
				(last.result === "wrong" || last.result === "dontKnow");
			if (missedThisSitting && (input.details ?? "").trim().length === 0) {
				return invalidInputResult("ap_mcq", [
					"after a miss, put the short explanation (including the right answer) in `details` — the learner sees it with the fresh question",
				]);
			}
			return questionResult();
		},
	};
}

// ─── ap_frq ─────────────────────────────────────────────────────────────────

function apFrqTool(ctx: ApToolContext): AgentTool<typeof apFrqInputObject> {
	return {
		name: "ap_frq",
		label: "ap_frq",
		description:
			"Pose one REAL released free-response question from the course's synced question index, exactly as " +
			"ap_progress lists it. The question's original paper pages and every part come from the index; " +
			"questionId must be an id from ap_progress. ONE question per turn: pose it, then end your turn; the " +
			"learner answers part by part and may attach photos of written work. AFTER A MISS this chat the fresh " +
			"question MUST carry the short diagnosis in `details` — the call is rejected without it. Refused in the " +
			"setup session, in a multiple-choice sitting, for an unknown id, for a question with no part in this " +
			"sitting's scope, when its paper is not on this computer, and for an already answered question while an " +
			"unused eligible one remains. The rubric is NEVER included here: fetch it with ap_rubric only after the " +
			"learner has answered.",
		parameters: apFrqInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apFrqInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if ((input.questionId ?? "").trim().length === 0) {
				return invalidInputResult("ap_frq", ["questionId must not be blank"]);
			}
			const course = ctx.courses.get(ctx.courseId);
			const sitting = ctx.sitting;
			const listingProblems = listingGateProblems(course, sitting, ctx.courseId);
			if (listingProblems.length > 0) return invalidInputResult("ap_frq", listingProblems);
			const confirmedCourse = course!;
			const confirmedSitting = sitting!;
			if (confirmedSitting.kind === "mcq") {
				return invalidInputResult("ap_frq", ["this sitting is multiple-choice only"]);
			}
			const index = ctx.index.get(ctx.courseId);
			if (!index) {
				return invalidInputResult("ap_frq", [
					"no released questions are indexed — save the released papers and index them with ap_index_papers first",
				]);
			}
			const question = index.questions.find((candidate) => candidate.id === input.questionId);
			if (!question) {
				return invalidInputResult("ap_frq", [
					`question "${input.questionId}" is not in the question index — use an id from ap_progress`,
				]);
			}
			const inScope = question.parts.some(
				(part) => part.topicId !== undefined && topicInScope(confirmedCourse, confirmedSitting.scope, part.topicId),
			);
			if (!inScope) {
				return invalidInputResult("ap_frq", [
					`question ${question.id} tests nothing in this sitting's scope`,
				]);
			}
			const paperFile = documentFile(confirmedCourse, question.paperId);
			if (!ctx.papers.present(ctx.courseId, paperFile)) {
				return invalidInputResult("ap_frq", [
					`${documentLabel(confirmedCourse, question.paperId)} is not on this computer — the learner can download it from the course page`,
				]);
			}
			// The released paper is a one-time question while unused eligible
			// questions remain. Only a used question with nothing else left may
			// be asked again.
			const eligible = eligibleRealQuestions(
				confirmedCourse,
				index,
				confirmedSitting.scope,
				ctx.chatId,
				confirmedCourse.realAttempts ?? [],
			);
			const used = eligible.find((entry) => entry.question.id === question.id)?.used ?? false;
			const nextUnused = eligible.find((entry) => !entry.used && entry.question.id !== question.id);
			if (used && nextUnused) {
				return invalidInputResult("ap_frq", [
					`${question.id} was already answered; ask ${nextUnused.question.id} first`,
				]);
			}
			// THE POST-MISS DIAGNOSIS, widened to the whole course record (see
			// missedThisChat): after a miss in THIS chat the fresh question must
			// carry the diagnosis on its visible `details` field.
			if (missedThisChat(confirmedCourse, ctx.chatId) && (input.details ?? "").trim().length === 0) {
				return invalidInputResult("ap_frq", [
					"after a miss, put the short explanation (including the right answer) in `details` — the learner sees it with the fresh question",
				]);
			}
			return questionResult();
		},
	};
}

// ─── ap_rubric ──────────────────────────────────────────────────────────────

const apRubricInputObject = Type.Object({
	questionId: Type.String({
		description:
			"REQUIRED — the released question the learner just answered, exactly as posed with ap_frq.",
	}),
});

function apRubricTool(ctx: ApToolContext): AgentTool<typeof apRubricInputObject> {
	return {
		name: "ap_rubric",
		label: "ap_rubric",
		description:
			"Read the official rubric of a released free-response question AFTER the learner has answered it: the " +
			"question text (from the paper on this computer), each part with its topic and every scoring point, and " +
			"the scoring guideline file and pages. The learner NEVER sees this — it is grading material only, and " +
			"the answer card stays hidden until ap_record_frq records the grading. Refused before the learner has " +
			"answered this question in this chat (`answeredFrq`).",
		parameters: apRubricInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apRubricInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if ((input.questionId ?? "").trim().length === 0) {
				return invalidInputResult("ap_rubric", ["questionId must not be blank"]);
			}
			// THE SECRECY GATE: no rubric before the answer.
			if (ctx.answeredFrq(input.questionId) !== "answered") {
				return invalidInputResult("ap_rubric", [
					"the rubric is available only after the learner has answered this question",
				]);
			}
			const course = ctx.courses.get(ctx.courseId);
			if (!course) return invalidInputResult("ap_rubric", [`course "${ctx.courseId}" was not found`]);
			const index = ctx.index.get(ctx.courseId);
			const question = index?.questions.find((candidate) => candidate.id === input.questionId);
			if (!question) {
				return invalidInputResult("ap_rubric", [
					`question "${input.questionId}" is not in the question index — use an id from ap_progress`,
				]);
			}

			const lines: string[] = [apQuestionTitle(question)];
			const paperFile = documentFile(course, question.paperId);
			const paperLabel = documentLabel(course, question.paperId);
			if (!ctx.papers.present(ctx.courseId, paperFile)) {
				lines.push("", `${paperLabel} is not on this computer — the question's text cannot be read here.`);
			} else {
				try {
					const extracted = await pdfExtract(
						path.join(ctx.papers.dir(ctx.courseId), paperFile),
						question.pages.join(","),
					);
					lines.push("", extracted.trim());
				} catch {
					lines.push(
						"",
						`${paperLabel} could not be read on this computer — the question's text is unavailable.`,
					);
				}
			}
			for (const part of question.parts) {
				const topic = part.topicId === undefined ? undefined : locateTopic(course, part.topicId)?.topic;
				lines.push("", `(${part.label}) topic: ${topic?.text ?? "none"}`);
				for (const point of part.points) lines.push(`${point.id}: ${point.text}`);
			}
			lines.push(
				"",
				`Scoring guideline: ${documentFile(course, question.scoringId)}, pages ${question.scoringPages.join(", ")}`,
			);
			return proseResult(lines.join("\n"));
		},
	};
}

// ─── ap_view_photo ──────────────────────────────────────────────────────────

const apViewPhotoInputObject = Type.Object({
	path: Type.String({
		description:
			"REQUIRED — the local path of one photo of the learner's written work, exactly as the answer result listed it.",
	}),
});

/** Look at one photo of the learner's written work. The image rides the read
 *  tool's escape hatch (a native image content part); a model that cannot see
 *  images gets one honest sentence instead. Any guard refusal (missing file,
 *  oversized, unsupported format) is returned as a NORMAL result — the tutor
 *  can say so and grade the dictated answer only. `model` is rebound per
 *  engine in teacher-agent.ts, exactly like read. */
export function createApViewPhotoTool(model?: ReadModel): AgentTool<typeof apViewPhotoInputObject> {
	return {
		name: "ap_view_photo",
		label: "ap_view_photo",
		description:
			"Look at one photo of the learner's written free-response work (jpg, png, gif, webp or bmp; at most " +
			"25 MiB). Use it only for a photo the learner's answer result lists. If the file cannot be opened the " +
			"reason is returned as the result — say so and grade the dictated answer only. This model receives the " +
			"image as an attachment when it can see images.",
		parameters: apViewPhotoInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apViewPhotoInputObject) as never,
		executionMode: "sequential",
		execute: serverExecute("ap_view_photo", apViewPhotoInputObject, async ({ path: rawPath }, { signal }) => {
			if (model && !model.input.includes("image")) {
				return { text: "This model cannot see images. Say so, and grade the dictated answer only." };
			}
			try {
				const image = await loadLearnerImage(rawPath, signal);
				return {
					text: "Photo of the learner's written work.",
					images: [{ data: image.data, mimeType: image.mimeType }],
				};
			} catch (error) {
				return { text: error instanceof Error ? error.message : String(error) };
			}
		}),
	};
}

/** The unwrapped tool (teacher-agent rebinds its execute to the live model). */
export const apViewPhotoTool = createApViewPhotoTool();

// ─── ap_record_frq ──────────────────────────────────────────────────────────

const apRecordFrqInputObject = Type.Object({
	questionId: Type.String({
		description: "REQUIRED — the released question the learner answered, exactly as posed with ap_frq.",
	}),
	dontKnow: Type.Optional(
		Type.Boolean({
			description:
				'Set true when the learner said "I don\'t know" instead of attempting the question; every part ' +
				"then scores zero and every tagged topic is recorded as dontKnow.",
		}),
	),
	parts: Type.Array(
		Type.Object({
			label: Type.String({ description: "REQUIRED — one part label from ap_rubric, e.g. \"a\"." }),
			earned: Type.Array(Type.String(), {
				description:
					"REQUIRED — the ids of the rubric points this part earned, exactly as ap_rubric lists them " +
					"(empty when none). An omitted part is refused.",
			}),
		}),
		{
			description:
				"REQUIRED — the grading for EVERY part of the question, point by point against the official rubric. " +
				"A right answer reached by flawed reasoning earns no point.",
		},
	),
});

function apRecordFrqTool(ctx: ApToolContext): AgentTool<typeof apRecordFrqInputObject> {
	return {
		name: "ap_record_frq",
		label: "ap_record_frq",
		description:
			"Record the learner's graded free-response answer point by point against the official rubric, once per " +
			"answer, after ap_rubric. Pass every part with the rubric point ids it earned (or dontKnow). Validates " +
			"the grading with the shared attemptProblems rule, folds each tagged topic to correct/wrong/dontKnow in " +
			"the course record, and returns the score card details for the UI: question id and title, earned/total, " +
			"and one row per part with its outcome (earned, missed, or not counted when the part has no listed " +
			"topic). Refused before the learner has answered this question and when the answer is already recorded.",
		parameters: apRecordFrqInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apRecordFrqInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if ((input.questionId ?? "").trim().length === 0) {
				return invalidInputResult("ap_record_frq", ["questionId must not be blank"]);
			}
			if (ctx.answeredFrq(input.questionId) !== "answered") {
				return invalidInputResult("ap_record_frq", [
					"the learner has not answered this question in this session — ask it first",
				]);
			}
			if (ctx.recordedFrq(input.questionId)) {
				return invalidInputResult("ap_record_frq", [
					"the learner's answer to this question is already recorded",
				]);
			}
			const course = ctx.courses.get(ctx.courseId);
			if (!course) {
				return invalidInputResult("ap_record_frq", [`course "${ctx.courseId}" was not found`]);
			}
			const index = ctx.index.get(ctx.courseId);
			const question = index?.questions.find((candidate) => candidate.id === input.questionId);
			if (!question) {
				return invalidInputResult("ap_record_frq", [
					`question "${input.questionId}" is not in the question index — use an id from ap_progress`,
				]);
			}
			const problems = attemptProblems(question, input.parts);
			if (problems.length > 0) return invalidInputResult("ap_record_frq", problems);

			const knownTopicIds = new Set(
				course.sections.flatMap((unit) => unit.points.map((topic) => topic.id)),
			);
			const attempt: ApRealAttempt = {
				questionId: question.id,
				chatId: ctx.chatId,
				at: new Date().toISOString(),
				...(input.dontKnow ? { dontKnow: true } : {}),
				parts: input.parts.map((part) => ({ label: part.label, earned: [...part.earned] })),
			};
			const score = scoreAttempt(question, attempt, knownTopicIds);
			let updated: ApCourseRecord;
			try {
				updated = ctx.attempts.record(ctx.courseId, attempt, score.topics);
			} catch (error) {
				return invalidInputResult("ap_record_frq", [
					error instanceof Error ? error.message : String(error),
				]);
			}

			const lines: string[] = [`${apQuestionTitle(question)}: ${score.earned}/${score.total} points.`];
			for (const part of score.parts) lines.push(`(${part.label}) ${part.earned}/${part.total}`);
			for (const topic of score.topics) {
				const status = locateTopic(updated, topic.topicId)?.topic.status ?? "unknown";
				lines.push(`Topic ${topic.topicId} is now ${status}.`);
			}
			const ready = readiness(updated);
			const totals = ready.sections.reduce(
				(acc, unit) => ({ solid: acc.solid + unit.solid, total: acc.total + unit.total }),
				{ solid: 0, total: 0 },
			);
			lines.push(
				`Overall readiness: ${pct(totals.solid, totals.total)} (${totals.solid}/${totals.total} points solid).`,
			);

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					questionId: question.id,
					title: apQuestionTitle(question),
					earned: score.earned,
					total: score.total,
					parts: score.parts.map((part) => ({
						label: part.label,
						earned: part.earned,
						total: part.total,
						...(part.topicId === undefined
							? {}
							: { topicText: locateTopic(updated, part.topicId)?.topic.text ?? "none" }),
						outcome: part.topicId === undefined ? "not counted" : part.complete ? "earned" : "missed",
					})),
				},
			};
		},
	};
}

// ─── ap_retag_part ──────────────────────────────────────────────────────────

const apRetagPartInputObject = Type.Object({
	questionId: Type.String({
		description: "REQUIRED — the released question whose part tag is wrong, exactly as ap_progress lists it.",
	}),
	part: Type.String({ description: "REQUIRED — the lettered part to retag, e.g. \"a\"." }),
	topicId: Type.String({
		description:
			'REQUIRED — the confirmed topic id this part really tests, or the empty string "" to remove the tag ' +
			"(the part then counts for no topic). A topic id not in the confirmed list is refused.",
	}),
});

function apRetagPartTool(ctx: ApToolContext): AgentTool<typeof apRetagPartInputObject> {
	return {
		name: "ap_retag_part",
		label: "ap_retag_part",
		description:
			"Correct one part's topic tag in the synced released-question index, at the learner's request: pass the " +
			"confirmed topic id it really tests, or \"\" to remove the tag. Allowed in any AP session (setup or " +
			"sitting), but not while a question is on screen — wait for the answer first. Refused for a topic id " +
			"not in the confirmed list and for an unknown question or part.",
		parameters: apRetagPartInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apRetagPartInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if (ctx.answeredFrq(input.questionId) === "pending") {
				return invalidInputResult("ap_retag_part", [
					"a question on screen cannot be retagged — wait for the answer",
				]);
			}
			const course = ctx.courses.get(ctx.courseId);
			if (!course) return invalidInputResult("ap_retag_part", [`course "${ctx.courseId}" was not found`]);
			const topicId = input.topicId.trim();
			if (topicId.length > 0 && !locateTopic(course, topicId)) {
				return invalidInputResult("ap_retag_part", [
					`topicId "${topicId}" is not in the confirmed list — use an id from the list the learner confirmed`,
				]);
			}
			try {
				ctx.index.retagPart(
					ctx.courseId,
					input.questionId,
					input.part,
					topicId.length > 0 ? topicId : undefined,
				);
			} catch (error) {
				return invalidInputResult("ap_retag_part", [
					error instanceof Error ? error.message : String(error),
				]);
			}
			const question = ctx.index.get(ctx.courseId)?.questions.find((candidate) => candidate.id === input.questionId);
			const title = question ? apQuestionTitle(question) : input.questionId;
			if (topicId.length === 0) {
				return proseResult(`Part (${input.part}) of ${title} is now untagged.`);
			}
			const topicText = locateTopic(course, topicId)?.topic.text ?? topicId;
			return proseResult(`Part (${input.part}) of ${title} is now tagged to ${topicText}.`);
		},
	};
}

// ─── ap_record_result ───────────────────────────────────────────────────────

const apRecordResultInputObject = Type.Object({
	topicId: Type.String({
		description: "REQUIRED — the topic this outcome belongs to; validated against the confirmed list and the sitting's scope.",
	}),
	result: Type.Union([Type.Literal("correct"), Type.Literal("wrong"), Type.Literal("dontKnow")], {
		description:
			"REQUIRED — the graded outcome as a bare word: correct, wrong, or dontKnow. A right option reached by " +
			"flawed reasoning is never correct; neither is a hint-assisted or self-assessed answer.",
	}),
});

function apRecordResultTool(ctx: ApToolContext): AgentTool<typeof apRecordResultInputObject> {
	return {
		name: "ap_record_result",
		label: "ap_record_result",
		description:
			"Record the learner's graded outcome for one topic: correct, wrong, or dontKnow. Updates the topic's " +
			"status and returns it plus overall readiness. Refused in the setup session, before the list is " +
			"confirmed, and for a topic id not in the sitting's scope. Call it once per graded answer, immediately " +
			"after grading.",
		parameters: apRecordResultInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apRecordResultInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const course = ctx.courses.get(ctx.courseId);
			const sitting = ctx.sitting;
			const listingProblems = listingGateProblems(course, sitting, ctx.courseId);
			if (listingProblems.length > 0) return invalidInputResult("ap_record_result", listingProblems);
			const topicProblems = topicGateProblems(course!, sitting!, input.topicId);
			if (topicProblems.length > 0) return invalidInputResult("ap_record_result", topicProblems);

			const updated = ctx.courses.recordResult(ctx.courseId, input.topicId, input.result, ctx.chatId);
			const located = locateTopic(updated, input.topicId);
			const ready = readiness(updated);
			const totals = ready.sections.reduce(
				(acc, unit) => ({ solid: acc.solid + unit.solid, total: acc.total + unit.total }),
				{ solid: 0, total: 0 },
			);
			return textResult(
				`Topic ${input.topicId} is now ${located?.topic.status ?? "unknown"}.\n` +
					`Overall readiness: ${pct(totals.solid, totals.total)} (${totals.solid}/${totals.total} points solid).`,
			);
		},
	};
}

// ─── ap_index_papers ────────────────────────────────────────────────────────

const AP_INDEX_SITTING_REFUSAL =
	"Papers are indexed only in a setup or papers session, not during a sitting.";
const AP_INDEX_UNCONFIRMED_REFUSAL = "confirm the unit and topic list first — questions are tagged against it";
const AP_INDEX_ACK =
	"This call is fire-and-forget: continue your turn and do not wait, poll, or mention waiting. " +
	"Each saved released paper is read once with its scoring guideline; the indexing result arrives later as a " +
	"new message. Tell the learner the papers are being indexed.";

/**
 * Start the background indexing job (AP prep stage 2): every saved released
 * `frq` paper with its `scoring` guideline is read once into the synced
 * question index. No parameters — the job reads the course record. The same
 * async protocol as the pdf job: create the record, fire the runner, return
 * the ack.
 */
function apIndexPapersTool(ctx: ApToolContext, jobs: JobToolContext): AgentTool<typeof emptyInputObject> {
	return {
		name: "ap_index_papers",
		label: "ap_index_papers",
		description:
			"Index the course's saved released free-response papers: one background job reads every saved `frq` " +
			"paper with its `scoring` guideline once and records each question's pages, lettered parts, topic tags " +
			"and rubric points in the synced question index. Call it once after saving papers; existing indexed " +
			"papers are skipped, so calling it again only indexes what is new. Refused in a sitting and until the " +
			"unit and topic list is confirmed. The call is ASYNC and fire-and-forget — it resolves immediately; " +
			"the indexing result arrives later as a new message. Tell the learner indexing has started.",
		parameters: emptyInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, emptyInputObject) as never,
		executionMode: "sequential",
		execute: async (toolCallId) => {
			if (ctx.sitting) return invalidInputResult("ap_index_papers", [AP_INDEX_SITTING_REFUSAL]);
			const course = ctx.courses.get(ctx.courseId);
			if (!course) return invalidInputResult("ap_index_papers", [`course "${ctx.courseId}" was not found`]);
			if (!course.planConfirmed) {
				return invalidInputResult("ap_index_papers", [AP_INDEX_UNCONFIRMED_REFUSAL]);
			}
			return textResult(
				dispatchJob(jobs, "ap_index", toolCallId, AP_INDEX_ACK, { courseId: ctx.courseId }),
			);
		},
	};
}

// ─── the page-capped pdf_extract ────────────────────────────────────────────

/**
 * Wrap the generic pdf_extract for AP: a call that resolves to more than
 * AP_PDF_EXTRACT_MAX_PAGES pages — including `all` on a longer document — is
 * refused before any extraction, as a retryable input problem. Requests within
 * the cap, and a document of 15 pages or fewer, behave exactly as before. The
 * tool's name, schema and description are unchanged; `pageCount` is the
 * pdfPageCount seam (injectable for tests).
 */
export function capPdfExtract(
	tool: AgentTool<any>,
	dir: string,
	pageCount: (filePath: string) => Promise<number> = pdfPageCount,
): AgentTool<any> {
	return {
		...tool,
		execute: async (toolCallId, input, signal, onUpdate) => {
			const params = input as { path?: unknown; pages?: unknown } | null;
			const filePath = typeof params?.path === "string" ? params.path : null;
			const pages = typeof params?.pages === "string" ? params.pages : null;
			if (filePath !== null && pages !== null) {
				const root = path.resolve(dir) + path.sep;
				const scoped = path.resolve(dir, filePath);
				if (scoped.startsWith(root)) {
					try {
						const total = await pageCount(scoped);
						if (parsePageSpec(pages, total).length > AP_PDF_EXTRACT_MAX_PAGES) {
							return invalidInputResult("pdf_extract", [AP_PDF_EXTRACT_REFUSAL]);
						}
					} catch {
						// An unreadable path falls through to the tool's own error, unchanged.
					}
				}
			}
			return tool.execute(toolCallId, input, signal, onUpdate);
		},
	};
}

// ─── the registry ───────────────────────────────────────────────────────────

/** The AP tutor's whole registry. The three pdf readers are scoped to the
 *  course's papers folder; there is no web_fetch_pdf, no pdf job and no
 *  demo/visual here. */
export function apTools(ctx: ApToolContext, enabled?: EnabledTools): Record<string, AgentTool<any>> {
	const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
	const papersDir = ctx.papers.dir(ctx.courseId);
	const pdfTools = createPdfReadTools(papersDir);
	// healToolRecord — the standard argument heal over the WHOLE registry
	// (the practice/teacher/test-prep convention).
	return healToolRecord({
		ap_save_document: apSaveDocumentTool(ctx),
		pdf_info: pdfTools.pdf_info!,
		pdf_extract: capPdfExtract(pdfTools.pdf_extract!, papersDir),
		pdf_search: pdfTools.pdf_search!,
		propose_units: proposeUnitsTool(ctx),
		ap_progress: apProgressTool(ctx),
		ap_mcq: apMcqTool(ctx),
		ap_frq: apFrqTool(ctx),
		ap_rubric: apRubricTool(ctx),
		ap_view_photo: apViewPhotoTool,
		ap_record_frq: apRecordFrqTool(ctx),
		ap_retag_part: apRetagPartTool(ctx),
		ap_record_result: apRecordResultTool(ctx),
		...(ctx.jobs ? { ap_index_papers: apIndexPapersTool(ctx, ctx.jobs) } : {}),
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(jobs?.research ? { research: jobs.research } : {}),
		// Direct web tools: the settings `web` switch is the only toggle this
		// registry reads.
		...tutorWebTools(ctx.search, enabled),
	});
}