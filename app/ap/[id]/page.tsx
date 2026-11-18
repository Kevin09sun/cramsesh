import { notFound } from "next/navigation";

import { CoursePage, type CourseDocument } from "@/components/ap/course-view";
import { sessionsForCourse, type ApDocument, type ApQuestionIndex } from "@/src/core";
import { apPaperPath, apPaperPresent, listChats, stores } from "@/src/server";

/**
 * /ap/[id] — one AP course page (AP prep, 2026-11-13).
 *
 * The record is read server-side; local paper presence is a filesystem fact
 * that only the server can answer, so each document is projected with its
 * `present` state here and the client body owns the mutations (edit and
 * confirm the units, download a missing paper, start a sitting). The course
 * description's absolute path is handed over only when it is actually on
 * this computer — that path is the one thing about a paper the Learn prompt
 * carries. The synced question index adds its summary: the total number of
 * indexed questions and, per released paper, the questions it contributed.
 * An unknown id is a 404, not an empty page.
 */

export const dynamic = "force-dynamic";

/** A malformed manifest entry reads as absent rather than failing the page. */
function documentState(
	courseId: string,
	document: ApDocument,
	questions: Map<string, number>,
): CourseDocument {
	const indexed = document.kind === "frq" ? { questions: questions.get(document.id) ?? 0 } : {};
	try {
		return { ...document, present: apPaperPresent(courseId, document.file), ...indexed };
	} catch {
		return { ...document, present: false, ...indexed };
	}
}

/** How many indexed questions name each released paper. */
function questionsByPaper(index: ApQuestionIndex | null): Map<string, number> {
	const counts = new Map<string, number>();
	for (const question of index?.questions ?? []) {
		counts.set(question.paperId, (counts.get(question.paperId) ?? 0) + 1);
	}
	return counts;
}

function descriptionPath(courseId: string, documents: CourseDocument[]): string | undefined {
	const description = documents.find((document) => document.kind === "ced" && document.present);
	if (!description) return undefined;
	try {
		return apPaperPath(courseId, description.file);
	} catch {
		return undefined;
	}
}

export default async function ApCoursePage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const course = stores.apCourseStore.get(id);
	if (!course) notFound();

	const index = stores.apIndexStore.get(id);
	const documents = course.documents.map((document) =>
		documentState(id, document, questionsByPaper(index)),
	);
	const cedPath = descriptionPath(id, documents);
	return (
		<CoursePage
			course={course}
			documents={documents}
			indexedQuestions={index?.questions.length ?? 0}
			{...(cedPath === undefined ? {} : { cedPath })}
			sessions={sessionsForCourse(listChats(), id)}
		/>
	);
}