/**
 * Study-chat extraction threshold (study-chat extraction, 2026-11-17).
 *
 * Tests, AP and linked-Learn conversations are working sessions: their
 * knowledge should reach the graph while the session is still running, so
 * they extract after a smaller uncovered budget than teaching sessions.
 * This helper only picks the trigger threshold — the pipeline's batch
 * sizing stays on the configured chunk budget, and practice sessions never
 * reach it (the caller's guard excludes them).
 */

import type { ChatRecord } from "./contracts/chat.ts";

/** The uncovered-token budget study chats extract at (≈1k, not the 4096
 *  default): small enough that a session's findings arrive mid-session,
 *  large enough to keep the per-run graph overhead amortized. */
export const STUDY_EXTRACTION_TRIGGER_TOKENS = 1024;

/** The extraction trigger threshold for a chat: study chats (Test prep, AP,
 *  and linked-Learn sessions — a course id without a kind) use
 *  `Math.min(configured, STUDY_EXTRACTION_TRIGGER_TOKENS)` so a smaller
 *  configured budget still wins; every other kind keeps `configured`. */
export function extractionTriggerTokens(
	record: Pick<ChatRecord, "kind" | "apCourseId">,
	configured: number,
): number {
	const study = record.kind === "testprep" || record.kind === "ap" || record.apCourseId !== undefined;
	return study ? Math.min(configured, STUDY_EXTRACTION_TRIGGER_TOKENS) : configured;
}