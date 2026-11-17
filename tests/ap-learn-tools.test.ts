/**
 * AP LEARN GRADING (session folders, 2026-11-17): a teach session linked to
 * an AP course (apCourseId + apLearn) gives the teacher a scoped
 * ap_record_result, so a graded check answer moves the course's progress.
 * The gates mirror the sitting tool's minus the sitting requirement: the
 * course must exist, its list must be confirmed, and the topic must be known
 * and inside the Learn scope. Refusals are retryable invalidInputResult
 * errors that leave the fake untouched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ApCourseRecord, ApLearnScope } from "../src/core/ap.ts";
import type { AnswerResult } from "../src/core/test-prep.ts";
import { apLearnInstruction, apLearnTools, type ApLearnToolContext } from "../src/agent/tools/ap-learn.ts";
import { createTeacherTools } from "../src/agent/tools.ts";

const COURSE: ApCourseRecord = {
	id: "ap_course_1",
	title: "AP Calculus BC",
	createdAt: "2026-11-17T00:00:00.000Z",
	updatedAt: "2026-11-17T00:00:00.000Z",
	planConfirmed: true,
	documents: [],
	sections: [
		{
			id: "unit_limits",
			title: "Unit 1 Limits",
			points: [
				{ id: "t_intro", text: "1.1 Introducing Calculus", source: "p. 12", status: "unchecked", history: [] },
				{ id: "t_define", text: "1.2 Defining Limits", source: "p. 14", status: "unchecked", history: [] },
			],
		},
		{
			id: "unit_deriv",
			title: "Unit 2 Derivatives",
			points: [{ id: "t_gap", text: "2.1 Definition", source: "p. 30", status: "gap", history: [] }],
		},
	],
	version: 1,
};

type RecordCall = [string, string, AnswerResult, string];

function fakeCourses(course: ApCourseRecord | null) {
	const calls: RecordCall[] = [];
	const courses: ApLearnToolContext["courses"] = {
		get: (id) => (course && id === course.id ? course : null),
		recordResult: (id, topicId, result, chatId) => {
			calls.push([id, topicId, result, chatId]);
			return course!;
		},
	};
	return { courses, calls };
}

function ctxOf(scope: ApLearnScope, course: ApCourseRecord | null = COURSE) {
	const fake = fakeCourses(course);
	const ctx: ApLearnToolContext = { chatId: "chat_learn", courseId: COURSE.id, scope, courses: fake.courses };
	return { ctx, calls: fake.calls };
}

async function run(ctx: ApLearnToolContext, input: { topicId: string; result: AnswerResult }) {
	const tool = apLearnTools(ctx).ap_record_result;
	return tool.execute("call-1", input as never, undefined as never, undefined as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("ap_record_result in a linked Learn session", () => {
	it("in-scope topic → recordResult called with (courseId, topicId, result, chatId)", async () => {
		const { ctx, calls } = ctxOf({ type: "topic", topicId: "t_intro" });
		const result = await run(ctx, { topicId: "t_intro", result: "correct" });
		assert.notEqual((result as { isError?: boolean }).isError, true);
		assert.deepEqual(calls, [[COURSE.id, "t_intro", "correct", "chat_learn"]]);
	});

	it("unit scope accepts any topic in that unit, refuses a topic in another unit", async () => {
		const { ctx, calls } = ctxOf({ type: "unit", unitId: "unit_limits" });
		await run(ctx, { topicId: "t_intro", result: "wrong" });
		await run(ctx, { topicId: "t_define", result: "dontKnow" });
		const refused = await run(ctx, { topicId: "t_gap", result: "correct" });
		assert.equal((refused as { isError?: boolean }).isError, true);
		assert.match(textOf(refused), /t_gap/);
		assert.deepEqual(calls, [
			[COURSE.id, "t_intro", "wrong", "chat_learn"],
			[COURSE.id, "t_define", "dontKnow", "chat_learn"],
		]);
	});

	it("refuses a topic outside a single-topic scope", async () => {
		const { ctx, calls } = ctxOf({ type: "topic", topicId: "t_intro" });
		const refused = await run(ctx, { topicId: "t_define", result: "correct" });
		assert.equal((refused as { isError?: boolean }).isError, true);
		assert.deepEqual(calls, []);
	});

	it("refuses unknown topic", async () => {
		const { ctx, calls } = ctxOf({ type: "unit", unitId: "unit_limits" });
		const refused = await run(ctx, { topicId: "t_missing", result: "correct" });
		assert.equal((refused as { isError?: boolean }).isError, true);
		assert.match(textOf(refused), /t_missing/);
		assert.deepEqual(calls, []);
	});

	it("refuses when the course plan is not confirmed", async () => {
		const { ctx, calls } = ctxOf({ type: "topic", topicId: "t_intro" }, { ...COURSE, planConfirmed: false });
		const refused = await run(ctx, { topicId: "t_intro", result: "correct" });
		assert.equal((refused as { isError?: boolean }).isError, true);
		assert.match(textOf(refused), /not confirmed/);
		assert.deepEqual(calls, []);
	});

	it("refuses when the course is missing", async () => {
		const { ctx, calls } = ctxOf({ type: "topic", topicId: "t_intro" }, null);
		const refused = await run(ctx, { topicId: "t_intro", result: "correct" });
		assert.equal((refused as { isError?: boolean }).isError, true);
		assert.match(textOf(refused), /was not found/);
		assert.deepEqual(calls, []);
	});
});

describe("apLearnInstruction", () => {
	it('lists each topic as "<id> — <text>" and names ap_record_result', () => {
		const text = apLearnInstruction("AP Calculus BC", [
			{ id: "t_intro", text: "1.1 Introducing Calculus" },
			{ id: "t_define", text: "1.2 Defining Limits" },
		]);
		assert.match(text, /ap_record_result/);
		assert.ok(text.includes("- t_intro — 1.1 Introducing Calculus"), text);
		assert.ok(text.includes("- t_define — 1.2 Defining Limits"), text);
		assert.ok(text.includes("Topics in this session:"), text);
	});
});

describe("createTeacherTools registers ap_record_result only in a linked Learn session", () => {
	const base = {
		chatId: "chat_learn",
		chatStore: {} as never,
		jobStore: {} as never,
		spawn: () => {},
	};

	it("present with default toggles ({} — the settings default) when ctx.apLearn is set", () => {
		const { ctx } = ctxOf({ type: "topic", topicId: "t_intro" });
		const tools = createTeacherTools({ ...base, apLearn: ctx }, {});
		assert.ok(createTeacherTools({ ...base, apLearn: ctx }).ap_record_result, "also with no toggles at all");
		assert.ok(tools.ap_record_result, "the scoped tool is registered");
	});

	it("absent when ctx.apLearn is not set", () => {
		const tools = createTeacherTools(base, {});
		assert.equal(tools.ap_record_result, undefined);
	});
});
