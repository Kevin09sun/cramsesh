/**
 * Test-material sweep, stage 2 (Task 5) — chunk the transcripts and extract
 * every testable candidate from each chunk.
 *
 * `chunkTranscripts` reuses the app's greedy line chunker (`chunkNotes`,
 * chars/4) and repairs the one thing a transcript needs that a note does not:
 * a chunk that starts mid-unit is prefixed with the `<!-- source: … -->`
 * marker in force, so every candidate can cite a page that is visibly in
 * front of the model. `extractCandidates` runs the cheap extractor over one
 * chunk and rejects a candidate whose `source` names no marker in that chunk
 * (the model retries within the submit agent's turn budget).
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { chunkNotes } from "../extraction.ts";
import type { PiEngine } from "../../models.ts";
import { runSubmitAgent } from "../submit-agent.ts";
import type { Transcript } from "./transcribe.ts";
import { SWEEP_EXTRACTOR_SYSTEM } from "./prompts.ts";

export interface Candidate {
	kind: "skill" | "fact";
	category: string;
	text: string;
	source: string;
	evidence: string;
}

const MARKER = /^<!--\s*source:\s*(.+?)\s*-->$/;

/** The `source` text inside one marker line, or null when the line is not a
 *  marker. */
function markerSource(line: string): string | null {
	const match = MARKER.exec(line.trim());
	return match ? match[1]! : null;
}

/** Every distinct marker source present in `text`, in first-appearance order. */
function markerSources(text: string): string[] {
	const seen: string[] = [];
	for (const line of text.split("\n")) {
		const source = markerSource(line);
		if (source !== null && !seen.includes(source)) seen.push(source);
	}
	return seen;
}

/** Index where `chunkLines` occurs in `lines` at or after `from`, or -1.
 *  chunkNotes returns contiguous line runs, so this recovers a chunk's true
 *  start even when the chunker dropped a blank line at a break. */
function locateChunk(chunkLines: string[], lines: string[], from: number): number {
	for (let start = from; start + chunkLines.length <= lines.length; start++) {
		let matches = true;
		for (let index = 0; index < chunkLines.length; index++) {
			if (lines[start + index] !== chunkLines[index]) {
				matches = false;
				break;
			}
		}
		if (matches) return start;
	}
	return -1;
}

/**
 * Split every transcript into chunks of at most `budget` tokens (chars/4).
 * Markers cross chunk boundaries here: when a chunk does not itself begin
 * with a marker line, the marker in force at its first line is prepended.
 */
export function chunkTranscripts(transcripts: Transcript[], budget: number): string[] {
	const chunks: string[] = [];
	for (const transcript of transcripts) {
		const markdown = transcript.markdown;
		if (markdown.trim().length === 0) continue;
		const lines = markdown.split("\n");

		// active[i] is the marker source in force at the START of line i
		// (a marker on line i itself is not yet in force for that line).
		const active: string[] = [];
		let inForce = "";
		for (const line of lines) {
			active.push(inForce);
			const source = markerSource(line);
			if (source !== null) inForce = source;
		}

		let cursor = 0;
		for (const chunk of chunkNotes(markdown, budget)) {
			const chunkLines = chunk.split("\n");
			// chunkNotes can drop a blank line that triggered a break, so the
			// cursor cannot simply add chunk lengths: find where this chunk
			// really starts in the source lines.
			const start = locateChunk(chunkLines, lines, cursor);
			const startLine = start >= 0 ? start : cursor;
			cursor = startLine + chunkLines.length;

			// A chunk of marker lines only is not worth a model call; the
			// next chunk carries the same marker in force.
			const hasContent = chunkLines.some((line) => line.trim() !== "" && markerSource(line) === null);
			if (!hasContent) continue;

			const startsWithMarker = markerSource(chunkLines[0] ?? "") !== null;
			const carried = active[startLine] ?? "";
			chunks.push(startsWithMarker || carried === "" ? chunk : `<!-- source: ${carried} -->\n${chunk}`);
		}
	}
	return chunks;
}

const candidateSchema = Type.Object({
	candidates: Type.Array(
		Type.Object({
			kind: Type.Union([Type.Literal("skill"), Type.Literal("fact")], {
				description: '"skill" for a "can do X" problem type, "fact" for an item known one by one.',
			}),
			category: Type.String({
				description:
					"One of: vocab/term, definition, formula, person, date/event, process/steps, " +
					"labeled diagram, worked-example type, comparison, other.",
			}),
			text: Type.String({ description: "The testable item, stated on its own." }),
			source: Type.String({
				description:
					"The exact text inside one `<!-- source: … -->` marker in the chunk, e.g. " +
					'"notes.pdf p. 3". Never invent a source.',
			}),
			evidence: Type.String({ description: "The short quote or detail that supports the candidate." }),
		}),
	),
});

type SubmitValue = Static<typeof candidateSchema>;

function fillCandidates(input: any): SubmitValue {
	return {
		candidates: (input.candidates as any[]).map((candidate) => ({
			kind: candidate.kind,
			category: String(candidate.category ?? "").trim(),
			text: String(candidate.text ?? "").trim(),
			source: String(candidate.source ?? "").trim(),
			evidence: String(candidate.evidence ?? "").trim(),
		})),
	};
}

export interface ExtractCandidatesOptions {
	engine?: PiEngine;
	signal?: AbortSignal;
	onUsage: (usage: Usage) => void;
}

export interface ExtractCandidatesResult {
	candidates: Candidate[];
	markersSeen: string[];
}

/** Extract every candidate from one chunk. Throws when the extractor never
 *  submits a clean list within its turn budget. */
export async function extractCandidates(
	chunk: string,
	opts: ExtractCandidatesOptions,
): Promise<ExtractCandidatesResult> {
	const markersSeen = markerSources(chunk);
	const allowed = new Set(markersSeen);

	const value = await runSubmitAgent<SubmitValue>({
		role: "sweepExtractor",
		toolName: "submit_candidates",
		toolDescription:
			"Submit every testable candidate found in this chunk of test material: each vocab term, " +
			"definition, formula, person, date/event, process, labeled diagram, worked-example type, " +
			"comparison or other testable item, with its kind, category, source marker and evidence.",
		parameters: candidateSchema,
		fill: fillCandidates,
		systemPrompt: SWEEP_EXTRACTOR_SYSTEM,
		prompt: `Chunk of test material:\n\n${chunk}`,
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage) => opts.onUsage(usage),
		neverSubmitted: "the extractor never submitted candidates",
		validate: (submission) => {
			const bad = submission.candidates.filter((candidate) => !allowed.has(candidate.source));
			if (bad.length === 0) return null;
			const list = bad.map((candidate) => `"${candidate.source}"`).join(", ");
			return (
				`candidate source ${list} is not a marker in this chunk` +
				(markersSeen.length > 0 ? ` (markers: ${markersSeen.map((m) => `"${m}"`).join(", ")})` : "")
			);
		},
	});

	return { candidates: value.candidates, markersSeen };
}