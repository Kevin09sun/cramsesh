/**
 * Test-material sweep, stage 3 (Task 5) — merge every extracted candidate
 * into one plan: sections of points plus a Left out list.
 *
 * The product owner's rule: one question for every archetype of question
 * that can be asked on the test — no noise — but each vocab term is its own
 * point. The strong merger model reads all candidates at once; when that
 * input is pathologically large (> 150k chars serialized) it is first
 * deduped by fact text, then merged per source file and the group outputs
 * are concatenated by section title.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { planProblems, type LeftOutItem, type PlanDraftSection } from "../../../core/test-prep.ts";
import type { PiEngine } from "../../models.ts";
import { runSubmitAgent } from "../submit-agent.ts";
import type { Candidate } from "./extract.ts";
import { SWEEP_MERGER_SYSTEM } from "./prompts.ts";

export interface MergeInput {
	candidates: Candidate[];
	outlineHeadings: string[];
	existingPoints: string[];
	existingLeftOut: string[];
}

export interface MergeOutput {
	sections: PlanDraftSection[];
	leftOut: Array<Omit<LeftOutItem, "id">>;
}

export interface MergeOptions {
	engine?: PiEngine;
	signal?: AbortSignal;
	onUsage: (usage: Usage) => void;
}

/** Serialized size past which the merger splits its work. */
export const MERGE_MAX_CHARS = 150_000;

const planSchema = Type.Object({
	sections: Type.Array(
		Type.Object({
			title: Type.String({ description: "The section heading." }),
			points: Type.Array(
				Type.Object({
					text: Type.String({ description: "One testable point, stated on its own." }),
					source: Type.String({ description: "The representative pages the point came from." }),
				}),
			),
		}),
		{ description: "Plan sections. May be empty on a re-sweep that adds nothing." },
	),
	leftOut: Type.Array(
		Type.Object({
			text: Type.String({ description: "The material judged to be noise." }),
			source: Type.String({ description: "Where it appears." }),
			reason: Type.String({ description: "A short reason it is not testable." }),
			suggestedSection: Type.Optional(
				Type.String({ description: "A section this could belong to if it were promoted." }),
			),
		}),
		{ description: "Noise, kept visible and promotable." },
	),
});

type SubmitValue = Static<typeof planSchema>;

function fillPlan(input: any): SubmitValue {
	return {
		sections: (input.sections as any[]).map((section) => ({
			title: String(section.title ?? "").trim(),
			points: (section.points as any[]).map((point) => ({
				text: String(point.text ?? "").trim(),
				source: String(point.source ?? "").trim(),
			})),
		})),
		leftOut: (input.leftOut as any[]).map((item) => {
			const suggested = String(item.suggestedSection ?? "").trim();
			return {
				text: String(item.text ?? "").trim(),
				source: String(item.source ?? "").trim(),
				reason: String(item.reason ?? "").trim(),
				...(suggested === "" ? {} : { suggestedSection: suggested }),
			};
		}),
	};
}

function candidateLines(candidates: Candidate[]): string[] {
	if (candidates.length === 0) return ["(none)"];
	return candidates.map(
		(candidate, index) =>
			`${index + 1}. [${candidate.kind}] ${candidate.category}: ${candidate.text} ` +
			`— source: ${candidate.source} — evidence: ${candidate.evidence}`,
	);
}

function listLines(items: string[], empty: string): string[] {
	return items.length === 0 ? [`(none — ${empty})`] : items.map((item) => `- ${item}`);
}

function mergePrompt(input: MergeInput): string {
	return [
		"=== CANDIDATES ===",
		...candidateLines(input.candidates),
		"",
		"=== OUTLINE HEADINGS ===",
		...listLines(input.outlineHeadings, "choose coherent topic headings from the material"),
		"",
		"=== EXISTING POINTS (never re-propose these) ===",
		...listLines(input.existingPoints, "this is the first sweep"),
		"",
		"=== EXISTING LEFT OUT (never re-propose these) ===",
		...listLines(input.existingLeftOut, "nothing has been left out yet"),
		"",
		`Mode: ${input.existingPoints.length > 0 ? "re-sweep" : "initial sweep"}.`,
	].join("\n");
}

/** Load-bearing "at least one section" rule is skipped where an
 *  addition-free plan is legitimate: re-sweeps, and each source-file bucket
 *  of an overflow merge (a bucket may be entirely noise). */
function submissionProblem(sections: PlanDraftSection[], allowEmpty: boolean): string | null {
	if (allowEmpty && sections.length === 0) return null;
	const problems = planProblems(sections);
	return problems.length > 0 ? problems.join("; ") : null;
}

async function mergeOnce(
	input: MergeInput,
	opts: MergeOptions,
	allowEmptySections = input.existingPoints.length > 0,
): Promise<MergeOutput> {
	const value = await runSubmitAgent<SubmitValue>({
		role: "sweepMerger",
		toolName: "submit_plan",
		toolDescription:
			"Submit the merged study plan: sections of testable points and a Left out list of noise. " +
			"One point per skill archetype, one point per must-know fact (each vocab term its own point), " +
			"and noise goes to Left out with a reason.",
		parameters: planSchema,
		fill: fillPlan,
		systemPrompt: SWEEP_MERGER_SYSTEM,
		prompt: mergePrompt(input),
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage) => opts.onUsage(usage),
		neverSubmitted: "the merger never submitted a plan",
		validate: (submission) => submissionProblem(submission.sections, allowEmptySections),
	});

	return { sections: value.sections, leftOut: value.leftOut };
}

/** Two candidates are the same fact when their lower-cased trimmed text is
 *  the same; skill points are never mechanically merged. */
function dedupeFacts(candidates: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	const out: Candidate[] = [];
	for (const candidate of candidates) {
		if (candidate.kind === "fact") {
			const key = candidate.text.trim().toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
		}
		out.push(candidate);
	}
	return out;
}

/** "notes.pdf p. 3" / "deck.pptx slide 4" → the source file. */
function sourceFileOf(source: string): string {
	const match = /^(.*?)(?:\s+(?:p\.|slide)\s+\d+)$/.exec(source.trim());
	return match ? match[1]! : source.trim();
}

/** Concatenate per-group plans: sections with the same title are joined,
 *  first-seen title order wins, and Left out lists are concatenated. */
function combineOutputs(outputs: MergeOutput[]): MergeOutput {
	const byTitle = new Map<string, PlanDraftSection>();
	const order: string[] = [];
	const leftOut: Array<Omit<LeftOutItem, "id">> = [];
	for (const output of outputs) {
		for (const section of output.sections) {
			const key = section.title.trim();
			const existing = byTitle.get(key);
			if (existing) existing.points.push(...section.points);
			else {
				byTitle.set(key, { title: section.title, points: [...section.points] });
				order.push(key);
			}
		}
		leftOut.push(...output.leftOut);
	}
	return { sections: order.map((key) => byTitle.get(key)!), leftOut };
}

async function mergeBySourceFile(input: MergeInput, opts: MergeOptions): Promise<MergeOutput> {
	const groups = new Map<string, Candidate[]>();
	for (const candidate of input.candidates) {
		const file = sourceFileOf(candidate.source);
		const group = groups.get(file);
		if (group) group.push(candidate);
		else groups.set(file, [candidate]);
	}
	// One file cannot be split further — still merge it whole (empty sections
	// allowed, since the combined plan is validated below).
	const outputs: MergeOutput[] = [];
	if (groups.size <= 1) {
		outputs.push(await mergeOnce(input, opts, true));
	} else {
		for (const candidates of groups.values()) {
			outputs.push(await mergeOnce({ ...input, candidates }, opts, true));
		}
	}
	const combined = combineOutputs(outputs);
	const problem = submissionProblem(combined.sections, input.existingPoints.length > 0);
	if (problem) throw new Error(`the merged plan is not usable: ${problem}`);
	return combined;
}

/**
 * Merge all candidates into one plan. Throws when the merger never submits a
 * clean plan within its turn budget.
 */
export async function mergeCandidates(input: MergeInput, opts: MergeOptions): Promise<MergeOutput> {
	let candidates = input.candidates;
	if (JSON.stringify(candidates).length > MERGE_MAX_CHARS) candidates = dedupeFacts(candidates);
	if (JSON.stringify(candidates).length > MERGE_MAX_CHARS) {
		return mergeBySourceFile({ ...input, candidates }, opts);
	}
	return mergeOnce({ ...input, candidates }, opts);
}