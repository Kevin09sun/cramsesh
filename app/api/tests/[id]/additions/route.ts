/**
 * POST /api/tests/[id]/additions — resolve a re-sweep's pending additions
 * (test material sweep, 2026-11-20).
 *
 * The learner's accepted proposal keys ({ accepted: string[] }, keyed
 * "sectionIndex:pointIndex") go through testStore.resolveAdditions: accepted
 * points become unchecked additions, everything else lands in leftOut, and
 * the review clears. Answers 200 with the updated record. An unknown test is
 * a 404; a malformed body a 400; a review already resolved a 409.
 */

import { stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(
	request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await ctx.params;
	if (!stores.testStore.get(id)) return Response.json({ error: "Unknown test" }, { status: 404 });

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "A JSON object is required." }, { status: 400 });
	}
	const accepted = body.accepted;
	if (!Array.isArray(accepted) || !accepted.every((key): key is string => typeof key === "string")) {
		return Response.json({ error: "accepted must be an array of strings." }, { status: 400 });
	}

	try {
		return Response.json(stores.testStore.resolveAdditions(id, accepted));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "no pending additions") {
			return Response.json({ error: message }, { status: 409 });
		}
		return Response.json({ error: message }, { status: 500 });
	}
}