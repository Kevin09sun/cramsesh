/**
 * Task 5 — the sweep's extractor and merger stages.
 *
 * chunkTranscripts carries the marker in force into every chunk; the
 * extractor rejects a source that is not one of the chunk's markers and
 * accepts the retry; the merger turns candidates into sections + Left out,
 * and its system prompt states the archetype / vocab / noise rules. Scripted
 * faux engines stand in for both models — no network, no stores.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { Transcript } from "../src/agent/subagents/sweep/transcribe.ts";
import type { Candidate } from "../src/agent/subagents/sweep/extract.ts";
import { chunkTranscripts, extractCandidates } from "../src/agent/subagents/sweep/extract.ts";
import { mergeCandidates, unplacedByMerger } from "../src/agent/subagents/sweep/merge.ts";
import { SWEEP_EXTRACTOR_SYSTEM, SWEEP_MERGER_SYSTEM, SWEEP_RECONCILE_SYSTEM } from "../src/agent/subagents/sweep/prompts.ts";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function submit(toolName: string, value: ToolCall["arguments"], id: string): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(toolName, value, { id })], { stopReason: "toolUse" });
}

const noUsage = (): void => {};

function transcript(rel: string, markdown: string): Transcript {
	return { rel, markdown, pages: 1, visionPages: 0, unreadable: [] };
}

const CANDIDATES: Candidate[] = [
	{
		kind: "skill",
		category: "process/steps",
		text: "Solve a quadratic equation by factoring",
		source: "unit.pdf p. 2",
		evidence: "Factor, set each factor to zero, solve.",
	},
	{
		kind: "fact",
		category: "formula",
		text: "Quadratic formula",
		source: "unit.pdf p. 3",
		evidence: "x = (-b ± √(b² - 4ac)) / 2a",
	},
];

describe("sweep stages", () => {
	it("chunkTranscripts carries the active marker into each chunk", () => {
		const markdown = [
			"<!-- source: notes.pdf p. 1 -->",
			"alpha ".repeat(20).trim(),
			"<!-- source: notes.pdf p. 2 -->",
			"beta ".repeat(20).trim(),
		].join("\n");

		const chunks = chunkTranscripts([transcript("notes.pdf", markdown)], 20);

		assert.ok(chunks.length >= 2, "the small budget forces a split");
		const alpha = chunks.find((chunk) => chunk.includes("alpha"));
		assert.ok(alpha, "the first unit survives");
		assert.ok(alpha.startsWith("<!-- source: notes.pdf p. 1 -->"), alpha);
		const beta = chunks.find((chunk) => chunk.includes("beta"));
		assert.ok(beta, "the second unit survives");
		assert.ok(beta.startsWith("<!-- source: notes.pdf p. 2 -->"), beta);
	});

	it("chunkTranscripts keeps the marker exact when chunkNotes dropped a blank line at a break", () => {
		// The blank line after the first unit triggers a break and chunkNotes
		// drops it; a naive running cursor then lags and labels the last chunk
		// with b.pdf p. 1 instead of b.pdf p. 2.
		const markdown = [
			"<!-- source: b.pdf p. 1 -->",
			"a".repeat(40),
			"",
			"middle",
			"<!-- source: b.pdf p. 2 -->",
			"c".repeat(40),
		].join("\n");

		const chunks = chunkTranscripts([transcript("b.pdf", markdown)], 10);
		const last = chunks[chunks.length - 1]!;

		assert.ok(last.includes("c".repeat(40)), "the final unit is its own chunk");
		assert.ok(last.startsWith("<!-- source: b.pdf p. 2 -->"), last);
		assert.equal(last.includes("b.pdf p. 1"), false, "the previous unit's marker never leaks forward");
	});

	it("chunkTranscripts emits no chunk made only of marker lines", () => {
		const markdown = [
			"<!-- source: a.pdf p. 1 -->",
			"",
			"<!-- source: a.pdf p. 2 -->",
			"the only real content here",
		].join("\n");

		const chunks = chunkTranscripts([transcript("a.pdf", markdown)], 5);

		assert.equal(chunks.length, 1, "marker-only chunks are skipped");
		assert.ok(chunks[0]!.includes("the only real content here"));
		assert.ok(chunks[0]!.startsWith("<!-- source: a.pdf p. 2 -->"), chunks[0]);
	});

	it("extractCandidates rejects a candidate with a source not in the chunk then accepts the retry", async () => {
		const chunk =
			"<!-- source: notes.pdf p. 3 -->\nMitochondria produce ATP through cellular respiration.";
		const good = {
			candidates: [
				{
					kind: "fact",
					category: "definition",
					text: "Mitochondria produce ATP",
					source: "notes.pdf p. 3",
					evidence: "Mitochondria produce ATP through cellular respiration.",
				},
			],
		};
		const bad = {
			candidates: [{ ...good.candidates[0]!, source: "notes.pdf p. 9" }],
		};

		const engine = fauxEngine([
			submit("submit_candidates", bad, "bad-source"),
			submit("submit_candidates", good, "good-source"),
		]);

		const result = await extractCandidates(chunk, { engine, onUsage: noUsage });

		assert.deepEqual(result.candidates, good.candidates);
		assert.deepEqual(result.markersSeen, ["notes.pdf p. 3"]);
	});

	it("extractCandidates reports every marker in a multi-marker chunk", async () => {
		const chunk = [
			"<!-- source: a.pdf p. 1 -->",
			"first unit",
			"<!-- source: a.pdf p. 2 -->",
			"second unit",
		].join("\n");
		const good = {
			candidates: [
				{
					kind: "fact",
					category: "definition",
					text: "second unit",
					source: "a.pdf p. 2",
					evidence: "second unit",
				},
			],
		};

		const result = await extractCandidates(chunk, {
			engine: fauxEngine([submit("submit_candidates", good, "multi-marker")]),
			onUsage: noUsage,
		});

		assert.deepEqual(result.markersSeen, ["a.pdf p. 1", "a.pdf p. 2"]);
	});

	it("mergeCandidates returns sections and leftOut", async () => {
		const plan = {
			sections: [
				{
					title: "Quadratic equations",
					points: [{ text: "Solve a quadratic by factoring", source: "unit.pdf p. 2" }],
				},
			],
			leftOut: [{ text: "Chapter 4 title slide", source: "unit.pdf p. 1", reason: "slide title" }],
		};
		const engine = fauxEngine([submit("submit_plan", plan, "plan-1")]);

		const out = await mergeCandidates(
			{ candidates: CANDIDATES, outlineHeadings: [], existingPoints: [], existingLeftOut: [] },
			{ engine, onUsage: noUsage },
		);

		assert.deepEqual(out.sections, plan.sections);
		assert.deepEqual(out.leftOut, plan.leftOut);
	});

	it("mergeCandidates prompt contains the archetype, must-know-fact and noise rules", () => {
		assert.match(SWEEP_MERGER_SYSTEM, /skill archetype/);
		assert.match(SWEEP_MERGER_SYSTEM, /each vocab term/);
		assert.match(SWEEP_MERGER_SYSTEM, /noise/);
		assert.match(SWEEP_MERGER_SYSTEM, /Left out/);
		assert.match(SWEEP_EXTRACTOR_SYSTEM, /recall over precision/);
		assert.match(SWEEP_RECONCILE_SYSTEM, /duplicate archetypes and duplicate facts/);
		assert.match(SWEEP_RECONCILE_SYSTEM, /Never drop a point except into Left out/);
	});

	it("mergeCandidates allows an empty plan in re-sweep mode", async () => {
		const plan = { sections: [], leftOut: [] };
		const engine = fauxEngine([submit("submit_plan", plan, "re-sweep-empty")]);

		const out = await mergeCandidates(
			{
				candidates: CANDIDATES,
				outlineHeadings: [],
				existingPoints: ["Solve a quadratic by factoring"],
				existingLeftOut: [],
			},
			{ engine, onUsage: noUsage },
		);

		assert.deepEqual(out.sections, []);
		assert.deepEqual(out.leftOut, []);
	});

	it("mergeCandidates overflow splits by source file and keeps an all-noise bucket's Left out", async () => {
		// Two source files, each bucket over MERGE_MAX_CHARS on its own? No —
		// together they are over; each is under, so the merger runs once per file.
		const candidates: Candidate[] = [];
		for (let index = 0; index < 300; index++) {
			candidates.push({
				kind: "fact",
				category: "definition",
				text: `alpha fact ${index} ${"x".repeat(300)}`,
				source: "a.pdf p. 1",
				evidence: "e",
			});
			candidates.push({
				kind: "fact",
				category: "definition",
				text: `beta fact ${index} ${"x".repeat(300)}`,
				source: "b.pdf p. 1",
				evidence: "e",
			});
		}
		assert.ok(JSON.stringify(candidates).length > 150_000, "the fixture forces the overflow path");

		// The first bucket (a.pdf) is all noise and legitimately submits no
		// sections; the second bucket carries the plan. A third call reconciles
		// the two partial plans (I6).
		const engine = fauxEngine([
			submit(
				"submit_plan",
				{
					sections: [],
					leftOut: [{ text: "all of alpha", source: "a.pdf p. 1", reason: "filler examples" }],
				},
				"bucket-a",
			),
			submit(
				"submit_plan",
				{
					sections: [
						{ title: "Beta material", points: [{ text: "A beta point", source: "b.pdf p. 1" }] },
					],
					leftOut: [{ text: "a beta citation", source: "b.pdf p. 1", reason: "citation" }],
				},
				"bucket-b",
			),
			submit(
				"submit_plan",
				{
					sections: [
						{ title: "Beta material", points: [{ text: "A beta point", source: "b.pdf p. 1" }] },
					],
					leftOut: [
						{ text: "all of alpha", source: "a.pdf p. 1", reason: "filler examples" },
						{ text: "a beta citation", source: "b.pdf p. 1", reason: "citation" },
					],
				},
				"reconcile",
			),
		]);

		const out = await mergeCandidates(
			{ candidates, outlineHeadings: [], existingPoints: [], existingLeftOut: [] },
			{ engine, onUsage: noUsage },
		);

		assert.deepEqual(out.sections, [
			{ title: "Beta material", points: [{ text: "A beta point", source: "b.pdf p. 1" }] },
		]);
		assert.deepEqual(
			out.leftOut.map((item) => item.text).sort(),
			["a beta citation", "all of alpha"],
			"both buckets' Left out lists survive the reconcile",
		);
	});

	it("splits one oversized file into page-range buckets and reconciles duplicates once (I6)", async () => {
		const candidates: Candidate[] = [];
		for (let index = 0; index < 500; index++) {
			candidates.push({
				kind: "fact",
				category: "definition",
				text: `fact ${index} ${"x".repeat(330)}`,
				source: `big.pdf p. ${(index % 40) + 1}`,
				evidence: "e",
			});
		}
		assert.ok(JSON.stringify(candidates).length > 150_000, "one file is over the limit on its own");

		const engine = fauxEngine([
			submit(
				"submit_plan",
				{
					sections: [
						{ title: "Topic", points: [{ text: "Shared archetype", source: "big.pdf p. 1" }] },
					],
					leftOut: [],
				},
				"bucket-one",
			),
			submit(
				"submit_plan",
				{
					sections: [
						{ title: "Topic", points: [{ text: "Shared archetype", source: "big.pdf p. 2" }] },
					],
					leftOut: [],
				},
				"bucket-two",
			),
			// The reconcile call merges the duplicate across the two buckets.
			submit(
				"submit_plan",
				{
					sections: [
						{ title: "Topic", points: [{ text: "Shared archetype", source: "big.pdf p. 1" }] },
					],
					leftOut: [],
				},
				"reconcile",
			),
		]);

		const out = await mergeCandidates(
			{ candidates, outlineHeadings: [], existingPoints: [], existingLeftOut: [] },
			{ engine, onUsage: noUsage },
		);

		assert.deepEqual(out.sections, [
			{ title: "Topic", points: [{ text: "Shared archetype", source: "big.pdf p. 1" }] },
		], "the duplicate archetype is one point after the single reconcile pass");
	});

	it("routes an empty bucket's unmentioned candidates to Left out (I8)", () => {
		const bucket: Candidate[] = [
			{
				kind: "fact",
				category: "definition",
				text: "Dropped fact",
				source: "a.pdf p. 1",
				evidence: "e",
			},
		];

		assert.deepEqual(unplacedByMerger(bucket, { sections: [], leftOut: [] }), [
			{ text: "Dropped fact", source: "a.pdf p. 1", reason: "not placed by the merger" },
		]);
		assert.deepEqual(
			unplacedByMerger(bucket, {
				sections: [],
				leftOut: [{ text: "some noise", source: "a.pdf p. 1", reason: "citation" }],
			}),
			[],
			"a Left out entry from the same source counts as mention",
		);
		assert.deepEqual(
			unplacedByMerger(bucket, {
				sections: [],
				leftOut: [{ text: "Dropped fact", source: "other.pdf", reason: "citation" }],
			}),
			[],
			"a left-out item naming the fact counts as mention",
		);
		assert.deepEqual(
			unplacedByMerger(bucket, {
				sections: [{ title: "T", points: [{ text: "placed", source: "a.pdf p. 1" }] }],
				leftOut: [],
			}),
			[],
			"a bucket that produced sections is never reprocessed",
		);
	});

	it("ignores an empty-text Left out entry when deciding mentions (I8)", () => {
		const bucket: Candidate[] = [
			{
				kind: "fact",
				category: "definition",
				text: "Dropped fact",
				source: "a.pdf p. 1",
				evidence: "e",
			},
		];
		// `"Dropped fact".includes("")` is true — an empty Left out item must
		// not be read as naming every candidate and swallow the bucket.
		assert.deepEqual(
			unplacedByMerger(bucket, {
				sections: [],
				leftOut: [{ text: "   ", source: "other.pdf", reason: "citation" }],
			}),
			[{ text: "Dropped fact", source: "a.pdf p. 1", reason: "not placed by the merger" }],
			"a blank Left out item mentions nothing",
		);
	});

	it("mergeCandidates throws after maxTurns of invalid submissions", async () => {
		const emptyPlan = { sections: [], leftOut: [] };
		const steps = Array.from({ length: 4 }, (_, index) =>
			submit("submit_plan", emptyPlan, `invalid-${index}`),
		);

		await assert.rejects(
			mergeCandidates(
				{ candidates: CANDIDATES, outlineHeadings: [], existingPoints: [], existingLeftOut: [] },
				{ engine: fauxEngine(steps), onUsage: noUsage },
			),
			/never submitted/,
		);
	});
});