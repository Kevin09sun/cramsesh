/**
 * ap-frq — the AP session type's real free-response core: the synced question
 * index (released questions, their pages, topic tags and rubric points), the
 * scoring of one attempt by rubric point, and which real questions a sitting
 * may ask.
 *
 * A released paper pair (questions + scoring guideline) is read once by a
 * background job into an index. The learner answers part by part; the tutor
 * records the rubric points earned, and one result per distinct tagged topic
 * feeds the shared Test prep status machine. No fs, no framework imports:
 * deterministic and unit-testable.
 */

import { scopedQueue, topicInScope, type ApCourseRecord, type ApDocument, type ApSittingScope } from "./ap.ts";
import type { ApFrqGenToolInput } from "./question-core.ts";
import type { AnswerResult } from "./test-prep.ts";

// ─── records ────────────────────────────────────────────────────────────────

export interface ApRubricPoint {
	id: string; // unique in the question: "<partLabel><n>", e.g. "a1"
	text: string;
}

export interface ApRealPart {
	label: string;
	topicId?: string; // absent = tests nothing in the confirmed list
	points: ApRubricPoint[];
}

export interface ApRealQuestion {
	id: string; // "2023-2" | "2023-s2-2"
	paperId: string; // ApDocument.id of the frq paper
	scoringId: string; // ApDocument.id of the scoring guideline
	year: number;
	set?: number;
	number: number;
	pages: number[]; // 1-based pages of the paper showing the question
	scoringPages: number[];
	parts: ApRealPart[];
}

export interface ApQuestionIndex {
	courseId: string;
	version: 1;
	updatedAt: string;
	questions: ApRealQuestion[];
}

export interface ApRealAttempt {
	questionId: string;
	chatId: string;
	at: string;
	dontKnow?: boolean;
	parts: { label: string; earned: string[] }[];
}

// ─── file names, ids and titles ─────────────────────────────────────────────

/** The local file name of a released paper or its scoring guideline. */
export function apPaperFileName(kind: "frq" | "scoring", year: number, set?: number): string {
	return `${kind}-${year}${set === undefined ? "" : `-set${set}`}.pdf`;
}

/** A released question's stable id across both computers. */
export function apQuestionId(year: number, number: number, set?: number): string {
	return set === undefined ? `${year}-${number}` : `${year}-s${set}-${number}`;
}

/** A released question's paper heading, e.g. "2023 FRQ 2" or "2023 Set 2 FRQ 2". */
export function apQuestionTitle(q: Pick<ApRealQuestion, "year" | "set" | "number">): string {
	return q.set === undefined
		? `${q.year} FRQ ${q.number}`
		: `${q.year} Set ${q.set} FRQ ${q.number}`;
}

/**
 * The set encoded in a released paper's id and the id of its scoring
 * guideline, rebuilt from the shared file-name rule (never by string
 * surgery). Undefined when the paper has no year or its id is not a released
 * `frq` name: `frq-2023` → `scoring-2023`, `frq-2023-set2` → set 2 and
 * `scoring-2023-set2`.
 */
export function apPaperPair(
	paper: Pick<ApDocument, "id" | "year">,
): { set?: number; scoringId: string } | undefined {
	if (paper.year === undefined) return undefined;
	const withoutPdf = (name: string) => name.slice(0, -".pdf".length);
	for (let set = 1; set <= 9; set++) {
		if (withoutPdf(apPaperFileName("frq", paper.year, set)) === paper.id) {
			return { set, scoringId: withoutPdf(apPaperFileName("scoring", paper.year, set)) };
		}
	}
	if (withoutPdf(apPaperFileName("frq", paper.year)) === paper.id) {
		return { scoringId: withoutPdf(apPaperFileName("scoring", paper.year)) };
	}
	return undefined;
}

// ─── index validation ───────────────────────────────────────────────────────

/**
 * A part label: one lower-case letter, then up to seven lower-case letters or
 * hyphens. Digits are forbidden because point ids are `<label><n>`; a label
 * like "a1" would make "a1"+"1" collide with "a"+"11".
 */
export const AP_PART_LABEL_PATTERN = /^[a-z][a-z-]{0,7}$/;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositivePageList(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(isPositiveInteger);
}

function isRealPart(value: unknown): value is ApRealPart {
	if (typeof value !== "object" || value === null) return false;
	const part = value as Record<string, unknown>;
	if (!isNonEmptyString(part.label) || !AP_PART_LABEL_PATTERN.test(part.label)) return false;
	if (part.topicId !== undefined && !isNonEmptyString(part.topicId)) return false;
	return Array.isArray(part.points) && part.points.length > 0 && part.points.every(isRubricPoint);
}

function isRubricPoint(value: unknown): value is ApRubricPoint {
	if (typeof value !== "object" || value === null) return false;
	const point = value as Record<string, unknown>;
	return isNonEmptyString(point.id) && isNonEmptyString(point.text);
}

/** Strict structural check for one released question (also used by
 *  `isApQuestionIndex`, so there is one definition). */
export function isApRealQuestion(value: unknown): value is ApRealQuestion {
	if (typeof value !== "object" || value === null) return false;
	const question = value as Record<string, unknown>;
	if (!isNonEmptyString(question.id)) return false;
	if (!isNonEmptyString(question.paperId)) return false;
	if (!isNonEmptyString(question.scoringId)) return false;
	if (!isPositiveInteger(question.year)) return false;
	if (question.set !== undefined && !isPositiveInteger(question.set)) return false;
	if (!isPositiveInteger(question.number)) return false;
	if (!isPositivePageList(question.pages) || question.pages.length === 0) return false;
	if (!isPositivePageList(question.scoringPages) || question.scoringPages.length === 0) return false;
	if (!Array.isArray(question.parts) || question.parts.length === 0) return false;
	if (!question.parts.every(isRealPart)) return false;

	// Part labels and point ids are unique in the question.
	const partLabels = new Set<string>();
	const pointIds = new Set<string>();
	for (const part of question.parts as ApRealPart[]) {
		if (partLabels.has(part.label)) return false;
		partLabels.add(part.label);
		for (const point of part.points) {
			if (pointIds.has(point.id)) return false;
			pointIds.add(point.id);
		}
	}
	return true;
}

/**
 * Strict structural check for a synced question index (a file that can be
 * hand-edited or half-written). Every field type is checked, `version` must
 * be 1, page numbers must be positive integers, and a question must have
 * parts and at least one paper page, a part must have points, question ids
 * must be unique, part labels must follow `AP_PART_LABEL_PATTERN` and be
 * unique within their question, and rubric point ids must be unique within
 * their question.
 */
export function isApQuestionIndex(value: unknown): value is ApQuestionIndex {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const index = value as Record<string, unknown>;
	if (!isNonEmptyString(index.courseId)) return false;
	if (index.version !== 1) return false;
	if (!isNonEmptyString(index.updatedAt)) return false;
	if (!Array.isArray(index.questions)) return false;

	const questionIds = new Set<string>();
	for (const question of index.questions) {
		if (!isApRealQuestion(question)) return false;
		if (questionIds.has(question.id)) return false;
		questionIds.add(question.id);
	}
	return true;
}

// ─── generated questions (AP prep stage 3) ──────────────────────────────────

/**
 * A question the tutor wrote itself gets a stable id from the call that posed
 * it, distinct from a released paper's `<year>-<number>`: `gen-<toolCallId>`.
 */
export function apGenQuestionId(toolCallId: string): string {
	return `gen-${toolCallId}`;
}

/**
 * The committed rubric of a generated question as something `attemptProblems`
 * and `scoreAttempt` can grade: each input part becomes an `ApRealPart` whose
 * point ids are `<label><n>` (1-based, in the committed order). Labels are
 * trimmed and lower-cased exactly as `apFrqGenInputProblems` validated them,
 * and point text is trimmed.
 */
export function generatedScoringQuestion(input: ApFrqGenToolInput): Pick<ApRealQuestion, "parts"> {
	return {
		parts: input.parts.map((part) => {
			const label = part.label.trim().toLowerCase();
			return {
				label,
				topicId: part.topicId,
				points: part.points.map((text, index) => ({ id: `${label}${index + 1}`, text: text.trim() })),
			};
		}),
	};
}

// ─── scoring ────────────────────────────────────────────────────────────────

export interface ApPartScore {
	label: string;
	earned: number;
	total: number;
	topicId?: string;
	complete: boolean;
}

export interface ApAttemptScore {
	earned: number;
	total: number;
	parts: ApPartScore[];
	topics: { topicId: string; result: AnswerResult }[]; // one per distinct tagged topic, in part order
}

/**
 * Problems with a grading the tutor submitted; empty = usable. Parts are
 * checked in the submitted order, then parts the submission omitted are
 * named in the question's part order.
 */
export function attemptProblems(
	q: Pick<ApRealQuestion, "parts">,
	parts: { label: string; earned: string[] }[],
): string[] {
	const problems: string[] = [];
	const byLabel = new Map(q.parts.map((part) => [part.label, part]));
	const seen = new Set<string>();

	for (const submitted of parts) {
		const part = byLabel.get(submitted.label);
		if (!part) {
			problems.push(`part "${submitted.label}" is not a part of this question`);
			continue;
		}
		if (seen.has(submitted.label)) {
			problems.push(`part "${submitted.label}" is listed more than once`);
			continue;
		}
		seen.add(submitted.label);

		const pointIds = new Set(part.points.map((point) => point.id));
		const earnedSeen = new Set<string>();
		for (const id of submitted.earned) {
			if (!pointIds.has(id)) {
				problems.push(`point "${id}" is not a rubric point of part "${submitted.label}"`);
			} else if (earnedSeen.has(id)) {
				problems.push(`point "${id}" is listed more than once`);
			}
			earnedSeen.add(id);
		}
	}

	for (const part of q.parts) {
		if (!seen.has(part.label)) problems.push(`part "${part.label}" is missing`);
	}

	return problems;
}

/**
 * Score one attempt against the question's rubric.
 *
 * A part is complete when every point id of the part was earned. A topic is
 * `correct` only when every part tagged to it is complete, else `wrong`. With
 * "I don't know" every part scores 0 and every tagged topic is `dontKnow`. A
 * part whose topic is absent or not in the confirmed list is scored but
 * contributes no topic and carries no `topicId`.
 */
export function scoreAttempt(
	q: Pick<ApRealQuestion, "parts">,
	attempt: Pick<ApRealAttempt, "parts" | "dontKnow">,
	knownTopicIds: ReadonlySet<string>,
): ApAttemptScore {
	// The last submitted grading for a label wins; the tutor's submission is
	// validated by attemptProblems before this runs.
	const submitted = new Map<string, Set<string>>();
	for (const part of attempt.parts) submitted.set(part.label, new Set(part.earned));

	const topicOrder: string[] = [];
	const topicComplete = new Map<string, boolean>();
	let earnedTotal = 0;
	let pointsTotal = 0;

	const parts = q.parts.map((part): ApPartScore => {
		const earnedIds = attempt.dontKnow ? new Set<string>() : (submitted.get(part.label) ?? new Set<string>());
		const earned = part.points.filter((point) => earnedIds.has(point.id)).length;
		const complete =
			!attempt.dontKnow &&
			part.points.length > 0 &&
			part.points.every((point) => earnedIds.has(point.id));

		earnedTotal += earned;
		pointsTotal += part.points.length;

		if (part.topicId !== undefined && knownTopicIds.has(part.topicId)) {
			if (!topicComplete.has(part.topicId)) {
				topicOrder.push(part.topicId);
				topicComplete.set(part.topicId, complete);
			} else if (!complete) {
				topicComplete.set(part.topicId, false);
			}
		}

		return {
			label: part.label,
			earned,
			total: part.points.length,
			...(part.topicId === undefined || !knownTopicIds.has(part.topicId)
				? {}
				: { topicId: part.topicId }),
			complete,
		};
	});

	const topics = topicOrder.map((topicId) => ({
		topicId,
		result: (attempt.dontKnow ? "dontKnow" : topicComplete.get(topicId) ? "correct" : "wrong") as AnswerResult,
	}));

	return { earned: earnedTotal, total: pointsTotal, parts, topics };
}

// ─── eligibility ────────────────────────────────────────────────────────────

export interface ApEligibleQuestion {
	question: ApRealQuestion;
	used: boolean;
	topicIds: string[];
}

/**
 * Real questions with at least one part tagged to a topic in scope, ordered by
 * the weak-first position of their weakest in-scope topic (the earliest queue
 * entry among all their in-scope topics), unused before used. A topic absent
 * from the queue sorts after those present. A null index means nothing has
 * been indexed yet.
 */
export function eligibleRealQuestions(
	course: Pick<ApCourseRecord, "sections">,
	index: ApQuestionIndex | null,
	scope: ApSittingScope,
	chatId: string,
	attempts: readonly ApRealAttempt[],
): ApEligibleQuestion[] {
	if (index === null) return [];

	const position = new Map(
		scopedQueue(course, scope, chatId).map((entry, queueIndex) => [entry.pointId, queueIndex]),
	);
	const usedIds = new Set(attempts.map((attempt) => attempt.questionId));

	const ranked = index.questions.flatMap((question) => {
		const topicIds: string[] = [];
		for (const part of question.parts) {
			const topicId = part.topicId;
			if (topicId === undefined) continue;
			if (!topicInScope(course, scope, topicId)) continue;
			if (!topicIds.includes(topicId)) topicIds.push(topicId);
		}
		if (topicIds.length === 0) return [];

		// The question is as weak as its weakest in-scope topic.
		const bestPosition = topicIds.reduce(
			(lowest, topicId) =>
				Math.min(lowest, position.get(topicId) ?? Number.POSITIVE_INFINITY),
			Number.POSITIVE_INFINITY,
		);
		return [{
			question,
			used: usedIds.has(question.id),
			topicIds,
			position: bestPosition,
		}];
	});

	ranked.sort((a, b) => {
		if (a.used !== b.used) return a.used ? 1 : -1;
		if (a.position !== b.position) return a.position - b.position;
		return 0;
	});

	return ranked.map(({ question, used, topicIds }) => ({ question, used, topicIds }));
}