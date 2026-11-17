/**
 * The extraction trigger's threshold (study-chat extraction, 2026-11-17):
 * Tests/AP/linked-Learn chats feed the graph after a smaller uncovered
 * budget than teaching sessions. The helper only decides the threshold —
 * the call site still guards practice sessions out and the pipeline's
 * batch sizing stays on the configured chunk budget.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractionTriggerTokens, STUDY_EXTRACTION_TRIGGER_TOKENS } from "../src/core/extraction-trigger.ts";

describe("extractionTriggerTokens", () => {
	it("lowers Test prep sessions to the study trigger", () => {
		assert.equal(extractionTriggerTokens({ kind: "testprep" }, 4096), 1024);
	});

	it("lowers AP sessions to the study trigger", () => {
		assert.equal(extractionTriggerTokens({ kind: "ap", apCourseId: "c1" }, 4096), 1024);
	});

	it("treats a linked Learn session (course id, no kind) as study", () => {
		assert.equal(extractionTriggerTokens({ kind: undefined, apCourseId: "c1" }, 4096), 1024);
	});

	it("keeps teach sessions on the configured budget", () => {
		assert.equal(extractionTriggerTokens({ kind: "teach" }, 4096), 4096);
	});

	it("keeps unlinked sessions with no kind on the configured budget", () => {
		assert.equal(extractionTriggerTokens({ kind: undefined }, 4096), 4096);
	});

	it("never raises a configured budget below the study trigger", () => {
		assert.equal(extractionTriggerTokens({ kind: "testprep" }, 600), 600);
	});

	it("exposes the study trigger constant", () => {
		assert.equal(STUDY_EXTRACTION_TRIGGER_TOKENS, 1024);
	});
});