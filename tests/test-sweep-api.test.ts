/**
 * The sweep API seam (test material sweep, 2026-11-20): POST re-sweep,
 * POST additions, POST left-out, and the sweep GET view.
 *
 * The HTTP contract these routes pin:
 *   - POST /api/tests/[id]/sweep: 404 unknown, 400 no folder, 409 while a
 *     sweep runs or additions await review, 202 { started: true } otherwise
 *     (the sweep itself is fire-and-forget through the resweepOverride seam)
 *   - POST additions: { accepted: string[] } → resolveAdditions → 200 record;
 *     a review already resolved is a 409
 *   - POST left-out: { itemId } → promoteLeftOut → 200 record; an unknown
 *     item is a 404
 *   - GET sweep: { sweep, pendingAdditions }
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
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sweep-api-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { testStore } = await import("../src/store/tests.ts");
const { emptyCoverage } = await import("../src/core/test-prep.ts");
const sweepServer = await import("../src/server/sweep-engines.ts");

type SweepRoute = typeof import("../app/api/tests/[id]/sweep/route.ts");
type AdditionsRoute = typeof import("../app/api/tests/[id]/additions/route.ts");
type LeftOutRoute = typeof import("../app/api/tests/[id]/left-out/route.ts");
let sweepRoute: SweepRoute;
let additionsRoute: AdditionsRoute;
let leftOutRoute: LeftOutRoute;
before(async () => {
	sweepRoute = await import("../app/api/tests/[id]/sweep/route.ts");
	additionsRoute = await import("../app/api/tests/[id]/additions/route.ts");
	leftOutRoute = await import("../app/api/tests/[id]/left-out/route.ts");
});
after(() => {
	sweepServer.resweepOverride.current = undefined;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

type PlanDraftSection = import("../src/core/test-prep.ts").PlanDraftSection;

const BASE = "http://localhost";
const FOLDER = path.join(TMP_DATA, "materials");

function draft(): PlanDraftSection[] {
	return [
		{
			title: "Section A",
			points: [
				{ text: "Point one", source: "outline.md" },
				{ text: "Point two", source: "outline.md" },
			],
		},
	];
}

/** The resweepOverride seam: record each launch and answer success. */
interface ResweepCall {
	testId: string;
	mode: string;
	deps: unknown;
}
let resweepCalls: ResweepCall[] = [];
function stubResweep(): void {
	resweepCalls = [];
	sweepServer.resweepOverride.current = (testId, mode, deps) => {
		resweepCalls.push({ testId, mode, deps });
		return Promise.resolve({ ok: true, mode, points: 0, leftOut: 0, coverage: emptyCoverage() });
	};
}

function postSweep(id: string, origin = BASE): Promise<Response> {
	return sweepRoute.POST(
		new Request(`${BASE}/api/tests/${id}/sweep`, { method: "POST", headers: { origin } }),
		{ params: Promise.resolve({ id }) },
	);
}

function getSweep(id: string): Promise<Response> {
	return sweepRoute.GET(new Request(`${BASE}/api/tests/${id}/sweep`), { params: Promise.resolve({ id }) });
}

function postAdditions(id: string, body: unknown, origin = BASE): Promise<Response> {
	return additionsRoute.POST(
		new Request(`${BASE}/api/tests/${id}/additions`, {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id }) },
	);
}

function postLeftOut(id: string, body: unknown, origin = BASE): Promise<Response> {
	return leftOutRoute.POST(
		new Request(`${BASE}/api/tests/${id}/left-out`, {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id }) },
	);
}

describe("POST /api/tests/[id]/sweep", () => {
	it("is a 404 for an unknown test", async () => {
		stubResweep();
		const res = await postSweep("test_never_existed");
		assert.equal(res.status, 404);
		assert.equal(resweepCalls.length, 0);
	});

	it("is a 400 with 'no folder stored for this test' when the test has no folder", async () => {
		stubResweep();
		const test = testStore.create("No folder");
		const res = await postSweep(test.id);
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.equal(body.error, "no folder stored for this test");
		assert.equal(resweepCalls.length, 0);
	});

	it("is a 409 while a sweep is running", async () => {
		stubResweep();
		const test = testStore.create("Running", FOLDER);
		testStore.updateSweep(test.id, { status: "running", startedAt: "2026-01-01T00:00:00.000Z" });

		const res = await postSweep(test.id);
		assert.equal(res.status, 409);
		assert.equal(resweepCalls.length, 0);
	});

	it("is a 409 while additions await the learner's review", async () => {
		stubResweep();
		const test = testStore.create("Pending review", FOLDER);
		testStore.setPendingAdditions(test.id, { sections: [], leftOut: [] });

		const res = await postSweep(test.id);
		assert.equal(res.status, 409);
		assert.equal(resweepCalls.length, 0);
	});

	it("starts a re-sweep fire-and-forget and answers 202 { started: true }", async () => {
		stubResweep();
		const test = testStore.create("Sweep me", FOLDER);

		const res = await postSweep(test.id);
		assert.equal(res.status, 202);
		assert.deepEqual(await res.json(), { started: true });
		assert.equal(resweepCalls.length, 1);
		assert.equal(resweepCalls[0]!.testId, test.id);
		assert.equal(resweepCalls[0]!.mode, "resweep");
		const deps = resweepCalls[0]!.deps as { store: unknown; engines: unknown };
		assert.equal(deps.store, testStore, "the route injects the real test store");
		assert.ok(deps.engines, "the route injects the settings-resolved engines");
	});

	it("refuses a cross-origin launch", async () => {
		stubResweep();
		const test = testStore.create("Cross origin sweep", FOLDER);

		const res = await postSweep(test.id, "https://evil.example");
		assert.equal(res.status, 403);
		assert.equal(resweepCalls.length, 0, "a refused request never launches a sweep");
	});
});

describe("GET /api/tests/[id]/sweep", () => {
	it("serves { sweep, pendingAdditions } — and nulls when absent", async () => {
		const test = testStore.create("Sweep view", FOLDER);
		testStore.updateSweep(test.id, {
			status: "done",
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:01:00.000Z",
		});
		testStore.setPendingAdditions(test.id, { sections: [], leftOut: [] });

		const res = await getSweep(test.id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as Record<string, unknown>;
		assert.deepEqual(Object.keys(body).sort(), ["pendingAdditions", "sweep"]);
		assert.equal((body.sweep as { status: string }).status, "done");
		assert.ok(body.pendingAdditions, "the pending review rides along");

		const empty = testStore.create("Nothing yet", FOLDER);
		const emptyRes = await getSweep(empty.id);
		assert.equal(emptyRes.status, 200);
		assert.deepEqual(await emptyRes.json(), { sweep: null, pendingAdditions: null });
	});

	it("is a 404 for an unknown test", async () => {
		const res = await getSweep("test_never_existed");
		assert.equal(res.status, 404);
	});
});

describe("POST /api/tests/[id]/additions", () => {
	it("resolves accepted keys and returns the updated record", async () => {
		const test = testStore.create("Additions", FOLDER);
		testStore.savePlan(test.id, draft(), true);
		testStore.setPendingAdditions(test.id, {
			sections: [{ title: "Section A", points: [{ text: "New point", source: "new.pdf" }] }],
			leftOut: [],
		});

		const res = await postAdditions(test.id, { accepted: ["0:0"] });
		assert.equal(res.status, 200);
		const record = (await res.json()) as {
			pendingAdditions?: unknown;
			sections: Array<{ points: Array<{ text: string }> }>;
		};
		assert.equal(record.pendingAdditions, undefined, "the review is cleared");
		assert.equal(record.sections[0]?.points.length, 3);
		assert.ok(record.sections[0]?.points.some((point) => point.text === "New point"));
		assert.equal(testStore.get(test.id)?.pendingAdditions, undefined);
	});

	it("refuses a cross-origin review", async () => {
		const test = testStore.create("Cross origin additions", FOLDER);
		testStore.setPendingAdditions(test.id, {
			sections: [{ title: "Section A", points: [{ text: "New point", source: "new.pdf" }] }],
			leftOut: [],
		});

		const res = await postAdditions(test.id, { accepted: ["0:0"] }, "https://evil.example");
		assert.equal(res.status, 403);
		assert.ok(testStore.get(test.id)?.pendingAdditions, "a refused request never writes");
	});

	it("is a 400 when accepted is not an array of strings", async () => {
		const test = testStore.create("Bad accepted", FOLDER);
		const notArray = await postAdditions(test.id, { accepted: "0:0" });
		assert.equal(notArray.status, 400);
		const notStrings = await postAdditions(test.id, { accepted: [1] });
		assert.equal(notStrings.status, 400);
	});

	it("is a 409 when no review is pending", async () => {
		const test = testStore.create("No review", FOLDER);
		const res = await postAdditions(test.id, { accepted: [] });
		assert.equal(res.status, 409);
	});

	it("is a 404 for an unknown test", async () => {
		const res = await postAdditions("test_never_existed", { accepted: [] });
		assert.equal(res.status, 404);
	});
});

describe("POST /api/tests/[id]/left-out", () => {
	it("promotes an item into the plan and returns the updated record", async () => {
		const test = testStore.create("Promote", FOLDER);
		const saved = testStore.saveSweepPlan(test.id, draft(), [
			{ text: "Deep fact", source: "notes.pdf", reason: "detail", suggestedSection: "Section A" },
		]);
		const item = saved.leftOut?.[0];
		assert.ok(item, "the sweep minted a left-out item");

		const res = await postLeftOut(test.id, { itemId: item.id });
		assert.equal(res.status, 200);
		const record = (await res.json()) as {
			leftOut: unknown[];
			sections: Array<{ points: Array<{ text: string }> }>;
		};
		assert.equal(record.leftOut.length, 0, "the item leaves leftOut");
		assert.equal(record.sections[0]?.points.length, 3);
		assert.ok(record.sections[0]?.points.some((point) => point.text === "Deep fact"));
	});

	it("refuses a cross-origin promotion", async () => {
		const test = testStore.create("Cross origin left-out", FOLDER);
		const saved = testStore.saveSweepPlan(test.id, draft(), [
			{ text: "Deep fact", source: "notes.pdf", reason: "detail" },
		]);
		const item = saved.leftOut?.[0];
		assert.ok(item, "the sweep minted a left-out item");

		const res = await postLeftOut(test.id, { itemId: item.id }, "https://evil.example");
		assert.equal(res.status, 403);
		assert.equal(testStore.get(test.id)?.leftOut?.length, 1, "a refused request never writes");
	});

	it("is a 404 for an unknown left-out item", async () => {
		const test = testStore.create("Unknown item", FOLDER);
		testStore.saveSweepPlan(test.id, draft(), []);
		const res = await postLeftOut(test.id, { itemId: "test_missing_item" });
		assert.equal(res.status, 404);
	});

	it("is a 400 when itemId is not a string", async () => {
		const test = testStore.create("Bad item id", FOLDER);
		const res = await postLeftOut(test.id, { itemId: 42 });
		assert.equal(res.status, 400);
	});

	it("is a 409 when there is no plan section to promote into", async () => {
		const test = testStore.create("No sections", FOLDER);
		testStore.setPendingAdditions(test.id, {
			sections: [],
			leftOut: [{ id: "test_orphan", text: "Orphan", source: "x.pdf", reason: "detail" }],
		});
		const resolved = testStore.resolveAdditions(test.id, []);
		const item = resolved.leftOut?.[0];
		assert.ok(item, "the orphan rode through the review");

		const res = await postLeftOut(test.id, { itemId: item.id });
		assert.equal(res.status, 409);
	});

	it("is a 404 for an unknown test", async () => {
		const res = await postLeftOut("test_never_existed", { itemId: "x" });
		assert.equal(res.status, 404);
	});
});

describe("sweepEngines", () => {
	it("drops an engine whose construction throws", () => {
		const engines = sweepServer.sweepEngines(() => {
			throw new Error("model not in catalog");
		});
		assert.deepEqual(engines, {});
	});
});