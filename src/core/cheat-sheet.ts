/**
 * Cheat sheet — the concise revision sheet a confirmed test plan can be
 * turned into (issue #15).
 *
 * A sheet is DERIVED, never hand-authored storage: one section per plan
 * section, each with a one-line key idea, a handful of label/body facts,
 * optional single-line formulas and an optional trap. The writer is the
 * merger engine over the material the sweep already read, so every fact is
 * grounded in the learner's own files; this module holds the types, the
 * assembly from the writer's draft, and a plan-only fallback so a missing
 * section can never empty the page.
 *
 * Pure and browser-safe (the core barrel's law): no fs, no model calls.
 */

export interface CheatSheetFact {
	/** Short term, name or formula label; may be empty for a plain line. */
	label: string;
	body: string;
}

export interface CheatSheetSection {
	/** The plan section's id — the sheet follows the plan, not a re-scope. */
	id: string;
	title: string;
	/** One sentence: what this section is really about. */
	idea: string;
	facts: CheatSheetFact[];
	/** Short formulas, sequences or memory hooks (single lines). */
	formulas: string[];
	/** The mistake this material invites, when the writer saw one. */
	trap?: string;
	/** Where the section came from, joined for the footer line. */
	source: string;
}

export interface CheatSheet {
	generatedAt: string;
	/** One sentence framing the whole sheet. */
	intro: string;
	sections: CheatSheetSection[];
}

/** The background build's state; `cheatSheet` is written only on success. */
export interface CheatSheetBuild {
	status: "running" | "error";
	startedAt: string;
	finishedAt?: string;
	error?: string;
}

/** The writer's raw submission, before the plan's ids and fallbacks land. */
export interface CheatSheetDraftSection {
	title: string;
	idea: string;
	facts: CheatSheetFact[];
	formulas: string[];
	trap?: string;
}

export interface CheatSheetDraft {
	intro: string;
	sections: CheatSheetDraftSection[];
}

/** The plan slice assembly reads — structurally satisfied by TestSection. */
export interface PlanSectionLike {
	id: string;
	title: string;
	points: Array<{ text: string; source: string }>;
}

const MAX_FACTS = 8;
const MAX_FORMULAS = 4;
const MAX_LABEL = 80;
const MAX_BODY = 320;
const MAX_IDEA = 220;
const MAX_TRAP = 240;
const MAX_SOURCES = 4;

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
	const flat = oneLine(text);
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function titleKey(title: string): string {
	return title.trim().toLowerCase();
}

/** The plan's distinct sources, trimmed and capped for one quiet line. */
export function sectionSources(section: PlanSectionLike): string {
	const seen: string[] = [];
	for (const point of section.points) {
		const source = oneLine(point.source);
		if (source !== "" && !seen.includes(source)) seen.push(source);
	}
	if (seen.length === 0) return "your materials";
	if (seen.length <= MAX_SOURCES) return seen.join(", ");
	return `${seen.slice(0, MAX_SOURCES).join(", ")} +${seen.length - MAX_SOURCES} more`;
}

/** The plan-only section: used when the writer omitted one, so the sheet is
 *  always complete. It states scope (the plan's own points), never invents a
 *  fact — the writer is the only source of condensed content. */
export function planOnlySection(section: PlanSectionLike): CheatSheetSection {
	const points = section.points.slice(0, MAX_FACTS);
	return {
		id: section.id,
		title: section.title,
		idea:
			points.length === 0
				? "No points in this section yet."
				: clip(`What you need to be able to do: ${points.map((point) => oneLine(point.text)).join("; ")}`, MAX_IDEA),
		facts: points.map((point) => ({ label: "", body: clip(point.text, MAX_BODY) })),
		formulas: [],
		source: sectionSources(section),
	};
}

/** Assemble the stored sheet: plan order, plan ids, the writer's content
 *  matched by section title, and the plan-only fallback for anything the
 *  writer skipped. Draft entries that match no plan section are dropped —
 *  the sheet never adds scope the learner did not confirm. */
export function assembleCheatSheet(
	plan: PlanSectionLike[],
	draft: CheatSheetDraft,
	generatedAt: string,
): CheatSheet {
	const sections = plan.map((planSection): CheatSheetSection => {
		const draftSection = draft.sections.find(
			(candidate) => titleKey(candidate.title) === titleKey(planSection.title),
		);
		if (!draftSection) return planOnlySection(planSection);
		const facts = draftSection.facts
			.map((fact) => ({ label: clip(fact.label, MAX_LABEL), body: clip(fact.body, MAX_BODY) }))
			.filter((fact) => fact.label !== "" || fact.body !== "")
			.slice(0, MAX_FACTS);
		const formulas = draftSection.formulas
			.map((formula) => clip(formula, MAX_BODY))
			.filter((formula) => formula !== "")
			.slice(0, MAX_FORMULAS);
		const idea = clip(draftSection.idea, MAX_IDEA);
		const trap = draftSection.trap === undefined ? "" : clip(draftSection.trap, MAX_TRAP);
		// A writer section with no usable facts is no better than the plan's
		// own points: fall back rather than render an empty card.
		if (facts.length === 0) return planOnlySection(planSection);
		return {
			id: planSection.id,
			title: planSection.title,
			idea: idea === "" ? planOnlySection(planSection).idea : idea,
			facts,
			formulas,
			...(trap === "" ? {} : { trap }),
			source: sectionSources(planSection),
		};
	});

	return { generatedAt, intro: clip(draft.intro, MAX_IDEA), sections };
}

/** Defensive read of a stored sheet (a hand-edited or older record must
 *  render or read as absent, never crash the page). */
export function normalizeCheatSheet(value: unknown): CheatSheet | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.generatedAt !== "string" || !Array.isArray(record.sections)) return null;

	const sections: CheatSheetSection[] = [];
	for (const rawSection of record.sections) {
		if (typeof rawSection !== "object" || rawSection === null || Array.isArray(rawSection)) return null;
		const section = rawSection as Record<string, unknown>;
		if (
			typeof section.id !== "string" ||
			typeof section.title !== "string" ||
			typeof section.idea !== "string" ||
			typeof section.source !== "string" ||
			!Array.isArray(section.facts) ||
			!Array.isArray(section.formulas)
		) {
			return null;
		}
		const facts: CheatSheetFact[] = [];
		for (const rawFact of section.facts) {
			if (typeof rawFact !== "object" || rawFact === null || Array.isArray(rawFact)) return null;
			const fact = rawFact as Record<string, unknown>;
			if (typeof fact.label !== "string" || typeof fact.body !== "string") return null;
			facts.push({ label: fact.label, body: fact.body });
		}
		if (!section.formulas.every((formula): formula is string => typeof formula === "string")) return null;
		if (section.trap !== undefined && typeof section.trap !== "string") return null;
		sections.push({
			id: section.id,
			title: section.title,
			idea: section.idea,
			facts,
			formulas: section.formulas,
			...(section.trap === undefined ? {} : { trap: section.trap }),
			source: section.source,
		});
	}

	return {
		generatedAt: record.generatedAt,
		intro: typeof record.intro === "string" ? record.intro : "",
		sections,
	};
}