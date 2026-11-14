/**
 * ApIndexStore — the fs JSON adapter for AP question indexes (one file per
 * course in data/ap-index/).
 *
 * An index holds the released free-response questions a background job read
 * from a paper pair: the pages that show each question, its parts, the topic
 * each part is tagged to, and the rubric point texts. The shape and its
 * validation live in core/ap-frq.ts. Unlike the paper PDFs, the index is
 * learning data and syncs with the course record, so every write goes through
 * the shared atomic writer and announces "ap-changed" post-write. Reads
 * mirror the course store: missing, unreadable, malformed or wrong-shaped
 * files read as null and are never rewritten.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { isApQuestionIndex } from "../core/ap-frq.ts";
import type { ApQuestionIndex, ApRealQuestion } from "../core/ap-frq.ts";
import { COURSE_ID_PATTERN } from "./ap-courses.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

function indexFile(courseId: string): string {
	if (!COURSE_ID_PATTERN.test(courseId)) throw new Error(`Invalid course id: ${courseId}`);
	return path.join(PATHS.apIndex, `${courseId}.json`);
}

function writeIndex(index: ApQuestionIndex): void {
	writeFileAtomicSync(indexFile(index.courseId), JSON.stringify(index, null, "\t"));
}

/** The index order: newest year first, then set, then question number. */
function compareQuestions(a: ApRealQuestion, b: ApRealQuestion): number {
	if (a.year !== b.year) return b.year - a.year;
	if ((a.set ?? 0) !== (b.set ?? 0)) return (a.set ?? 0) - (b.set ?? 0);
	return a.number - b.number;
}

function get(courseId: string): ApQuestionIndex | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(indexFile(courseId), "utf-8"));
	} catch {
		// Missing, unreadable, malformed, or an invalid id: an honest absent
		// read. The file is left untouched — never rewrite what we did not parse.
		return null;
	}
	// Parseable but not a question index (a conflict copy, a half-written
	// file) reads the same as absent and is never rewritten here.
	return isApQuestionIndex(parsed) ? parsed : null;
}

/** Read the course's index, or start an empty one on the first paper. */
function putPaper(courseId: string, paperId: string, questions: ApRealQuestion[]): ApQuestionIndex {
	const existing = get(courseId);
	const kept = (existing?.questions ?? []).filter((question) => question.paperId !== paperId);
	const next: ApQuestionIndex = {
		courseId,
		version: 1,
		updatedAt: new Date().toISOString(),
		questions: [...kept, ...questions].sort(compareQuestions),
	};
	fs.mkdirSync(PATHS.apIndex, { recursive: true });
	writeIndex(next);
	emit("ap-changed", {});
	return next;
}

/** Set one part's topic tag, or clear it with undefined. The change affects
 *  future gradings only: an attempt already recorded is never rewritten. */
function retagPart(
	courseId: string,
	questionId: string,
	label: string,
	topicId: string | undefined,
): ApQuestionIndex {
	const index = get(courseId);
	if (!index) throw new Error("unknown question");

	const question = index.questions.find((candidate) => candidate.id === questionId);
	if (!question) throw new Error("unknown question");
	if (!question.parts.some((part) => part.label === label)) throw new Error("unknown part");

	const questions = index.questions.map((candidate) => {
		if (candidate.id !== questionId) return candidate;
		return {
			...candidate,
			parts: candidate.parts.map((part) => {
				if (part.label !== label) return part;
				return topicId === undefined
					? { label: part.label, points: part.points }
					: { ...part, topicId };
			}),
		};
	});

	const next: ApQuestionIndex = {
		courseId,
		version: 1,
		updatedAt: new Date().toISOString(),
		questions,
	};
	fs.mkdirSync(PATHS.apIndex, { recursive: true });
	writeIndex(next);
	emit("ap-changed", {});
	return next;
}

export const apIndexStore = {
	get,
	putPaper,
	retagPart,
};