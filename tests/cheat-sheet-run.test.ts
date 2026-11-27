/**
 * The cheat sheet writer (issue #15): excerpt selection from the sweep's
 * cached material, the prompt it builds, and the orchestration with a stub
 * writer — no model, no fs cache.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cheat-sheet-run-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { sectionExcerpt, buildSheetPrompt, runCheatSheet } = await import(
	"../src/agent/subagents/cheat-sheet/run-cheat-sheet.ts"
);
type TestRecord = import("../src/core/test-prep.ts").TestRecord;
type CheatSheet = import("../src/core/cheat-sheet.ts").CheatSheet;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

function record(overrides: Partial<TestRecord> = {}): TestRecord {
	return {
		id: "test_sheet",
		title: "Bio midterm",
		createdAt: "2026-11-27T09:00:00.000Z",
		updatedAt: "2026-11-27T09:00:00.000Z",
		planConfirmed: true,
		version: 1,
		sections: [
			{
				id: "section_1",
				title: "Membranes",
				points: [
					{
						id: "point_1",
						text: "Passive vs active transport",
						source: "notes.pdf p. 3",
						status: "unchecked",
						history: [],
					},
				],
			},
			{
				id: "section_2",
				title: "Enzymes",
				points: [
					{
						id: "point_2",
						text: "Activation energy",
						source: "slides.pptx slide 2",
						status: "unchecked",
						history: [],
					},
				],
			},
		],
		...overrides,
	};
}

const MATERIAL = [
	[
		"<!-- source: notes.pdf p. 1 -->",
		"Cell theory history. Not in the plan.",
		"<!-- source: notes.pdf p. 3 -->",
		"Passive transport needs no ATP; active transport does.",
		"<!-- source: notes.pdf p. 4 -->",
		"Osmosis is water across a semipermeable membrane.",
	].join("\n"),
	[
		"<!-- source: slides.pptx slide 2 -->",
		"Enzymes lower activation energy and are not consumed.",
	].join("\n"),
];

const PLAN_SECTION = {
	id: "section_1",
	title: "Membranes",
	points: [{ text: "Passive vs active transport", source: "notes.pdf p. 3" }],
};

describe("sectionExcerpt", () => {
	it("picks the cited page, not the whole file", () => {
		const excerpt = sectionExcerpt(PLAN_SECTION, MATERIAL);
		assert.match(excerpt, /Passive transport needs no ATP/);
		assert.doesNotMatch(excerpt, /Cell theory history/, "an uncited page is left out");
		assert.doesNotMatch(excerpt, /Osmosis is water/, "another uncited page is left out");
		assert.match(excerpt, /<!-- source: notes\.pdf p\. 3 -->/);
	});

	it("falls back to the cited file's pages when no page is cited", () => {
		const excerpt = sectionExcerpt(
			{ ...PLAN_SECTION, points: [{ text: "transport", source: "notes.pdf" }] },
			MATERIAL,
		);
		assert.match(excerpt, /Cell theory history/, "a bare file citation includes the file");
		assert.match(excerpt, /Osmosis is water/);
	});

	it("is empty when nothing matches", () => {
		assert.equal(sectionExcerpt({ ...PLAN_SECTION, points: [{ text: "x", source: "other.pdf p. 1" }] }, MATERIAL), "");
	});

	it("honours the character cap", () => {
		const long = [`<!-- source: notes.pdf p. 3 -->`, "x".repeat(2_000)];
		const excerpt = sectionExcerpt(PLAN_SECTION, long, 500);
		assert.ok(excerpt.length <= 500, `excerpt was ${excerpt.length} chars`);
	});
});

describe("buildSheetPrompt", () => {
	it("carries every plan section, its points and its excerpt", () => {
		const prompt = buildSheetPrompt(record(), MATERIAL);

		assert.match(prompt, /Test: Bio midterm/);
		assert.match(prompt, /## 1\. Membranes/);
		assert.match(prompt, /## 2\. Enzymes/);
		assert.match(prompt, /Passive vs active transport \(from notes\.pdf p\. 3\)/);
		assert.match(prompt, /Passive transport needs no ATP/);
		assert.match(prompt, /Enzymes lower activation energy/);
		assert.doesNotMatch(prompt, /Cell theory history/);
	});

	it("tells the writer to stay on the plan when a section has no excerpt", () => {
		const prompt = buildSheetPrompt(record(), []);
		assert.match(prompt, /No material excerpt found for this section/);
		assert.match(prompt, /no invented facts/);
	});
});

function fakeStore(initial: TestRecord): {
	current: TestRecord;
	store: {
		get: (id: string) => TestRecord | null;
		setCheatSheet: (id: string, sheet: CheatSheet) => TestRecord;
	};
	writes: CheatSheet[];
} {
	const writes: CheatSheet[] = [];
	let current = initial;
	return {
		get writes() {
			return writes;
		},
		get current() {
			return current;
		},
		store: {
			get: (id) => (id === current.id ? current : null),
			setCheatSheet: (id, sheet) => {
				assert.equal(id, current.id);
				writes.push(sheet);
				current = { ...current, cheatSheet: sheet, cheatSheetBuild: undefined };
				return current;
			},
		},
	};
}

describe("runCheatSheet", () => {
	const draft = {
		intro: "The one page for the midterm.",
		sections: [
			{
				title: "Membranes",
				idea: "Transport is about energy and gradients.",
				facts: [{ label: "Active transport", body: "Needs ATP; passive does not." }],
				formulas: [],
				trap: "Do not call osmosis diffusion of solute.",
			},
			{
				title: "Enzymes",
				idea: "Enzymes change the path, not the energy difference.",
				facts: [{ label: "Activation energy", body: "Lowered by enzymes, never consumed by them." }],
				formulas: [],
			},
		],
	};

	it("assembles the plan's sections from the writer's draft and stores it", async () => {
		const fake = fakeStore(record());

		const outcome = await runCheatSheet("test_sheet", {
			store: fake.store,
			stages: { material: async () => MATERIAL, write: async () => draft },
		});

		assert.deepEqual(outcome, { ok: true, sections: 2 });
		const written = fake.writes[0]!;
		assert.equal(fake.current.cheatSheet, written);
		assert.deepEqual(
			written.sections.map((section) => section.id),
			["section_1", "section_2"],
		);
		assert.equal(written.sections[0]?.trap, "Do not call osmosis diffusion of solute.");
		assert.ok(!Number.isNaN(Date.parse(written.generatedAt)));
	});

	it("refuses an unconfirmed plan", async () => {
		const fake = fakeStore(record({ planConfirmed: false }));
		await assert.rejects(
			runCheatSheet("test_sheet", {
				store: fake.store,
				stages: { material: async () => MATERIAL, write: async () => draft },
			}),
			/Confirm the plan/,
		);
		assert.equal(fake.writes.length, 0);
	});

	it("refuses when the test has no read material", async () => {
		const fake = fakeStore(record());
		await assert.rejects(
			runCheatSheet("test_sheet", {
				store: fake.store,
				stages: { material: async () => [], write: async () => draft },
			}),
			/No read material/,
		);
		assert.equal(fake.writes.length, 0);
	});

	it("refuses when the plan's sources match none of the read material", async () => {
		const fake = fakeStore(record());
		let wrote = false;
		await assert.rejects(
			runCheatSheet("test_sheet", {
				store: fake.store,
				stages: {
					material: async () => ["<!-- source: other.pdf p. 1 -->\nSomething else entirely."],
					write: async () => {
						wrote = true;
						return draft;
					},
				},
			}),
			/do not line up/,
		);
		assert.equal(wrote, false, "the writer never runs on unmatched material");
		assert.equal(fake.writes.length, 0);
	});

	it("reads the sweep cache from data/tests/<id>/sweep", async () => {
		const id = "test_cached";
		const dir = path.join(TMP_DATA, "tests", id, "sweep");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "abc123.md"),
			[
				'<!-- sweep-cache: {"rel":"notes.pdf","pages":1,"visionPages":0,"unreadable":[]} -->',
				"<!-- source: notes.pdf p. 3 -->",
				"Passive transport needs no ATP.",
			].join("\n"),
		);

		const fake = fakeStore(record({ id }));
		let seenMaterial: string[] = [];
		await runCheatSheet(id, {
			store: fake.store,
			stages: {
				write: async (_record, material) => {
					seenMaterial = material;
					return draft;
				},
			},
		});

		assert.equal(seenMaterial.length, 1);
		assert.match(seenMaterial[0]!, /Passive transport needs no ATP/);
		assert.doesNotMatch(seenMaterial[0]!, /sweep-cache/, "the cache header is not material");
	});
});