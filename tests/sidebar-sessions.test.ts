/**
 * SIDEBAR SESSIONS (study boxes, 2026-11-17): the sidebar's list. Study
 * sessions (Test prep / AP, plus the linked Learn chat) live in their
 * test/course boxes, so the sidebar hides them — except when searching,
 * where they always pass the kind filter and compete on the fuzzy score
 * like any other chat. Pure — fixtures are plain objects.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sidebarSessions, type StudyFields } from "../src/core/study-sessions.ts";

interface Chat extends StudyFields {
	id: string;
	title: string;
}

const chats: Chat[] = [
	{ id: "t1", title: "Cell biology basics", kind: "teach" },
	{ id: "p1", title: "Biology drill", kind: "practice" },
	{ id: "legacy", title: "Old session" },
	{ id: "tp1", title: "SAT Math sitting", kind: "testprep", testId: "test-1" },
	{ id: "ap1", title: "Biology unit 2", kind: "ap", apCourseId: "course-1" },
	{ id: "learn1", title: "Learn photosynthesis", kind: "teach", apCourseId: "course-1" },
];

const ids = (list: readonly Chat[]) => list.map((c) => c.id);

describe("sidebarSessions", () => {
	it("with no query, study chats are hidden and the kind filter applies", () => {
		assert.deepEqual(ids(sidebarSessions(chats, { query: "", kindFilter: "all" })), ["t1", "p1", "legacy"]);
		assert.deepEqual(ids(sidebarSessions(chats, { query: "", kindFilter: "teach" })), ["t1", "legacy"]);
		assert.deepEqual(ids(sidebarSessions(chats, { query: "  ", kindFilter: "practice" })), ["p1"]);
	});

	it("with a query, an AP chat matching the query shows even when the filter is teach", () => {
		const shown = ids(sidebarSessions(chats, { query: "unit", kindFilter: "teach" }));
		assert.deepEqual(shown, ["ap1"]);
	});

	it("with a query, a practice chat is still hidden when the filter is teach", () => {
		const shown = ids(sidebarSessions(chats, { query: "drill", kindFilter: "teach" }));
		assert.deepEqual(shown, []);
		const biology = ids(sidebarSessions(chats, { query: "biology", kindFilter: "teach" }));
		assert.ok(!biology.includes("p1"), "practice stays filtered out");
		assert.ok(biology.includes("ap1") && biology.includes("t1"));
	});

	it("keeps the fuzzy order: the best match comes first", () => {
		const shown = ids(sidebarSessions(chats, { query: "biology", kindFilter: "all" }));
		// "Biology drill" / "Biology unit 2" are prefix matches (input order
		// kept between equal scores); "Cell biology basics" is buried.
		assert.deepEqual(shown, ["p1", "ap1", "t1"]);
	});
});
