/**
 * FORGET A DELETED SESSION'S ANSWERS (AP prep stage 1, 2026-11-13): an AP
 * sitting writes its answers into the course record, so deleting the session
 * must forget them there — the topic replays its remaining attempts. The
 * course forget is best-effort for a gone course: the session deletion still
 * succeeds. Runs under an isolated LH_DATA_DIR, set before any
 * config-loading import (the test-prep-store discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-session-delete-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { apCourseStore } = await import("../src/store/ap-courses.ts");
const { deleteChatSession, deleteIdleChatRecord } = await import("../src/server/chats.ts");

type ApRealAttempt = import("../src/core/ap-frq.ts").ApRealAttempt;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

/** A confirmed one-topic course: the only topic both sittings answer. */
function confirmedCourse(title: string): { courseId: string; topicId: string } {
	const course = apCourseStore.create(title);
	const saved = apCourseStore.savePlan(
		course.id,
		[{ title: "Unit 1", points: [{ text: "Topic 1.1", source: "ced.pdf" }] }],
		true,
	);
	return { courseId: saved.id, topicId: saved.sections[0]!.points[0]!.id };
}

function apChat(title: string, courseId: string): string {
	return chatStore.createChat(title, "ap", undefined, { courseId }).id;
}

function onlyPoint(courseId: string) {
	return apCourseStore.get(courseId)!.sections[0]!.points[0]!;
}

describe("AP session deletion forgets the session's answers (AP prep stage 1, 2026-11-13)", () => {
	it("deleting the second chat replays the topic from the first chat's attempt alone", async () => {
		const { courseId, topicId } = confirmedCourse("Forget the second chat");
		const first = apChat("First sitting", courseId);
		const second = apChat("Second sitting", courseId);

		apCourseStore.recordResult(courseId, topicId, "correct", first);
		apCourseStore.recordResult(courseId, topicId, "wrong", second);
		assert.equal(onlyPoint(courseId).status, "gap", "the second chat's wrong answer is the live verdict before deletion");

		const outcome = await deleteChatSession(second, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(chatStore.getChat(second), null, "the chat record is gone");

		const point = onlyPoint(courseId);
		assert.equal(point.status, "solid", "the first chat's correct answer alone makes it solid");
		assert.deepEqual(point.history.map((attempt) => attempt.chatId), [first], "the second chat's attempt is forgotten");
	});

	it("deleting a free-response session drops its attempt and replays the topics", async () => {
		const { courseId, topicId } = confirmedCourse("Real attempt forgotten");
		const first = apChat("First real sitting", courseId);
		const second = apChat("Second real sitting", courseId);
		const firstAttempt: ApRealAttempt = {
			questionId: "2023-2",
			chatId: first,
			at: "2026-11-14T10:00:00.000Z",
			parts: [{ label: "a", earned: ["a1"] }],
		};
		const secondAttempt: ApRealAttempt = {
			questionId: "2023-3",
			chatId: second,
			at: "2026-11-14T10:01:00.000Z",
			parts: [{ label: "a", earned: [] }],
		};

		apCourseStore.recordRealAttempt(courseId, firstAttempt, [{ topicId, result: "correct" }]);
		apCourseStore.recordRealAttempt(courseId, secondAttempt, [{ topicId, result: "wrong" }]);
		assert.equal(onlyPoint(courseId).status, "gap", "the second chat's wrong grading is the live verdict");

		const outcome = await deleteChatSession(second, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(chatStore.getChat(second), null, "the chat record is gone");

		const record = apCourseStore.get(courseId)!;
		assert.deepEqual(record.realAttempts, [firstAttempt], "the deleted session's attempt is gone");
		assert.equal(onlyPoint(courseId).status, "solid", "the first chat's grading alone replays to solid");
		assert.deepEqual(onlyPoint(courseId).history.map((attempt) => attempt.chatId), [first]);
	});

	it("deleting a chat with no attempts leaves the course file's bytes unchanged", () => {
		const { courseId } = confirmedCourse("No attempts");
		const chat = apChat("Setup session", courseId);
		const file = path.join(TMP_DATA, "ap", `${courseId}.json`);
		const before = fs.readFileSync(file);

		assert.deepEqual(deleteIdleChatRecord(chat), { ok: true });
		assert.equal(chatStore.getChat(chat), null, "the chat record is gone");
		assert.deepEqual(fs.readFileSync(file), before, "a forget with nothing to erase does not rewrite the course file");
	});

	it("deleting an AP chat whose course file is gone still succeeds", async () => {
		const { courseId } = confirmedCourse("Course gone");
		const chat = apChat("Orphaned sitting", courseId);
		fs.rmSync(path.join(TMP_DATA, "ap", `${courseId}.json`));

		const outcome = await deleteChatSession(chat, "preserve-graph");
		assert.equal(outcome.ok, true, "a missing course is not an error");
		assert.equal(chatStore.getChat(chat), null, "the session deletion stands");
	});

	it("deleting an AP chat whose course file holds invalid JSON still succeeds", async () => {
		const { courseId } = confirmedCourse("Course unreadable");
		const chat = apChat("Sitting with an unreadable course", courseId);
		fs.writeFileSync(path.join(TMP_DATA, "ap", `${courseId}.json`), "{not json");

		const outcome = await deleteChatSession(chat, "preserve-graph");
		assert.equal(outcome.ok, true, "an unreadable course is not an error");
		assert.equal(chatStore.getChat(chat), null, "the session deletion stands");
	});

	it("a failing course forget does not fail the session deletion", async () => {
		const { courseId } = confirmedCourse("Forget fails");
		const chat = apChat("Sitting with a locked course", courseId);
		// The chat record is already gone when the forget runs, so a locked
		// course file must not turn a completed deletion into an error.
		const originalForget = apCourseStore.forgetChat;
		const originalError = console.error;
		const logged: unknown[][] = [];
		apCourseStore.forgetChat = () => {
			throw new Error("locked course file");
		};
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			const outcome = await deleteChatSession(chat, "preserve-graph");
			assert.equal(outcome.ok, true, "a failing forget is not a deletion failure");
			assert.equal(chatStore.getChat(chat), null, "the chat record is gone");
			const message = logged.map((args) => args.map(String).join(" ")).join("\n");
			assert.match(message, new RegExp(chat), "the failure names the chat");
			assert.match(message, new RegExp(courseId), "the failure names the course");
		} finally {
			apCourseStore.forgetChat = originalForget;
			console.error = originalError;
		}
	});

	it("deleting a linked Learn teach chat forgets its answers the same way", async () => {
		const { courseId, topicId } = confirmedCourse("Learn session forgotten");
		const sitting = apChat("A sitting", courseId);
		const learn = chatStore.createChat("Learn topic", undefined, undefined, {
			courseId,
			learn: { type: "topic", topicId },
		}).id;
		assert.equal(chatStore.getChat(learn)?.kind, undefined, "a Learn session is a teach chat");
		assert.equal(chatStore.getChat(learn)?.apCourseId, courseId);

		apCourseStore.recordResult(courseId, topicId, "correct", sitting);
		apCourseStore.recordResult(courseId, topicId, "wrong", learn);
		assert.equal(onlyPoint(courseId).status, "gap", "the Learn chat's graded answer is the live verdict");

		const forgotten: Array<[string, string]> = [];
		const originalForget = apCourseStore.forgetChat;
		apCourseStore.forgetChat = (id: string, chatId: string) => {
			forgotten.push([id, chatId]);
			return originalForget.call(apCourseStore, id, chatId);
		};
		try {
			const outcome = await deleteChatSession(learn, "preserve-graph");
			assert.equal(outcome.ok, true);
		} finally {
			apCourseStore.forgetChat = originalForget;
		}
		assert.deepEqual(forgotten, [[courseId, learn]], "forgetChat(courseId, chatId) ran for the Learn chat");
		assert.equal(onlyPoint(courseId).status, "solid", "the sitting's answer alone replays to solid");
		assert.deepEqual(onlyPoint(courseId).history.map((attempt) => attempt.chatId), [sitting]);
	});

	it("deleting a plain teach chat does not touch any course", async () => {
		const chat = chatStore.createChat("Plain teach").id;
		const forgotten: unknown[] = [];
		const originalForget = apCourseStore.forgetChat;
		apCourseStore.forgetChat = (...args: Parameters<typeof originalForget>) => {
			forgotten.push(args);
			return originalForget.apply(apCourseStore, args);
		};
		try {
			const outcome = await deleteChatSession(chat, "preserve-graph");
			assert.equal(outcome.ok, true);
		} finally {
			apCourseStore.forgetChat = originalForget;
		}
		assert.deepEqual(forgotten, [], "no course forget for a chat with no course link");
	});
});
