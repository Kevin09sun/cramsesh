/**
 * STUDY SESSIONS (2026-11-17): the pure helpers that decide whether a chat is
 * a Test prep / AP session and which test or course box it belongs to. These
 * drive the sidebar's hiding rule, the box detail pages' session lists and
 * the knowledge graph's group partition. Pure — fixtures are plain objects.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	isStudySession,
	sessionsForCourse,
	sessionsForTest,
	studyGroupKey,
	type StudyFields,
} from "../src/core/study-sessions.ts";

interface StudyChat extends StudyFields {
	id: string;
	title: string;
}

function chat(id: string, fields: StudyFields = {}): StudyChat {
	return { id, title: id, ...fields };
}

describe("isStudySession", () => {
	it("accepts testprep and ap sessions", () => {
		assert.equal(isStudySession(chat("t", { kind: "testprep", testId: "t1" })), true);
		assert.equal(isStudySession(chat("a", { kind: "ap", apCourseId: "c1" })), true);
	});

	it("accepts a teach session carrying an apCourseId (the linked Learn chat)", () => {
		assert.equal(isStudySession(chat("learn", { kind: "teach", apCourseId: "c1" })), true);
	});

	it("rejects teach, practice and a session with no kind", () => {
		assert.equal(isStudySession(chat("teach", { kind: "teach" })), false);
		assert.equal(isStudySession(chat("practice", { kind: "practice" })), false);
		assert.equal(isStudySession(chat("legacy", {})), false);
	});
});

describe("studyGroupKey", () => {
	it("keys a testprep session by its test id", () => {
		assert.equal(studyGroupKey(chat("t", { kind: "testprep", testId: "t1" })), "test:t1");
	});

	it("returns null for a testprep session with no test id", () => {
		assert.equal(studyGroupKey(chat("t", { kind: "testprep" })), null);
	});

	it("keys an ap session and a linked teach session by course id", () => {
		assert.equal(studyGroupKey(chat("a", { kind: "ap", apCourseId: "c1" })), "course:c1");
		assert.equal(studyGroupKey(chat("learn", { kind: "teach", apCourseId: "c1" })), "course:c1");
	});

	it("returns null for a teach session", () => {
		assert.equal(studyGroupKey(chat("teach", { kind: "teach" })), null);
	});
});

describe("sessionsForTest", () => {
	it("picks exactly the matching test's sessions in input order", () => {
		const chats = [
			chat("t1a", { kind: "testprep", testId: "t1" }),
			chat("t2", { kind: "testprep", testId: "t2" }),
			chat("t1b", { kind: "testprep", testId: "t1" }),
			chat("a1", { kind: "ap", apCourseId: "c1" }),
			chat("teach", { kind: "teach" }),
			chat("unfiled", { kind: "testprep" }),
		];

		assert.deepEqual(
			sessionsForTest(chats, "t1").map((c) => c.id),
			["t1a", "t1b"],
		);
	});
});

describe("sessionsForCourse", () => {
	it("picks the course's ap and linked teach sessions in input order, excluding other ids", () => {
		const chats = [
			chat("learn", { kind: "teach", apCourseId: "c1" }),
			chat("a2", { kind: "ap", apCourseId: "c2" }),
			chat("a1", { kind: "ap", apCourseId: "c1" }),
			chat("t1", { kind: "testprep", testId: "t1" }),
			chat("teach", { kind: "teach" }),
		];

		assert.deepEqual(
			sessionsForCourse(chats, "c1").map((c) => c.id),
			["learn", "a1"],
		);
		assert.deepEqual(
			sessionsForCourse(chats, "c2").map((c) => c.id),
			["a2"],
		);
		assert.deepEqual(
			sessionsForCourse(chats, "missing").map((c) => c.id),
			[],
		);
	});
});