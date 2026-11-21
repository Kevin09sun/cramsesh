/**
 * TEST STORE PINS (test prep, 2026-11-10): one JSON file per test under
 * data/tests/ holds the plan and per-point progress. Every mutation is a
 * fresh read-modify-write (a plan edit made in the UI must never be
 * reverted by the next answer write), and the degraded read is honest:
 * a file that does not parse reads as absent and is never rewritten.
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-prep-store-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { testStore } = await import("../src/store/tests.ts");
const { readiness } = await import("../src/core/test-prep.ts");
const { subscribe } = await import("../src/core/events.ts");

type PlanDraftSection = import("../src/core/test-prep.ts").PlanDraftSection;

function draft(): PlanDraftSection[] {
	return [
		{
			title: "Section A",
			points: [
				{ text: "Point one", source: "notes.md" },
				{ text: "Point two", source: "notes.md" },
			],
		},
	];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("test store (test prep, 2026-11-10)", () => {
	it("create stores a record that get reads back", () => {
		const created = testStore.create("Algebra", "Math");

		assert.match(created.id, /^test_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.equal(created.title, "Algebra");
		assert.equal(created.folder, "Math");
		assert.equal(created.planConfirmed, false);
		assert.deepEqual(created.sections, []);
		assert.equal(created.version, 1);

		assert.deepEqual(testStore.get(created.id), created);
	});

	it("get returns null for an unknown id", () => {
		assert.equal(testStore.get("test_never_existed"), null);
	});

	it("list is sorted by updatedAt desc and carries readiness", async () => {
		const first = testStore.create("First");
		await sleep(5);
		const second = testStore.create("Second");

		testStore.savePlan(first.id, draft(), true);
		const points = testStore.get(first.id)!.sections[0]!.points;
		testStore.recordResult(first.id, points[0]!.id, "correct", "chat_1");

		const list = testStore.list();
		assert.ok(
			list.findIndex((test) => test.id === first.id) < list.findIndex((test) => test.id === second.id),
			"the more recently written test comes first",
		);

		const row = list.find((test) => test.id === first.id)!;
		assert.equal(row.title, "First");
		assert.equal(row.planConfirmed, true);
		assert.equal(row.readiness, 0.5, "one of two points is solid");
		assert.equal(list.find((test) => test.id === second.id)!.readiness, 0);
	});

	it("recordResult before the plan is confirmed throws 'plan not confirmed'", () => {
		const test = testStore.create("Unconfirmed");
		const saved = testStore.savePlan(test.id, draft(), false);
		const pointId = saved.sections[0]!.points[0]!.id;

		assert.equal(saved.planConfirmed, false);
		assert.throws(
			() => testStore.recordResult(test.id, pointId, "correct", "chat_1"),
			{ message: "plan not confirmed" },
		);
	});

	it("a revision saved unconfirmed clears a prior confirmation", () => {
		const test = testStore.create("Revision");
		const confirmed = testStore.savePlan(test.id, draft(), true);
		assert.equal(confirmed.planConfirmed, true);

		// propose_plan after confirmation saves the revision UNCONFIRMED: the
		// learner has not approved this scope yet, so questions must refuse.
		const revised = testStore.savePlan(test.id, draft(), false);
		assert.equal(revised.planConfirmed, false);
		assert.equal(testStore.get(test.id)!.planConfirmed, false);

		const pointId = revised.sections[0]!.points[0]!.id;
		assert.throws(
			() => testStore.recordResult(test.id, pointId, "correct", "chat_1"),
			{ message: "plan not confirmed" },
		);
	});

	it("recordResult on a missing point throws 'unknown point'", () => {
		const test = testStore.create("Missing point");
		testStore.savePlan(test.id, draft(), true);

		assert.throws(
			() => testStore.recordResult(test.id, "point_never_existed", "correct", "chat_1"),
			{ message: "unknown point" },
		);
	});

	it("a plan edit adding a point survives the next answer write (Review Focus 4)", () => {
		const test = testStore.create("Plan edit then answer");
		const confirmed = testStore.savePlan(test.id, draft(), true);
		const sectionId = confirmed.sections[0]!.id;
		const [pointOne, pointTwo] = confirmed.sections[0]!.points;

		// The learner edits the plan while a sitting is open: two existing
		// points stay, a third is added.
		const edited = testStore.savePlan(
			test.id,
			[
				{
					id: sectionId,
					title: "Section A",
					points: [
						{ id: pointOne!.id, text: pointOne!.text, source: pointOne!.source },
						{ id: pointTwo!.id, text: pointTwo!.text, source: pointTwo!.source },
						{ text: "Point three", source: "notes.md" },
					],
				},
			],
			true,
		);
		const addedId = edited.sections[0]!.points[2]!.id;

		// The next answer write re-reads the file, so the added point is not
		// reverted by a stale in-memory plan.
		const answered = testStore.recordResult(test.id, pointOne!.id, "correct", "chat_1");
		const ids = answered.sections[0]!.points.map((point) => point.id);
		assert.deepEqual(ids, [pointOne!.id, pointTwo!.id, addedId]);
		assert.equal(answered.sections[0]!.points[0]!.status, "solid");
	});

	it("get returns null for malformed JSON and never overwrites it", () => {
		const testsDir = path.join(TMP_DATA, "tests");
		fs.mkdirSync(testsDir, { recursive: true });
		const file = path.join(testsDir, "test_broken.json");
		fs.writeFileSync(file, "{ not json");

		assert.equal(testStore.get("test_broken"), null);
		assert.equal(fs.readFileSync(file, "utf-8"), "{ not json", "the unreadable record is left untouched");
	});

	it("list skips shape-invalid and non-record files individually; get refuses a shape-invalid record", () => {
		const testsDir = path.join(TMP_DATA, "tests");
		fs.mkdirSync(testsDir, { recursive: true });
		for (const file of fs.readdirSync(testsDir)) fs.rmSync(path.join(testsDir, file), { force: true });

		const valid = testStore.create("Valid");
		const badShape = path.join(testsDir, "test_bad_shape.json");
		const badBytes = JSON.stringify({ id: "test_bad_shape", title: 42 });
		fs.writeFileSync(badShape, badBytes);
		fs.writeFileSync(path.join(testsDir, "notes.json"), JSON.stringify({ hello: "world" }));
		fs.writeFileSync(path.join(testsDir, "test_x (1).json"), JSON.stringify({ hello: "world" }));

		assert.deepEqual(
			testStore.list().map((test) => test.id),
			[valid.id],
			"only the valid record is listed — bad shapes and non-test filenames are skipped individually",
		);
		assert.equal(testStore.get("test_bad_shape"), null, "a wrong-shaped record reads as absent");
		assert.equal(fs.readFileSync(badShape, "utf-8"), badBytes, "the wrong-shaped record is left untouched");
	});

	it("forgetChat erases a chat's results and lowers readiness", () => {
		const test = testStore.create("Forget chat");
		const saved = testStore.savePlan(
			test.id,
			[{ title: "Section A", points: [{ text: "Point one", source: "notes.md" }] }],
			true,
		);
		const pointId = saved.sections[0]!.points[0]!.id;

		// unchecked + correct → solid, so chat_A is the chat that earned the solid.
		const solid = testStore.recordResult(test.id, pointId, "correct", "chat_A");
		assert.equal(solid.sections[0]!.points[0]!.status, "solid");
		assert.equal(readiness(testStore.get(test.id)!).overall, 1);

		// A chat with no attempt changes nothing and does not write.
		assert.equal(testStore.forgetChat(test.id, "chat_nope"), false);
		assert.equal(readiness(testStore.get(test.id)!).overall, 1);

		// Forgetting the chat that earned the solid erases its result.
		assert.equal(testStore.forgetChat(test.id, "chat_A"), true);
		const after = testStore.get(test.id)!;
		assert.notEqual(after.sections[0]!.points[0]!.status, "solid");
		assert.equal(after.sections[0]!.points[0]!.history.length, 0);
		assert.equal(readiness(after).overall, 0);

		// A missing test returns false.
		assert.equal(testStore.forgetChat("test_never_existed", "chat_A"), false);
	});

	it("every mutation announces tests-changed after the write", () => {
		let announces = 0;
		const off = subscribe((event) => {
			if (event.type === "tests-changed") announces++;
		});

		const test = testStore.create("Events");
		assert.equal(announces, 1, "create announces");

		const saved = testStore.savePlan(test.id, draft(), true);
		assert.equal(announces, 2, "savePlan announces");

		testStore.recordResult(test.id, saved.sections[0]!.points[0]!.id, "correct", "chat_1");
		assert.equal(announces, 3, "recordResult announces");

		off();
	});
});

describe("test store — material sweep (2026-11-20)", () => {
	it("saveSweepPlan saves unconfirmed sections and leftOut", () => {
		const test = testStore.create("Sweep plan");
		const saved = testStore.saveSweepPlan(test.id, draft(), [
			{ text: "Chit-chat", source: "notes.md", reason: "not exam material" },
			{ id: "lo_keep", text: "Off-topic", source: "notes.md", reason: "aside", suggestedSection: "Section A" },
		]);

		assert.equal(saved.planConfirmed, false, "the draft awaits the learner's approval");
		assert.deepEqual(
			saved.sections.map((section) => section.title),
			["Section A"],
		);
		assert.deepEqual(
			saved.sections[0]!.points.map((point) => [point.text, point.status]),
			[
				["Point one", "unchecked"],
				["Point two", "unchecked"],
			],
		);
		assert.match(saved.sections[0]!.points[0]!.id, /^test_[0-9a-z]+_[0-9a-f]{8}$/);

		const leftOut = saved.leftOut!;
		assert.equal(leftOut.length, 2);
		assert.match(leftOut[0]!.id, /^test_[0-9a-z]+_[0-9a-f]{8}$/, "a missing id is minted");
		assert.equal(leftOut[0]!.reason, "not exam material");
		assert.equal(leftOut[1]!.id, "lo_keep", "an explicit id is kept");
		assert.equal(leftOut[1]!.suggestedSection, "Section A");

		assert.deepEqual(testStore.get(test.id), saved);
	});

	it("saveSweepPlan refuses when a plan exists", () => {
		const test = testStore.create("Already planned");
		testStore.saveSweepPlan(test.id, draft(), []);

		assert.throws(
			() => testStore.saveSweepPlan(test.id, draft(), []),
			{ message: "plan already exists" },
		);
	});

	it("updateSweep requires startedAt to start a sweep and merges later patches", () => {
		const test = testStore.create("Sweep progress");
		assert.throws(
			() => testStore.updateSweep(test.id, { status: "running" }),
			{ message: "sweep not started" },
		);

		const started = testStore.updateSweep(test.id, {
			status: "running",
			startedAt: "2026-11-20T10:00:00.000Z",
			activity: "reading ch1.pdf",
			fileHashes: {},
		});
		assert.equal(started.sweep!.startedAt, "2026-11-20T10:00:00.000Z");
		assert.equal(started.sweep!.activity, "reading ch1.pdf");

		const done = testStore.updateSweep(test.id, {
			status: "done",
			finishedAt: "2026-11-20T10:05:00.000Z",
		});
		assert.equal(done.sweep!.status, "done");
		assert.equal(done.sweep!.startedAt, "2026-11-20T10:00:00.000Z", "startedAt is kept");
		assert.equal(done.sweep!.activity, "reading ch1.pdf", "unpatched fields stay");
		assert.equal(testStore.get(test.id)!.sweep!.status, "done");
	});

	it("setFolder persists the folder", () => {
		const test = testStore.create("Folder test");
		const moved = testStore.setFolder(test.id, "Math");

		assert.equal(moved.folder, "Math");
		assert.equal(testStore.get(test.id)!.folder, "Math");
	});

	it("resolveAdditions adds accepted as unchecked, dropped go to leftOut, pendingAdditions cleared", () => {
		const test = testStore.create("Resweep");
		const base = testStore.saveSweepPlan(
			test.id,
			[{ title: "Section A", points: [{ text: "Existing", source: "notes.md" }] }],
			[],
		);
		const sectionId = base.sections[0]!.id;
		const existing = base.sections[0]!.points[0]!;
		testStore.savePlan(
			test.id,
			[
				{
					id: sectionId,
					title: "Section A",
					points: [{ id: existing.id, text: existing.text, source: existing.source }],
				},
			],
			true,
		);

		testStore.setPendingAdditions(test.id, {
			sections: [
				{
					title: "Section A",
					points: [
						{ text: "Accepted A", source: "ch1.pdf" },
						{ text: "Dropped A", source: "ch1.pdf" },
					],
				},
				{ title: "Section B", points: [{ text: "Accepted B", source: "ch2.pdf" }] },
			],
			leftOut: [{ id: "lo_noise", text: "Noise", source: "ch1.pdf", reason: "not exam material" }],
		});

		// "9:9" names no pending point: unknown keys are ignored.
		const resolved = testStore.resolveAdditions(test.id, ["0:0", "1:0", "9:9"]);

		const sectionA = resolved.sections.find((section) => section.title === "Section A")!;
		assert.deepEqual(
			sectionA.points.map((point) => point.text),
			["Existing", "Accepted A"],
		);
		const added = sectionA.points[1]!;
		assert.equal(added.status, "unchecked");
		assert.deepEqual(added.history, []);
		assert.equal(sectionA.points[0]!.id, existing.id, "the existing point is unchanged");
		assert.equal(sectionA.points[0]!.status, "unchecked");
		assert.deepEqual(sectionA.points[0]!.history, []);

		const sectionB = resolved.sections.find((section) => section.title === "Section B")!;
		assert.deepEqual(
			sectionB.points.map((point) => point.text),
			["Accepted B"],
		);

		assert.equal(resolved.pendingAdditions, undefined, "the review is cleared");
		assert.deepEqual(
			resolved.leftOut!.map((item) => item.text).sort(),
			["Dropped A", "Noise"],
		);
		assert.equal(
			resolved.leftOut!.find((item) => item.text === "Dropped A")!.reason,
			"dropped by you",
		);
		assert.ok(resolved.leftOut!.every((item) => item.id.length > 0), "every left-out item has an id");
	});

	it("resolveAdditions with no pending additions throws", () => {
		const test = testStore.create("No pending");

		assert.throws(
			() => testStore.resolveAdditions(test.id, []),
			{ message: "no pending additions" },
		);
	});

	it("promoteLeftOut keeps planConfirmed true and removes the item", () => {
		const test = testStore.create("Promote");
		const planned = testStore.saveSweepPlan(test.id, draft(), [
			{ text: "Maybe useful", source: "notes.md", reason: "borderline", suggestedSection: "Section A" },
			{ text: "Unknown section", source: "notes.md", reason: "borderline", suggestedSection: "Nowhere" },
		]);
		const section = planned.sections[0]!;
		const confirmed = testStore.savePlan(
			test.id,
			[
				{
					id: section.id,
					title: section.title,
					points: section.points.map((point) => ({ id: point.id, text: point.text, source: point.source })),
				},
			],
			true,
		);
		const [named, unknown] = confirmed.leftOut!;

		const promoted = testStore.promoteLeftOut(test.id, named!.id);
		assert.equal(promoted.planConfirmed, true, "promotion does not unconfirm the plan");
		assert.equal(
			promoted.leftOut!.some((item) => item.id === named!.id),
			false,
			"the promoted item leaves leftOut",
		);
		const appended = promoted.sections[0]!.points[promoted.sections[0]!.points.length - 1]!;
		assert.equal(appended.text, "Maybe useful");
		assert.equal(appended.source, "notes.md");
		assert.equal(appended.status, "unchecked");
		assert.deepEqual(appended.history, []);

		// An unknown suggested section falls back to the first section instead
		// of creating a new one.
		const fallback = testStore.promoteLeftOut(test.id, unknown!.id);
		assert.equal(fallback.sections.length, 1);
		const last = fallback.sections[0]!.points[fallback.sections[0]!.points.length - 1]!;
		assert.equal(last.text, "Unknown section");
		assert.equal(fallback.leftOut!.length, 0);

		assert.throws(
			() => testStore.promoteLeftOut(test.id, "lo_never"),
			{ message: "unknown left-out item" },
		);
	});

	it("legacy records without new fields still load", () => {
		const created = testStore.create("Legacy");
		const legacy = testStore.get(created.id)!;
		assert.equal("leftOut" in legacy, false);
		assert.equal("sweep" in legacy, false);
		assert.equal("pendingAdditions" in legacy, false);

		// Present-but-malformed optional fields read as absent, and the file is
		// never rewritten on read.
		const testsDir = path.join(TMP_DATA, "tests");
		const file = path.join(testsDir, "test_malformed_optional.json");
		const bytes = JSON.stringify({
			id: "test_malformed_optional",
			title: "Malformed optional fields",
			createdAt: "2026-11-20T00:00:00.000Z",
			updatedAt: "2026-11-20T00:00:00.000Z",
			planConfirmed: false,
			sections: [],
			version: 1,
			leftOut: "not an array",
			sweep: [],
			pendingAdditions: 7,
		});
		fs.writeFileSync(file, bytes);

		const read = testStore.get("test_malformed_optional")!;
		assert.equal(read.title, "Malformed optional fields");
		assert.equal("leftOut" in read, false);
		assert.equal("sweep" in read, false);
		assert.equal("pendingAdditions" in read, false);
		assert.equal(fs.readFileSync(file, "utf-8"), bytes, "the file is not rewritten on read");
	});

	it("every sweep mutation announces tests-changed after the write", () => {
		let announces = 0;
		const off = subscribe((event) => {
			if (event.type === "tests-changed") announces++;
		});

		const test = testStore.create("Sweep events");
		assert.equal(announces, 1, "create announces");

		testStore.setFolder(test.id, "Math");
		assert.equal(announces, 2, "setFolder announces");

		testStore.updateSweep(test.id, {
			status: "running",
			startedAt: "2026-11-20T00:00:00.000Z",
			fileHashes: {},
		});
		assert.equal(announces, 3, "updateSweep announces");

		const planned = testStore.saveSweepPlan(test.id, draft(), [
			{ text: "Noise", source: "notes.md", reason: "aside" },
		]);
		assert.equal(announces, 4, "saveSweepPlan announces");

		testStore.setPendingAdditions(test.id, {
			sections: [{ title: "Section A", points: [{ text: "New", source: "n.md" }] }],
			leftOut: [],
		});
		assert.equal(announces, 5, "setPendingAdditions announces");

		testStore.resolveAdditions(test.id, ["0:0"]);
		assert.equal(announces, 6, "resolveAdditions announces");

		testStore.promoteLeftOut(test.id, planned.leftOut![0]!.id);
		assert.equal(announces, 7, "promoteLeftOut announces");

		off();
	});
});
