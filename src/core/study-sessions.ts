/**
 * Study sessions (2026-11-17): Tests and AP sessions leave the sidebar and
 * live in their test/course "boxes", and the knowledge graph groups linked
 * sessions into one region per test or course. This module is the single pure
 * decision point: whether a chat is a study session, and which group it
 * belongs to. No React, no I/O.
 *
 * Study session = kind "testprep", kind "ap", or any chat carrying an
 * apCourseId — the linked Learn chat reads as teach (kind absent or "teach")
 * and files under its course. A practice session is never a study session.
 */

import type { ChatSummary } from "./contracts.ts";

/** The fields the helpers read. `kind` is optional here even though
 *  ChatSummary normalizes it: pre-practice records carry no kind, and
 *  absence must read as teach. */
export type StudyFields = Partial<Pick<ChatSummary, "kind" | "testId" | "apCourseId">>;

/** Is this chat a Test prep / AP session (hidden from the sidebar, listed in
 *  its box, grouped in the graph)? */
export function isStudySession(chat: StudyFields): boolean {
	return chat.kind === "testprep" || chat.kind === "ap" || chat.apCourseId !== undefined;
}

/** The chat's study group — `"test:<id>"` for a testprep session with a test
 *  record, `"course:<id>"` for any session carrying a course (including the
 *  linked Learn chat), else null (not grouped). */
export function studyGroupKey(chat: StudyFields): string | null {
	if (chat.kind === "testprep") {
		return chat.testId === undefined ? null : `test:${chat.testId}`;
	}
	if (chat.apCourseId !== undefined) return `course:${chat.apCourseId}`;
	return null;
}

/** The sessions belonging to one test, in input order (listChats() is
 *  newest-first). Test prep sessions only — a test has one kind of session. */
export function sessionsForTest<T extends StudyFields>(chats: readonly T[], testId: string): T[] {
	return chats.filter((chat) => chat.kind === "testprep" && chat.testId === testId);
}

/** The sessions belonging to one course, in input order — the AP sessions
 *  plus the linked teach Learn chat filed under it. */
export function sessionsForCourse<T extends StudyFields>(chats: readonly T[], courseId: string): T[] {
	return chats.filter((chat) => isStudySession(chat) && chat.apCourseId === courseId);
}
