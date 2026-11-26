/**
 * POST /api/tests/[id]/skip — a sitting's Skip action (issue #13): the
 * learner sees a check_point question, decides the point is irrelevant, and
 * erases it from the plan in one click.
 *
 * { pointId } goes through testStore.skipPoint: the point leaves the plan
 * (a section left with no points goes too) and lands in leftOut as "skipped
 * by you", so it stays recoverable from the readiness page. Answers 200 with
 * the updated record. An unknown test is a 404, a malformed body a 400,
 * unknown points are a no-op 200 (a retried skip), and skipping the plan's
 * last point is a 409. The mutation carries the shared same-origin guard
 * (src/server/same-origin.ts).
 */

import { sameOriginAuthorized, stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(
	request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	if (!sameOriginAuthorized(request)) {
		return Response.json(
			{ error: "Plan changes require a trusted same-origin request." },
			{ status: 403 },
		);
	}

	const { id } = await ctx.params;
	if (!stores.testStore.get(id)) return Response.json({ error: "Unknown test" }, { status: 404 });

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "A JSON object is required." }, { status: 400 });
	}
	const pointId = body.pointId;
	if (typeof pointId !== "string" || pointId.length === 0) {
		return Response.json({ error: "pointId must be a non-empty string." }, { status: 400 });
	}

	try {
		return Response.json(stores.testStore.skipPoint(id, pointId));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === "the plan's last point cannot be skipped") {
			return Response.json({ error: message }, { status: 409 });
		}
		return Response.json({ error: message }, { status: 500 });
	}
}