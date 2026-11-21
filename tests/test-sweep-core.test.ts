/**
 * Unit tests — test-material sweep core (pure logic, no fs, no server).
 *
 * Coverage accumulation/reporting and Left-out promotion/application live in
 * src/core/test-prep.ts; the sweep pipeline and UI in later tasks import these.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyAdditions,
	coverageLine,
	mergeCoverage,
	promoteIntoDraft,
	type LeftOutItem,
	type PlanDraftSection,
	type SweepCoverage,
	type TestPoint,
	type TestSection,
} from "../src/core/test-prep.ts";

const coverage = (overrides: Partial<SweepCoverage> = {}): SweepCoverage => ({
	files: 0,
	pages: 0,
	visionPages: 0,
	unsupported: [],
	unreadable: [],
	empty: [],
	removed: [],
	...overrides,
});

const point = (overrides: Partial<TestPoint> = {}): TestPoint => ({
	id: "p",
	text: "a point",
	source: "outline line",
	status: "unchecked",
	history: [],
	...overrides,
});

const section = (id: string, title: string, points: TestPoint[]): TestSection => ({ id, title, points });

describe("mergeCoverage — whole-folder cumulative coverage", () => {
	it("adds counts and unions lists", () => {
		const prev = coverage({ files: 2, pages: 10, visionPages: 1, empty: ["a.pdf p. 3"] });
		const run = coverage({ files: 1, pages: 4, visionPages: 2, empty: ["b.pdf p. 1"] });

		const merged = mergeCoverage(prev, run);

		assert.equal(merged.files, 3);
		assert.equal(merged.pages, 14);
		assert.equal(merged.visionPages, 3);
		assert.deepEqual(merged.empty, ["a.pdf p. 3", "b.pdf p. 1"]);
	});

	it("drops stale entries for re-read files", () => {
		const prev = coverage({
			files: 1,
			pages: 3,
			empty: ["a.pdf p. 3"],
			unreadable: ["a.pdf (encrypted)"],
		});
		const run: SweepCoverage & { readFiles?: string[] } = {
			...coverage({ files: 1, pages: 3 }),
			readFiles: ["a.pdf"],
		};

		const merged = mergeCoverage(prev, run);

		assert.deepEqual(merged.empty, []);
		assert.deepEqual(merged.unreadable, []);
	});

	it("with resweepAt sets lastResweep {at, files: run.files}", () => {
		const merged = mergeCoverage(coverage(), coverage({ files: 4 }), "2026-11-20T12:00:00.000Z");

		assert.deepEqual(merged.lastResweep, { at: "2026-11-20T12:00:00.000Z", files: 4 });
	});
});

describe("coverageLine", () => {
	it("collapses consecutive pages and omits empty sections", () => {
		const line = coverageLine(
			coverage({
				files: 14,
				pages: 312,
				visionPages: 41,
				empty: ["ch4.pdf p. 88", "ch4.pdf p. 89", "ch4.pdf p. 90"],
			}),
		);

		assert.ok(line.includes("Read 14 files · 312 pages (41 looked at by vision)"), line);
		assert.ok(line.includes("nothing found: ch4.pdf p. 88–90"), line);
		assert.ok(!line.includes("couldn't read"), line);
		assert.ok(!line.includes("not read"), line);
	});
});

describe("promoteIntoDraft — one-click promote of a left-out item", () => {
	const item: LeftOutItem = {
		id: "l1",
		text: "New fact",
		source: "ch1 p. 2",
		reason: "filler",
	};

	it("uses suggestedSection (trimmed) and appends a {text, source} point without an id", () => {
		const draft: PlanDraftSection[] = [
			{ title: "Alpha", points: [{ id: "p1", text: "existing", source: "src" }] },
			{ title: "Beta", points: [] },
		];

		const next = promoteIntoDraft(draft, { ...item, suggestedSection: "  Beta  " });

		assert.equal(next.length, 2);
		assert.equal(next[1]!.points.length, 1);
		assert.deepEqual(next[1]!.points[0], { text: "New fact", source: "ch1 p. 2" });
		assert.equal(next[0]!.points.length, 1);
	});

	it("falls back to the first section", () => {
		const draft: PlanDraftSection[] = [
			{ title: "Alpha", points: [] },
			{ title: "Beta", points: [] },
		];

		const next = promoteIntoDraft(draft, { ...item, suggestedSection: "Missing" });

		assert.equal(next[0]!.points.length, 1);
		assert.equal(next[0]!.points[0]!.text, "New fact");
		assert.equal(next[1]!.points.length, 0);
	});
});

describe("applyAdditions — accepted re-sweep points", () => {
	it("keeps existing points byte-identical and appends unchecked points", () => {
		const history = [{ at: "2026-11-09T00:00:00.000Z", chatId: "c1", result: "correct" as const }];
		const sections: TestSection[] = [
			section("s1", "Section A", [
				point({ id: "p1", text: "Old", source: "old src", status: "solid", history }),
			]),
		];
		const pristine = JSON.parse(JSON.stringify(sections)) as TestSection[];

		const accepted: PlanDraftSection[] = [
			{ title: " Section A ", points: [{ text: "New one", source: "src 1" }] },
			{ title: "New Section", points: [{ text: "Another", source: "src 2" }] },
		];
		let n = 0;
		const newId = () => `gen-${++n}`;

		const next = applyAdditions(sections, accepted, newId);

		assert.deepEqual(next[0]!.points[0], pristine[0]!.points[0]);
		assert.equal(next[0]!.points.length, 2);
		const added = next[0]!.points[1]!;
		assert.equal(added.text, "New one");
		assert.equal(added.source, "src 1");
		assert.equal(added.status, "unchecked");
		assert.deepEqual(added.history, []);
		assert.equal(added.id, "gen-1");

		assert.equal(next.length, 2);
		assert.equal(next[1]!.title, "New Section");
		assert.equal(next[1]!.points[0]!.text, "Another");
		assert.equal(next[1]!.points[0]!.status, "unchecked");
		assert.deepEqual(next[1]!.points[0]!.history, []);
	});
});