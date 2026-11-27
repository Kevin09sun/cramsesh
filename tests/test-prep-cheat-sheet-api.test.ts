/**
 * The cheat sheet API seam (issue #15): GET serves the stored sheet and the
 * build state; POST starts one background build through the override seam.
 *
 * The HTTP contract these routes pin:
 *   - POST: 403 cross-origin, 404 unknown, 409 unconfirmed plan, 409 while a
 *     build runs, 202 { started: true } otherwise
 *   - GET: { cheatSheet, build }; a dead process's "running" is closed as an
 *     error before the answer
 *
 * Runs under an isolated LH_DATA_DIR, set before any config-loading import
 * (the test-prep-store discipline every route test shares).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cheat-sheet-api-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { testStore } = await import("../src/store/tests.ts");
const cheatSheetServer = await import("../src/server/cheat-sheet.ts");

type Route = typeof import("../app/api/tests/[id]/cheat-sheet/route.ts");
let route: Route;
before(async () => {
	route = await import("../app/api/tests/[id]/cheat-sheet/route.ts");
});
after(() => {
	cheatSheetServer.cheatSheetOverride.current = undefined;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

const BASE = "http://localhost";

function seeded(title: string, confirm = true): string {
	const test = testStore.create(title);
	testStore.savePlan(
		test.id,
		[
			{
				title: "Section A",
				points: [
					{ text: "Point one", source: "notes.pdf p. 3" },
					{ text: "Point two", source: "notes.pdf p. 4" },
				],
			},
		],
		confirm,
	);
	return test.id;
}

function get(id: string): Promise<Response> {
	return route.GET(new Request(`${BASE}/api/tests/${id}/cheat-sheet`), {
		params: Promise.resolve({ id }),
	});
}

function post(id: string, origin = BASE): Promise<Response> {
	return route.POST(
		new Request(`${BASE}/api/tests/${id}/cheat-sheet`, { method: "POST", headers: { origin } }),
		{ params: Promise.resolve({ id }) },
	);
}

const SHEET = {
	generatedAt: "2026-11-27T10:00:00.000Z",
	intro: "Everything for the midterm.",
	sections: [
		{
			id: "section_1",
			title: "Section A",
			idea: "The core idea.",
			facts: [{ label: "Term", body: "The fact." }],
			formulas: [],
			source: "notes.pdf p. 3",
		},
	],
};

describe("POST /api/tests/[id]/cheat-sheet", () => {
	it("refuses a cross-origin caller", async () => {
		const id = seeded("Guarded");
		const res = await post(id, "https://evil.example");
		assert.equal(res.status, 403);
		assert.equal(testStore.get(id)?.cheatSheetBuild, undefined, "no build started");
	});

	it("is a 404 for an unknown test", async () => {
		const res = await post("test_never_existed");
		assert.equal(res.status, 404);
	});

	it("refuses an unconfirmed plan", async () => {
		const id = seeded("Pending", false);
		const res = await post(id);
		assert.equal(res.status, 409);
		assert.match(((await res.json()) as { error: string }).error, /Confirm the plan/);
		assert.equal(testStore.get(id)?.cheatSheetBuild, undefined);
	});

	it("starts one build and refuses a second while it runs", async () => {
		const id = seeded("Building");
		let calls = 0;
		cheatSheetServer.cheatSheetOverride.current = async () => {
			calls += 1;
			return { ok: true, sections: 1 };
		};

		const res = await post(id);
		assert.equal(res.status, 202);
		assert.deepEqual(await res.json(), { started: true });
		assert.equal(testStore.get(id)?.cheatSheetBuild?.status, "running");

		const second = await post(id);
		assert.equal(second.status, 409);
		assert.match(((await second.json()) as { error: string }).error, /already being built/);
		assert.equal(calls, 1, "the second POST never launches a second build");
	});

	it("records the build failure the runner reports", async () => {
		const id = seeded("Failing");
		cheatSheetServer.cheatSheetOverride.current = async () => {
			throw new Error("The writer gave up.");
		};

		assert.equal((await post(id)).status, 202);
		// The launch is fire-and-forget: let the rejection land.
		await new Promise((resolve) => setTimeout(resolve, 20));

		const record = testStore.get(id)!;
		assert.equal(record.cheatSheetBuild?.status, "error");
		assert.equal(record.cheatSheetBuild?.error, "The writer gave up.");
		assert.equal(record.cheatSheet, undefined, "a failed build keeps no sheet");
	});
});

describe("GET /api/tests/[id]/cheat-sheet", () => {
	it("is a 404 for an unknown test", async () => {
		const res = await get("test_never_existed");
		assert.equal(res.status, 404);
	});

	it("serves a null sheet and build before the first build", async () => {
		const id = seeded("Empty");
		const res = await get(id);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { cheatSheet: null, build: null });
	});

	it("serves the stored sheet and clears the build marker", async () => {
		const id = seeded("Ready");
		testStore.updateCheatSheetBuild(id, { status: "running" });
		testStore.setCheatSheet(id, SHEET);

		const res = await get(id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { cheatSheet: typeof SHEET; build: unknown };
		assert.deepEqual(body.cheatSheet, SHEET);
		assert.equal(body.build, null, "a finished sheet never shows a build marker");
	});

	it("closes a running build whose process died", async () => {
		const id = seeded("Stale");
		testStore.updateCheatSheetBuild(id, {
			status: "running",
			startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
		});

		const res = await get(id);
		const body = (await res.json()) as { build: { status: string; error: string } };
		assert.equal(body.build.status, "error");
		assert.match(body.build.error, /stopped before it finished/);
		assert.equal(testStore.get(id)?.cheatSheetBuild?.status, "error", "the record is closed too");
	});
});