/**
 * GET /api/ap/[id]/questions/[qid] — what the browser needs to display one
 * released free-response question (AP prep stage 2, 2026-11-14).
 *
 * The answer form shows the question's original pages, its parts and the
 * topic each part tests. The projection deliberately carries no rubric: no
 * point text, no point ids and no scoring pages — the learner never sees the
 * rubric before answering. `present` says whether the paper is on this
 * computer; a second computer still gets the projection and the page route
 * 404s until the paper is downloaded. An unknown course or question is a 404.
 * Reads stay unguarded like every other read route.
 */

import { apQuestionTitle } from "@/src/core";
import type { ApCourseRecord } from "@/src/core";
import { apPaperPresent, stores } from "@/src/server";

export const dynamic = "force-dynamic";

/** The confirmed topic's text, or undefined when the id is no longer listed. */
function topicText(record: ApCourseRecord, topicId: string): string | undefined {
	for (const section of record.sections) {
		const point = section.points.find((candidate) => candidate.id === topicId);
		if (point) return point.text;
	}
	return undefined;
}

/** A malformed manifest entry reads as absent rather than failing the page. */
function paperPresent(courseId: string, file: string): boolean {
	try {
		return apPaperPresent(courseId, file);
	} catch {
		return false;
	}
}

export async function GET(
	_request: Request,
	ctx: { params: Promise<{ id: string; qid: string }> },
): Promise<Response> {
	const { id, qid } = await ctx.params;
	const record = stores.apCourseStore.get(id);
	if (!record) return Response.json({ error: "Unknown AP course" }, { status: 404 });

	const question = stores.apIndexStore.get(id)?.questions.find((candidate) => candidate.id === qid);
	if (!question) return Response.json({ error: "Unknown question" }, { status: 404 });

	// paperId is the manifest document's id; the document owns the local file
	// name the page route checks. A stale index entry falls back to the
	// convention for its own id so the projection still has a file to name.
	const paper = record.documents.find((document) => document.id === question.paperId);
	const file = paper?.file ?? `${question.paperId}.pdf`;

	return Response.json({
		id: question.id,
		title: apQuestionTitle(question),
		file,
		pages: [...question.pages],
		present: paperPresent(id, file),
		parts: question.parts.map((part) => {
			const text = part.topicId === undefined ? undefined : topicText(record, part.topicId);
			if (part.topicId === undefined || text === undefined) return { label: part.label };
			return { label: part.label, topicId: part.topicId, topicText: text };
		}),
	});
}