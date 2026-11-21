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
import { mergeCandidates } from "../src/agent/subagents/sweep/merge.ts";
import { SWEEP_EXTRACTOR_SYSTEM, SWEEP_MERGER_SYSTEM } from "../src/agent/subagents/sweep/prompts.ts";

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