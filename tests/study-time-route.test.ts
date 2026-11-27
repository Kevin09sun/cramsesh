/**
 * The session clock's write seam (issue #16): POST /api/chats/[id]/time and
 * the store behind it.
 *
 * Pinned here: a heartbeat chunk lands in the record's per-day log, chunks
 * MERGE per day (a session never grows a second entry for the same day),
 * the session total rides the summary as timeMs (the per-day log does not),
 * the tracker's read folds every session, and the store's "a timer is not
 * conversation activity" rule keeps updatedAt put — sidebar order never
 * churns on a heartbeat. Malformed chunks write nothing.
 *
 * Runs under an isolated LH_DATA_DIR, set before any config-loading import
 * (the chat-store-events discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-time-route-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { POST } = await import("../app/api/chats/[id]/time/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

function request(id: string, body: unknown): Request {
	return new Request(`http://localhost/api/chats/${id}/time`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function call(id: string, body: unknown): Promise<Response> {
	return POST(request(id, body), { params: Promise.resolve({ id }) });
}

describe("POST /api/chats/[id]/time", () => {
	it("creates the day's entry and answers with the session total", async () => {
		const chat = chatStore.createChat("Clock fixture");
		const response = await call(chat.id, { day: "2026-11-27", ms: 15_000 });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { timeMs: 15_000 });
		assert.deepEqual(chatStore.getChat(chat.id)?.studyTime, [{ day: "2026-11-27", ms: 15_000 }]);
	});

	it("merges chunks into ONE entry per day, across days in order", async () => {
		const chat = chatStore.createChat("Merge fixture");
		await call(chat.id, { day: "2026-11-27", ms: 15_000 });
		await call(chat.id, { day: "2026-11-27", ms: 30_000 });
		const response = await call(chat.id, { day: "2026-11-28", ms: 5_000 });
		assert.deepEqual(await response.json(), { timeMs: 50_000 });
		assert.deepEqual(chatStore.getChat(chat.id)?.studyTime, [
			{ day: "2026-11-27", ms: 45_000 },
			{ day: "2026-11-28", ms: 5_000 },
		]);
	});

	it("carries the total on the summary and keeps the per-day log out of the list payload", async () => {
		const chat = chatStore.createChat("Summary fixture");
		await call(chat.id, { day: "2026-11-27", ms: 25_000 });
		const summary = chatStore.listChats().find((entry) => entry.id === chat.id);
		assert.ok(summary);
		assert.equal(summary.timeMs, 25_000);
		assert.ok(!("studyTime" in summary), "the per-day log stays out of the list, like turns");
	});

	it("a session with no counted time carries no timeMs at all (never a fake zero)", async () => {
		const chat = chatStore.createChat("Untimed fixture");
		const summary = chatStore.listChats().find((entry) => entry.id === chat.id);
		assert.ok(summary);
		assert.ok(!("timeMs" in summary));
	});

	it("a heartbeat is NOT conversation activity: updatedAt stays put", async () => {
		const chat = chatStore.createChat("Order fixture");
		const before = chatStore.getChat(chat.id)?.updatedAt;
		await call(chat.id, { day: "2026-11-27", ms: 15_000 });
		assert.equal(chatStore.getChat(chat.id)?.updatedAt, before, "sidebar order must not churn on a timer");
	});

	it("folds every session into the tracker's per-day read", async () => {
		const a = chatStore.createChat("Tracker A");
		const b = chatStore.createChat("Tracker B");
		await call(a.id, { day: "2026-10-01", ms: 60_000 });
		await call(b.id, { day: "2026-10-01", ms: 30_000 });
		await call(b.id, { day: "2026-10-02", ms: 15_000 });
		const byDay = chatStore.studyTimeByDay();
		assert.deepEqual(byDay.find((entry) => entry.day === "2026-10-01"), { day: "2026-10-01", ms: 90_000 });
		assert.deepEqual(byDay.find((entry) => entry.day === "2026-10-02"), { day: "2026-10-02", ms: 15_000 });
		const keys = byDay.map((entry) => entry.day);
		assert.deepEqual([...keys].sort(), keys, "days ascending");
	});

	it("refuses malformed chunks and writes nothing", async () => {
		const chat = chatStore.createChat("Refusal fixture");
		for (const body of [
			null,
			{},
			{ day: "2026-02-31", ms: 15_000 },
			{ day: "2026-11-27", ms: 0 },
			{ day: "2026-11-27", ms: 1.5 },
			{ day: "2026-11-27", ms: 60 * 60_000 },
			{ day: "2026-11-27", ms: "15000" },
		]) {
			const response = await call(chat.id, body);
			assert.equal(response.status, 400, JSON.stringify(body));
		}
		assert.equal(chatStore.getChat(chat.id)?.studyTime, undefined);
	});

	it("an unknown session is a 404", async () => {
		const response = await call("chat_does_not_exist", { day: "2026-11-27", ms: 15_000 });
		assert.equal(response.status, 404);
	});
});