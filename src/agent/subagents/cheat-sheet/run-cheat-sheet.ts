/**
 * The cheat sheet writer (issue #15): turn a confirmed test plan into one
 * concise, visual revision sheet, grounded in the material the sweep already
 * read.
 *
 * The sweep caches each file's transcript (`data/tests/<id>/sweep/*.md`,
 * `<!-- source: … -->` markers and all) keyed by content hash. This module
 * reads that cache, lifts each plan section's cited pages out of it, and
 * asks the strong merger engine — the same role the plan itself came from —
 * for one card per plan section. The writer never adds scope: sections are
 * matched to the plan by title and the plan's ids are applied on assembly;
 * a section the writer skipped falls back to the plan's own points.
 *
 * No storage or framework imports beyond the injected store port: the
 * orchestrator owns the record's build state, exactly like the sweep.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { PATHS } from "../../../../config.ts";
import { assembleCheatSheet, type CheatSheet, type CheatSheetDraft, type PlanSectionLike } from "../../../core/cheat-sheet.ts";
import type { TestRecord } from "../../../core/test-prep.ts";
import type { PiEngine } from "../../models.ts";
import { runSubmitAgent } from "../submit-agent.ts";
import { SWEEP_CACHE_META, splitMaterialMarkers, type MaterialSegment } from "./cached-material.ts";

export interface CheatSheetStore {
	get(id: string): TestRecord | null;
	setCheatSheet(id: string, sheet: CheatSheet): TestRecord;
}

export interface CheatSheetDeps {
	store: CheatSheetStore;
	/** The strong engine; absent = "models not configured". */
	engine?: PiEngine;
	signal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	/** Tests replace the cache read and the model call here. */
	stages?: {
		material?: (testId: string) => Promise<string[]>;
		write?: (record: TestRecord, material: string[]) => Promise<CheatSheetDraft>;
	};
}

const MAX_SECTION_CHARS = 9_000;
const MAX_TOTAL_CHARS = 55_000;

function normalizeSource(source: string): string {
	return source.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A source without its page/slide suffix: "notes.pdf p. 3" → "notes.pdf". */
function sourceFile(source: string): string {
	return normalizeSource(source).replace(/\s+(p\.|page|slide|pp\.)\s*\d+$/i, "").trim();
}

/** Same page/slide citation: "notes.pdf" cites every page, "notes.pdf p. 3"
 *  cites that one, and "notes.pdf p. 3" cites bare "notes.pdf" too. */
function sourceExact(pointSource: string, segmentSource: string): boolean {
	const point = normalizeSource(pointSource);
	const segment = normalizeSource(segmentSource);
	if (point === "" || segment === "") return false;
	if (point === segment) return true;
	return segment.startsWith(`${point} `) || point.startsWith(`${segment} `);
}

/**
 * The material an engine should see for one plan section: every cached
 * segment its points cite, exact page matches first, then the rest of a
 * cited file, capped so one long section cannot crowd out the others.
 */
export function sectionExcerpt(section: PlanSectionLike, material: string[], cap = MAX_SECTION_CHARS): string {
	const segments = splitMaterialMarkers(material);
	const sources = section.points.map((point) => point.source).filter((source) => source.trim() !== "");
	const picked: MaterialSegment[] = [];
	const seen = new Set<string>();

	const pick = (segment: MaterialSegment): void => {
		if (segments.length === 0 || picked.includes(segment)) return;
		const key = normalizeSource(segment.source);
		if (seen.has(key)) return;
		seen.add(key);
		picked.push(segment);
	};

	// Pass 1: exact page/slide citations.
	for (const source of sources) {
		for (const segment of segments) if (sourceExact(source, segment.source)) pick(segment);
	}
	// Pass 2: the rest of any cited file, so a citation of one page does not
	// starve a section whose material lives on its neighbours.
	if (picked.length === 0) {
		const files = new Set(sources.map(sourceFile).filter((file) => file !== ""));
		for (const segment of segments) if (files.has(sourceFile(segment.source))) pick(segment);
	}

	let out = "";
	for (const segment of picked) {
		const label = segment.source === "" ? "(unnamed)" : segment.source;
		const block = `<!-- source: ${label} -->\n${segment.text.trim()}`;
		if (out.length + block.length + 2 > cap) break;
		out = out === "" ? block : `${out}\n\n${block}`;
	}
	return out;
}

/** The whole prompt input: plan sections with their points and excerpts. */
export function planExcerpts(record: TestRecord, material: string[]): Array<{ section: PlanSectionLike; excerpt: string }> {
	const sections = record.sections;
	const perSection = Math.max(
		2_500,
		Math.min(MAX_SECTION_CHARS, Math.floor(MAX_TOTAL_CHARS / Math.max(1, sections.length))),
	);
	return sections.map((section) => ({
		section,
		excerpt: sectionExcerpt(section, material, perSection),
	}));
}

export function buildSheetPrompt(record: TestRecord, material: string[]): string {
	const plan = planExcerpts(record, material).map(({ section, excerpt }, index) =>
		[
			`## ${index + 1}. ${section.title}`,
			"Points this sheet must cover:",
			...section.points.map((point) => `- ${point.text} (from ${point.source})`),
			"",
			excerpt === ""
				? "No material excerpt found for this section. Write only what the plan points themselves state — no invented facts."
				: `Material excerpt:\n${excerpt}`,
		].join("\n"),
	);

	return [
		`Test: ${record.title}`,
		"",
		"Plan sections, in order (use these exact titles, once each):",
		...plan,
	].join("\n");
}

const sheetSchema = Type.Object({
	intro: Type.String({
		description: "One sentence naming what this sheet covers. No greeting, no praise.",
	}),
	sections: Type.Array(
		Type.Object({
			title: Type.String({ description: "The plan section's exact title, copied from the input." }),
			idea: Type.String({
				description: "One sentence: the core idea of this section, in plain words.",
			}),
			facts: Type.Array(
				Type.Object({
					label: Type.String({
						description: "The term, name, date or symbol. Empty string for a plain line without a label.",
					}),
					body: Type.String({
						description: "The fact in at most 25 words: self-contained and answerable as written.",
					}),
				}),
				{ description: "3 to 6 facts. The smallest set that lets the learner answer the plan's questions." },
			),
			formulas: Type.Array(Type.String(), {
				description:
					"Zero to 4 short formulas, sequences or memory hooks copied exactly from the material. Empty when none.",
			}),
			trap: Type.Optional(
				Type.String({
					description:
						"One sentence: the mistake this material invites, only when the excerpt shows one. Omit otherwise.",
				}),
			),
		}),
		{ description: "One entry per plan section, in the plan's order." },
	),
});

type SubmitValue = Static<typeof sheetSchema>;

function fillSheet(input: any): SubmitValue {
	return {
		intro: String(input.intro ?? "").trim(),
		sections: (input.sections as any[]).map((section) => {
			const trap = String(section.trap ?? "").trim();
			return {
				title: String(section.title ?? "").trim(),
				idea: String(section.idea ?? "").trim(),
				facts: (section.facts as any[]).map((fact) => ({
					label: String(fact.label ?? "").trim(),
					body: String(fact.body ?? "").trim(),
				})),
				formulas: (section.formulas as any[]).map((formula) => String(formula ?? "").trim()).filter((formula) => formula !== ""),
				...(trap === "" ? {} : { trap }),
			};
		}),
	};
}

const SHEET_SYSTEM = `You write a one-page revision cheat sheet for a student preparing for a named test.

Work only from the supplied plan and material excerpts. Never add a fact the excerpts do not support; when an
excerpt is missing, write only what the plan's own points state. Be ruthless about brevity: the goal is the
smallest set of facts that lets the student answer the plan's questions under time pressure.

For every plan section, in the plan's order and with its exact title:
- idea: one sentence, the section's core.
- facts: 3 to 6. Each has a short label (a term, name, date or symbol; an empty label is allowed for a plain
  line) and a body of at most 25 words that stands on its own. Keep numbers, names and wording exactly as the
  material gives them. If the excerpt supports fewer than three facts, give fewer — never pad with general
  knowledge the excerpt does not state.
- formulas: zero to 4 single-line formulas, reaction sequences or memory hooks, copied exactly. Empty when the
  material has none.
- trap: at most one sentence on the mistake this material invites, only when the excerpt shows one. Omit it
  otherwise.

No greetings, no praise, no "remember to study", no markdown in the strings, no extra sections.`;

function coverageProblem(value: SubmitValue, plan: PlanSectionLike[]): string | null {
	const present = new Map(value.sections.map((section) => [section.title.trim().toLowerCase(), section]));
	const missing = plan
		.filter((section) => !present.has(section.title.trim().toLowerCase()))
		.map((section) => `"${section.title}"`);
	if (missing.length > 0) {
		return `missing section(s): ${missing.join(", ")} — submit one entry per plan section, using the plan's exact titles`;
	}
	const empty = value.sections
		.filter((section) => section.facts.length === 0)
		.map((section) => `"${section.title}"`);
	if (empty.length > 0) {
		return `section(s) ${empty.join(", ")} have no facts — give each at least one grounded fact`;
	}
	return null;
}

async function writeSheet(record: TestRecord, material: string[], deps: CheatSheetDeps): Promise<CheatSheetDraft> {
	const value = await runSubmitAgent<SubmitValue>({
		role: "sweepMerger",
		toolName: "submit_cheat_sheet",
		toolDescription:
			"Submit the revision cheat sheet: one entry per plan section with a one-sentence idea, 3–6 grounded " +
			"facts, optional short formulas and an optional trap.",
		parameters: sheetSchema,
		fill: fillSheet,
		systemPrompt: SHEET_SYSTEM,
		prompt: buildSheetPrompt(record, material),
		engine: deps.engine,
		signal: deps.signal,
		onStep: (usage) => deps.onUsage?.(usage),
		neverSubmitted: "the cheat sheet writer never submitted a sheet",
		validate: (submission) => coverageProblem(submission, record.sections),
	});
	return value;
}

/**
 * Read every cached sweep transcript for a test. Files are hash-named, so
 * the rel recorded in the cache header is what identifies them; a file that
 * is not a sweep cache entry is skipped rather than parsed as material.
 */
async function readCachedMaterial(testId: string): Promise<string[]> {
	const dir = path.join(PATHS.tests, testId, "sweep");
	let names: string[];
	try {
		names = await fsp.readdir(dir);
	} catch {
		return [];
	}
	const files = names.filter((name) => name.endsWith(".md"));
	const contents: string[] = [];
	for (const name of files.sort()) {
		try {
			const raw = await fsp.readFile(path.join(dir, name), "utf8");
			const match = SWEEP_CACHE_META.exec(raw);
			if (!match) continue;
			contents.push(raw.slice(match[0].length));
		} catch {
			// A cache entry that cannot be read is simply absent.
		}
	}
	return contents;
}

export interface CheatSheetOutcome {
	ok: boolean;
	sections: number;
	error?: string;
}

export const NO_MATCH_ERROR =
	"Your plan's sources do not line up with the material that was read. Re-sweep the folder, then build the sheet again.";

/** Build and store one test's revision sheet. Throws only on unexpected
 *  failures; the server seam records the error on the record's build state. */
export async function runCheatSheet(testId: string, deps: CheatSheetDeps): Promise<CheatSheetOutcome> {
	const record = deps.store.get(testId);
	if (!record) throw new Error(`unknown test: ${testId}`);
	if (!record.planConfirmed) throw new Error("Confirm the plan before building a cheat sheet.");
	if (record.sections.length === 0) throw new Error("This test has no plan sections yet.");

	const material = await (deps.stages?.material ?? readCachedMaterial)(testId);
	if (material.length === 0) {
		throw new Error("No read material found for this test. Re-sweep the folder, then build the sheet again.");
	}
	// Every section's cited pages missed: writing from the plan alone would
	// invent content the learner's material does not support.
	if (planExcerpts(record, material).every(({ excerpt }) => excerpt === "")) {
		throw new Error(NO_MATCH_ERROR);
	}

	const draft = await (deps.stages?.write ?? ((current: TestRecord, source: string[]) => writeSheet(current, source, deps)))(
		record,
		material,
	);
	const sheet = assembleCheatSheet(record.sections, draft, new Date().toISOString());
	deps.store.setCheatSheet(testId, sheet);
	return { ok: true, sections: sheet.sections.length };
}