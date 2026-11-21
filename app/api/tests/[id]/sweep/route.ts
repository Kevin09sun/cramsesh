/**
 * GET/POST /api/tests/[id]/sweep — the re-sweep seam (test material sweep,
 * 2026-11-20).
 *
 * POST starts a background re-sweep of the test's materials folder. The
 * orchestrator owns the record's fate (progress, proposals, errors), so this
 * route only admits the launch: an unknown test is a 404, a test with no
 * folder is a 400, and a sweep already running — or proposals still awaiting
 * the learner's review — is a 409. Engines are resolved inside the server
 * seam (src/server/sweep-engines.ts); a missing one is recorded by the
 * orchestrator, never guessed here. The launch is fire-and-forget and the
 * route answers 202 { started: true }.
 *
 * GET serves the sweep-progress view: the latest sweep state and the
 * pending additions review (null when absent).
 */

import { startResweep, stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.testStore.get(id);
	if (!record) return Response.json({ error: "Unknown test" }, { status: 404 });
	return Response.json({
		sweep: record.sweep ?? null,
		pendingAdditions: record.pendingAdditions ?? null,
	});
}

export async function POST(
	_request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await ctx.params;
	const record = stores.testStore.get(id);
	if (!record) return Response.json({ error: "Unknown test" }, { status: 404 });
	if (!record.folder) {
		return Response.json({ error: "no folder stored for this test" }, { status: 400 });
	}
	if (record.sweep?.status === "running") {
		return Response.json({ error: "A sweep is already running for this test." }, { status: 409 });
	}
	if (record.pendingAdditions) {
		return Response.json(
			{ error: "Review the pending additions before re-sweeping." },
			{ status: 409 },
		);
	}

	startResweep(id);
	return Response.json({ started: true }, { status: 202 });
}