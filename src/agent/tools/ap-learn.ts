/**
 * AP LEARN GRADING (session folders, 2026-11-17): a teach session linked to
 * an AP course (apCourseId + apLearn) records the learner's graded check
 * answers into that course, so Learn moves the course's progress the same
 * way a practice sitting does.
 *
 * The tool keeps the sitting tool's name and input schema. Its gates mirror
 * the sitting tool's (course exists, list confirmed, topic known and in
 * scope) minus the sitting requirement: the Learn scope stands in for it.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { topicInScope } from "../../core/ap.ts";
import type { ApCourseRecord, ApLearnScope } from "../../core/ap.ts";
import { readiness, readinessPercent } from "../../core/test-prep.ts";
import { invalidInputResult } from "../tool-execute.ts";
import { apRecordResultInputObject, locateTopic, type ApCourseStorePort } from "./ap.ts";
import { healEncodedArguments } from "./heal.ts";

export interface ApLearnToolContext {
	chatId: string;
	courseId: string;
	scope: ApLearnScope;
	courses: Pick<ApCourseStorePort, "get" | "recordResult">;
}

/** The listing half of the gate: the course must exist and its unit and
 *  topic list must be confirmed. Empty result = the call may proceed. */
function learnListingProblems(course: ApCourseRecord | null, courseId: string): string[] {
	if (!course) return [`course "${courseId}" was not found`];
	if (!course.planConfirmed) {
		return ["the course's unit and topic list is not confirmed — nothing can be recorded until the learner confirms it"];
	}
	return [];
}

/** The topic half: it must exist in the confirmed list and fall inside the
 *  Learn session's scope. */
function learnTopicProblems(course: ApCourseRecord, scope: ApLearnScope, topicId: string): string[] {
	if (!locateTopic(course, topicId)) {
		return [`topicId "${topicId}" is not in the confirmed list — use an id from the topics listed for this session`];
	}
	if (!topicInScope(course, scope, topicId)) {
		return [`topicId "${topicId}" is outside this session's scope — use an id from the topics listed for this session`];
	}
	return [];
}

function textResult(text: string): AgentToolResult<string> {
	return { content: [{ type: "text", text }], details: text };
}

function apLearnRecordResultTool(ctx: ApLearnToolContext): AgentTool<typeof apRecordResultInputObject> {
	return {
		name: "ap_record_result",
		label: "ap_record_result",
		description:
			"Record the learner's graded outcome on a check question for one topic of the linked AP course: " +
			"correct, wrong, or dontKnow. Updates the topic's status and returns it plus overall readiness. " +
			"Refused before the course's list is confirmed and for a topic id outside this session's topics. " +
			"Call it once per graded answer, immediately after grading.",
		parameters: apRecordResultInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, apRecordResultInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const course = ctx.courses.get(ctx.courseId);
			const listingProblems = learnListingProblems(course, ctx.courseId);
			if (listingProblems.length > 0) return invalidInputResult("ap_record_result", listingProblems);
			const topicProblems = learnTopicProblems(course!, ctx.scope, input.topicId);
			if (topicProblems.length > 0) return invalidInputResult("ap_record_result", topicProblems);

			const updated = ctx.courses.recordResult(ctx.courseId, input.topicId, input.result, ctx.chatId);
			const located = locateTopic(updated, input.topicId);
			const totals = readiness(updated).sections.reduce(
				(acc, unit) => ({ solid: acc.solid + unit.solid, total: acc.total + unit.total }),
				{ solid: 0, total: 0 },
			);
			return textResult(
				`Topic ${input.topicId} is now ${located?.topic.status ?? "unknown"}.\n` +
					`Overall readiness: ${readinessPercent(totals.solid, totals.total)}% (${totals.solid}/${totals.total} points solid).`,
			);
		},
	};
}

export function apLearnTools(ctx: ApLearnToolContext): {
	ap_record_result: AgentTool<typeof apRecordResultInputObject>;
} {
	return { ap_record_result: apLearnRecordResultTool(ctx) };
}

/** The instruction appended to a linked Learn session's system prompt: when
 *  to grade-record, and the in-scope topic ids to record against. */
export function apLearnInstruction(courseTitle: string, topics: Array<{ id: string; text: string }>): string {
	void courseTitle;
	return (
		"This session is linked to an AP course. When you grade the learner's answer to a check question " +
		"(a quiz item or an explain-it-back), call ap_record_result with the topicId of the topic that check " +
		"tested and the result: correct, wrong, or dontKnow. Record only answers you actually graded; never " +
		"record anything for reading or explanation alone.\n" +
		"Topics in this session:\n" +
		topics.map((topic) => `- ${topic.id} — ${topic.text}`).join("\n")
	);
}
