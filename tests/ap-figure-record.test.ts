/**
 * AN AP TURN'S FIGURE VIEW IS NOT SAVED AS AN IMAGE (AP prep stage 3,
 * 2026-11-15). Stage 2's persistTurn replaces every image part in an AP tool
 * result with one note, so ap_view_figure's PNG rides the live turn only and
 * the chat's viewed set is later derived from the fixed caption alone.
 *
 * Runs under an isolated LH_DATA_DIR, set before ANY import that can load
 * config.ts at module scope (the test-prep-store discipline): config.ts
 * resolves the data root at import time, so every module below that can reach
 * it is loaded with a dynamic import AFTER the temp root is in place.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import type { LhMessage } from "../src/core/native-messages.ts";

// ── the store seam, BEFORE any config-loading import ────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-figure-record-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { viewedFiguresFrom } = await import("../src/agent/tools/ap.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

const OK_TEXT = "Figure fig_ready, as the learner will see it.";

function assistantCall(id: string, name: string, args: unknown): LhMessage {
	return {
		id: `m_${id}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as unknown as LhMessage;
}

function toolResult(id: string, text: string): LhMessage {
	return {
		id: `m_r_${id}`,
		role: "toolResult",
		toolCallId: id,
		toolName: "ap_view_figure",
		content: [
			{ type: "text", text },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		],
		details: null,
		isError: false,
		timestamp: 1,
	} as unknown as LhMessage;
}

describe("an ap_view_figure result in an AP turn", () => {
	it("is saved without its image, and the saved set derives from the record", () => {
		const chat = chatStore.createChat("Test: AP figure images not kept", "ap", undefined, {
			courseId: "ap_figures",
		});
		const call = assistantCall("fig_call_1", "ap_view_figure", { figure: "fig_ready" });
		const result = toolResult("fig_call_1", OK_TEXT);

		persistTurn(chatStore, chat.id, 0, [call, result], false);

		const record = chatStore.getChat(chat.id)!;
		const saved = record.messages.find((message) => message.role === "toolResult")!;
		assert.deepEqual((saved as { content: unknown }).content, [
			{ type: "text", text: OK_TEXT },
			{ type: "text", text: "[Image viewed during this turn; not kept in the session.]" },
		]);
		assert.ok(!JSON.stringify(record).includes("AAAA"), "no image bytes reach the record");
		assert.deepEqual((result as { content: unknown }).content, [
			{ type: "text", text: OK_TEXT },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		], "the live turn's message keeps its image");
		assert.deepEqual([...viewedFiguresFrom(record.messages)], ["fig_ready"]);
	});
});
