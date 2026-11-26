/**
 * POST /api/tests/[id]/skip (issue #13): the sitting's Skip seam. The learner
 * removes an irrelevant check_point's point from the plan in one click; the
 * point leaves the plan and lands in leftOut ("skipped by you"), so it stays
 * recoverable from the readiness page.
 *
 * Pinned here: a valid skip answers 200 with the updated record; an unknown
 * point is an idempotent 200 that writes nothing; the plan's last point is a
 * 409; malformed bodies are 400, unknown tests 404, and a cross-origin
 * mutation is refused.
 *
 * Runs under an isolated LH_DATA_DIR, set before any config-loading import
 * (the test-prep-store discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-prep-skip-route-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { testStore } = await import("../src/store/tests.ts");

type Route = typeof import("../app/api/tests/[id]/skip/route.ts");
let route: Route;
before(async () => {
	route = await import("../app/api/tests/[id]/skip/route.ts");
});
after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

const BASE = "http://localhost";

const DRAFT = [
	{
		title: "Section A",
		points: [
			{ text: "Point one", source: "outline.md" },
			{ text: "Point two", source: "outline.md" },
		],
	},
];

function post(
	id: string,
	body: unknown,
	headers: Record<string, string> = { origin: BASE, "content-type": "application/json" },
): Promise<Response> {
	return route.POST(
		new Request(`${BASE}/api/tests/${id}/skip`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id }) },
	);
}

describe("POST /api/tests/[id]/skip", () => {
	it("removes the point, keeps confirmation and answers the updated record", async () => {
		const test = testStore.create("Skip me");
		const saved = testStore.savePlan(test.id, DRAFT, true);
		const [first, second] = saved.sections[0]!.points;

		const res = await post(test.id, { pointId: first!.id });
		assert.equal(res.status, 200);
		const record = (await res.json()) as {
			planConfirmed: boolean;
			sections: Array<{ points: Array<{ id: string }> }>;
			leftOut?: Array<{ text: string; reason: string }>;
		};
		assert.equal(record.planConfirmed, true);
		assert.deepEqual(record.sections[0]!.points.map((point) => point.id), [second!.id]);
		assert.equal(record.leftOut?.[0]?.text, "Point one");
		assert.equal(record.leftOut?.[0]?.reason, "skipped by you");
	});

	it("is an idempotent 200 for a point already gone, and writes nothing", async () => {
		const test = testStore.create("Skip twice");
		const saved = testStore.savePlan(test.id, DRAFT, true);
		const pointId = saved.sections[0]!.points[0]!.id;

		assert.equal((await post(test.id, { pointId })).status, 200);
		const once = testStore.get(test.id);
		assert.equal((await post(test.id, { pointId })).status, 200);
		assert.deepEqual(testStore.get(test.id), once);
	});

	it("refuses to skip the plan's last point with a 409", async () => {
		const test = testStore.create("Skip last");
		const saved = testStore.savePlan(
			test.id,
			[{ title: "Only", points: [{ text: "The only point", source: "n.md" }] }],
			true,
		);
		const res = await post(test.id, { pointId: saved.sections[0]!.points[0]!.id });
		assert.equal(res.status, 409);
		assert.deepEqual(testStore.get(test.id), saved, "a refused skip never writes");
	});

	it("is a 400 for a missing or non-string pointId", async () => {
		const test = testStore.create("Bad body");
		testStore.savePlan(test.id, DRAFT, true);
		assert.equal((await post(test.id, {})).status, 400);
		assert.equal((await post(test.id, { pointId: 42 })).status, 400);
		assert.equal((await post(test.id, { pointId: "" })).status, 400);
	});

	it("is a 404 for an unknown test", async () => {
		assert.equal((await post("test_never_existed", { pointId: "p1" })).status, 404);
	});

	it("refuses a cross-origin mutation", async () => {
		const test = testStore.create("Cross origin");
		const saved = testStore.savePlan(test.id, DRAFT, true);
		const res = await post(
			test.id,
			{ pointId: saved.sections[0]!.points[0]!.id },
			{ origin: "https://evil.example", "content-type": "application/json" },
		);
		assert.equal(res.status, 403);
		assert.deepEqual(testStore.get(test.id), saved, "a refused request never writes");
	});
});