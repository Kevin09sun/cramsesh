/**
 * POST /api/tests/[id]/left-out — recover a left-out item into the plan
 * (test material sweep, 2026-11-20).
 *
 * { itemId } goes through testStore.promoteLeftOut: the item becomes an
 * unchecked point in its suggested section (or the first section) and leaves
 * leftOut. Answers 200 with the updated record. An unknown test is a 404, a
 * malformed body a 400, and an unknown item a 404.
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
	const itemId = body.itemId;
	if (typeof itemId !== "string") {
		return Response.json({ error: "itemId must be a string." }, { status: 400 });
	}

	try {
		return Response.json(stores.testStore.promoteLeftOut(id, itemId));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "unknown left-out item") {
			return Response.json({ error: message }, { status: 404 });
		}
		return Response.json({ error: message }, { status: 500 });
	}
}