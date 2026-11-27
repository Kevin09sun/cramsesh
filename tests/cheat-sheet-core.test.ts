/**
 * Cheat sheet core (issue #15): the assembly from a writer's draft into the
 * stored sheet — plan order, plan ids, the plan-only fallback, trimming, and
 * the defensive read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assembleCheatSheet,
	normalizeCheatSheet,
	planOnlySection,
	sectionSources,
	type CheatSheetDraft,
} from "../src/core/cheat-sheet.ts";

const PLAN = [
	{
		id: "section_1",
		title: "Membranes",
		points: [
			{ text: "Passive transport", source: "notes.pdf p. 3" },
			{ text: "Osmosis", source: "notes.pdf p. 4" },
		],
	},
	{
		id: "section_2",
		title: "Enzymes",
		points: [{ text: "Activation energy", source: "slides.pptx slide 2" }],
	},
];

function draft(overrides: Partial<CheatSheetDraft> = {}): CheatSheetDraft {
	return {
		intro: "What you need for the midterm.",
		sections: [
			{
				title: "Membranes",
				idea: "The membrane decides what crosses and how fast.",
				facts: [
					{ label: "Diffusion", body: "Net movement down a concentration gradient." },
					{ label: "Osmosis", body: "Water moving across a semipermeable membrane." },
				],
				formulas: ["water potential = Ψs + Ψp"],
				trap: "Do not call facilitated diffusion active transport.",
			},
			{
				title: "Enzymes",
				idea: "Enzymes lower the barrier, never the energy change.",
				facts: [{ label: "Catalyst", body: "Lowers activation energy without being consumed." }],
				formulas: [],
			},
		],
		...overrides,
	};
}

describe("assembleCheatSheet", () => {
	it("follows the plan's order and ids and keeps the writer's content", () => {
		const sheet = assembleCheatSheet(PLAN, draft(), "2026-11-27T10:00:00.000Z");

		assert.equal(sheet.intro, "What you need for the midterm.");
		assert.equal(sheet.generatedAt, "2026-11-27T10:00:00.000Z");
		assert.deepEqual(
			sheet.sections.map((section) => section.id),
			["section_1", "section_2"],
		);
		assert.equal(sheet.sections[0]?.title, "Membranes");
		assert.equal(sheet.sections[0]?.facts.length, 2);
		assert.deepEqual(sheet.sections[0]?.formulas, ["water potential = Ψs + Ψp"]);
		assert.equal(sheet.sections[0]?.trap, "Do not call facilitated diffusion active transport.");
		assert.equal(sheet.sections[1]?.trap, undefined, "no trap is fine");
	});

	it("falls back to the plan's own points for a section the writer skipped", () => {
		const partial = draft();
		partial.sections = [partial.sections[0]!];

		const sheet = assembleCheatSheet(PLAN, partial, "2026-11-27T10:00:00.000Z");

		assert.equal(sheet.sections.length, 2, "the page is never missing a plan section");
		const fallback = sheet.sections[1]!;
		assert.equal(fallback.id, "section_2");
		assert.deepEqual(fallback.facts, [{ label: "", body: "Activation energy" }]);
		assert.match(fallback.idea, /Activation energy/);
	});

	it("drops writer sections that name no plan section", () => {
		const extra = draft();
		extra.sections.push({
			title: "Not in the plan",
			idea: "x",
			facts: [{ label: "x", body: "y" }],
			formulas: [],
		});

		const sheet = assembleCheatSheet(PLAN, extra, "2026-11-27T10:00:00.000Z");

		assert.deepEqual(
			sheet.sections.map((section) => section.title),
			["Membranes", "Enzymes"],
			"the sheet never adds scope",
		);
	});

	it("falls back for a writer section with no facts", () => {
		const empty = draft();
		empty.sections[0]!.facts = [];

		const sheet = assembleCheatSheet(PLAN, empty, "2026-11-27T10:00:00.000Z");

		assert.deepEqual(sheet.sections[0]?.facts, [
			{ label: "", body: "Passive transport" },
			{ label: "", body: "Osmosis" },
		]);
	});

	it("trims excessive facts, formulas and long text", () => {
		const long = draft();
		long.sections[0] = {
			title: "Membranes",
			idea: "i".repeat(400),
			facts: Array.from({ length: 12 }, (_, index) => ({ label: `f${index}`, body: "b".repeat(500) })),
			formulas: Array.from({ length: 9 }, (_, index) => `formula ${index}`),
		};

		const sheet = assembleCheatSheet(PLAN, long, "2026-11-27T10:00:00.000Z");

		assert.equal(sheet.sections[0]?.facts.length, 8);
		assert.equal(sheet.sections[0]?.formulas.length, 4);
		assert.ok((sheet.sections[0]?.idea.length ?? 0) <= 220);
		assert.ok((sheet.sections[0]?.facts[0]?.body.length ?? 0) <= 320);
	});
});

describe("sectionSources", () => {
	it("joins distinct sources and caps the line", () => {
		assert.equal(
			sectionSources({
				id: "s",
				title: "t",
				points: [
					{ text: "a", source: "notes.pdf p. 3" },
					{ text: "b", source: "notes.pdf p. 3" },
					{ text: "c", source: "slides.pptx slide 2" },
				],
			}),
			"notes.pdf p. 3, slides.pptx slide 2",
		);

		const many = Array.from({ length: 7 }, (_, index) => ({ text: "x", source: `file${index}.pdf` }));
		assert.match(sectionSources({ id: "s", title: "t", points: many }), /\+3 more$/);
	});

	it("says your materials when the plan cites nothing", () => {
		assert.equal(sectionSources({ id: "s", title: "t", points: [] }), "your materials");
	});
});

describe("planOnlySection", () => {
	it("states scope and never invents content", () => {
		const section = planOnlySection(PLAN[0]!);
		assert.equal(section.facts.length, 2);
		assert.ok(section.facts.every((fact) => fact.label === ""));
		assert.deepEqual(section.formulas, []);
	});

	it("caps a long plan section like the writer's own cards", () => {
		const points = Array.from({ length: 14 }, (_, index) => ({
			text: `Point number ${index} with a reasonably long description of what it asks for`,
			source: "notes.pdf",
		}));
		const section = planOnlySection({ id: "s", title: "Big", points });

		assert.equal(section.facts.length, 8);
		assert.ok(section.idea.length <= 220);
		assert.ok(section.facts.every((fact) => fact.body.length <= 320));
	});
});

describe("normalizeCheatSheet", () => {
	it("round-trips a stored sheet", () => {
		const sheet = assembleCheatSheet(PLAN, draft(), "2026-11-27T10:00:00.000Z");
		assert.deepEqual(normalizeCheatSheet(sheet), sheet);
	});

	it("reads a malformed sheet as absent", () => {
		assert.equal(normalizeCheatSheet(null), null);
		assert.equal(normalizeCheatSheet({ generatedAt: "x" }), null);
		assert.equal(
			normalizeCheatSheet({
				generatedAt: "2026-11-27T10:00:00.000Z",
				intro: "",
				sections: [{ id: "s", title: "t", idea: "i", facts: [{}], formulas: [], source: "x" }],
			}),
			null,
			"a fact without strings is not renderable",
		);
	});

	it("accepts an absent intro (older records)", () => {
		const sheet = normalizeCheatSheet({
			generatedAt: "2026-11-27T10:00:00.000Z",
			sections: [{ id: "s", title: "t", idea: "i", facts: [], formulas: [], source: "x" }],
		});
		assert.equal(sheet?.intro, "");
	});
});