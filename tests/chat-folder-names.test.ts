/**
 * GET /api/chats folder names (2026-11-17): the response carries
 * `folderNames` built from the test and AP-course record stores, so the
 * sidebar can label per-test / per-course folders. The `chats` payload
 * itself keeps its exact shape.
 *
 * Runs under an isolated LH_DATA_DIR, set before any config-loading import
 * (the test-prep-store discipline). A new file (not ap-api/chat-kind) so
 * parallel work on those files never collides. The route module is imported
 * once, after the data seams exist.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-folder-names-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { testStore } = await import("../src/store/tests.ts");
const { apCourseStore } = await import("../src/store/ap-courses.ts");

type ChatsRoute = typeof import("../app/api/chats/route.ts");
let route: ChatsRoute;
before(async () => {
	route = await import("../app/api/chats/route.ts");
});
after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

const BASE = "http://localhost";

function post(body: unknown): Promise<Response> {
	return route.POST(
		new Request(`${BASE}/api/chats`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("GET /api/chats folderNames", () => {
	it("maps test ids and AP course ids to their record titles", async () => {
		const test = testStore.create("SAT Math");
		const course = apCourseStore.create("AP Biology");

		assert.equal((await post({ title: "SAT prep", kind: "testprep", testId: test.id })).status, 200);
		assert.equal((await post({ title: "AP prep", kind: "ap", apCourseId: course.id })).status, 200);

		const res = await route.GET();
		assert.equal(res.status, 200);
		const body = (await res.json()) as {
			chats: Array<{ id: string; title: string }>;
			folderNames: { tests: Record<string, string>; ap: Record<string, string> };
		};

		assert.ok(Array.isArray(body.chats), "chats payload is still present");
		assert.equal(body.folderNames.tests[test.id], "SAT Math");
		assert.equal(body.folderNames.ap[course.id], "AP Biology");
	});
});