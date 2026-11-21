/**
 * GET/PUT /api/tests/[id]/plan — the plan-review and plan-edit seam
 * (test prep, 2026-11-10).
 *
 * PUT merges an edited draft through testStore.savePlan: the pure rules
 * (mergePlan/planProblems) own ids, statuses and validation. A draft with
 * problems is a 400 LISTING them — a refused edit never writes. `confirm`
 * rides the same write, so the plan-review card's Confirm is one request.
 * An optional `leftOut` list rides it too: the card sends the sweep's list
 * minus items the learner promoted, and testStore.setLeftOut persists it.
 * Omitting the field leaves the stored list untouched (the readiness view's
 * later edits never erase it).
 *
 * GET serves the latest saved record: the plan-review card renders the
 * record (not the propose_plan call's arguments), so edits made elsewhere
 * always show, and Task 8's readiness view reads the same shape.
 *
 * The trusted same-origin guard is the shared server helper
 * (src/server/same-origin.ts, also used by the custom-provider route): this
 * is browser intent, not user authentication. Reads stay unguarded like
 * every other route; the mutation refuses a cross-site or cross-origin
 * caller.
 */

import { planProblems } from "@/src/core";
import type { LeftOutItem, PlanDraftSection } from "@/src/core";
import { sameOriginAuthorized, stores } from "@/src/server";

export const dynamic = "force-dynamic";

/** Shape gate before planProblems: malformed JSON must not reach `.trim()`. */
function readDraft(value: unknown): PlanDraftSection[] | null {
	if (!Array.isArray(value)) return null;
	const sections: PlanDraftSection[] = [];
	for (const rawSection of value) {
		if (typeof rawSection !== "object" || rawSection === null || Array.isArray(rawSection)) return null;
		const section = rawSection as Record<string, unknown>;
		if (typeof section.title !== "string" || !Array.isArray(section.points)) return null;
		if (section.id !== undefined && typeof section.id !== "string") return null;

		const points: PlanDraftSection["points"] = [];
		for (const rawPoint of section.points) {
			if (typeof rawPoint !== "object" || rawPoint === null || Array.isArray(rawPoint)) return null;
			const point = rawPoint as Record<string, unknown>;
			if (typeof point.text !== "string" || typeof point.source !== "string") return null;
			if (point.id !== undefined && typeof point.id !== "string") return null;
			const id = typeof point.id === "string" ? point.id : undefined;
			points.push({ ...(id === undefined ? {} : { id }), text: point.text, source: point.source });
		}

		const id = typeof section.id === "string" ? section.id : undefined;
		sections.push({ ...(id === undefined ? {} : { id }), title: section.title, points });
	}
	return sections;
}

/** Shape gate for the optional left-out list: every item owns its stable id
 *  and the three displayed strings. Anything else is a refused PUT. */
function readLeftOut(value: unknown): LeftOutItem[] | null {
	if (!Array.isArray(value)) return null;
	const items: LeftOutItem[] = [];
	for (const rawItem of value) {
		if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) return null;
		const item = rawItem as Record<string, unknown>;
		if (
			typeof item.id !== "string" ||
			typeof item.text !== "string" ||
			typeof item.source !== "string" ||
			typeof item.reason !== "string"
		) {
			return null;
		}
		if (item.suggestedSection !== undefined && typeof item.suggestedSection !== "string") return null;
		const suggestedSection =
			typeof item.suggestedSection === "string" ? item.suggestedSection : undefined;
		items.push({
			id: item.id,
			text: item.text,
			source: item.source,
			reason: item.reason,
			...(suggestedSection === undefined ? {} : { suggestedSection }),
		});
	}
	return items;
}

export async function GET(
	_request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.testStore.get(id);
	if (!record) return Response.json({ error: "Unknown test" }, { status: 404 });
	return Response.json(record);
}

export async function PUT(
	request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	if (!sameOriginAuthorized(request)) {
		return Response.json({ error: "Test plan changes require a trusted same-origin request." }, { status: 403 });
	}

	const { id } = await ctx.params;
	if (!stores.testStore.get(id)) return Response.json({ error: "Unknown test" }, { status: 404 });

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "A JSON object is required." }, { status: 400 });
	}
	const sections = readDraft(body.sections);
	if (!sections) {
		return Response.json(
			{ error: "sections must be an array of { id?, title, points: [{ id?, text, source }] }" },
			{ status: 400 },
		);
	}
	if (typeof body.confirm !== "boolean") {
		return Response.json({ error: "confirm must be a boolean." }, { status: 400 });
	}
	let leftOut: LeftOutItem[] | undefined;
	if (body.leftOut !== undefined) {
		const parsed = readLeftOut(body.leftOut);
		if (!parsed) {
			return Response.json(
				{ error: "leftOut must be an array of { id, text, source, reason } objects." },
				{ status: 400 },
			);
		}
		leftOut = parsed;
	}

	const problems = planProblems(sections);
	if (problems.length > 0) {
		return Response.json({ error: "The plan has problems.", problems }, { status: 400 });
	}

	const saved = stores.testStore.savePlan(id, sections, body.confirm);
	return Response.json(leftOut === undefined ? saved : stores.testStore.setLeftOut(id, leftOut));
}