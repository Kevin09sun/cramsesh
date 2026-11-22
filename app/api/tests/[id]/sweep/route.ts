/**
 * GET/POST /api/tests/[id]/sweep — the re-sweep seam (test material sweep,
 * 2026-11-20).
 *
 * POST starts a background re-sweep of the test's materials folder. The body
 * is optional JSON `{ folder: string }`: a test that has no stored folder can
 * pick one here, which is validated with resolveSweepFolder (the same
 * validation sweep_materials runs), stored on the record, and swept in the
 * same launch. An absent or empty body, or an object without `folder`, means
 * "use the stored folder". Offering a folder to a test that already has one
 * is a 409. A non-empty body that is not JSON, not an object, or whose
 * `folder` is not a string is a 400, as is a test with no stored folder and
 * no body.
 *
 * The orchestrator owns the record's fate (progress, proposals, errors), so
 * this route only admits the launch: an unknown test is a 404, and a sweep
 * already running — or proposals still awaiting the learner's review — is a
 * 409. Those gates run before the folder is stored, so a refused request
 * never writes one. Engines are resolved inside the server seam
 * (src/server/sweep-engines.ts); a missing one is recorded by the
 * orchestrator, never guessed here. The launch is fire-and-forget and the
 * route answers 202 { started: true }.
 *
 * GET serves the sweep-progress view: the latest sweep state and the
 * pending additions review (null when absent).
 *
 * The mutation carries the shared same-origin guard (src/server/same-origin.ts):
 * browser intent, not authentication — a cross-site caller never launches
 * a sweep.
 */

import {
	recoverInterruptedSweep,
	resolveSweepFolder,
	sameOriginAuthorized,
	startResweep,
	stores,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** 400 for a body that is present but not `{ folder: string }`. */
function badBody(): Response {
	return Response.json({ error: "Body must be JSON { folder: string }." }, { status: 400 });
}

export async function GET(
	_request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await ctx.params;
	let record = stores.testStore.get(id);
	if (!record) return Response.json({ error: "Unknown test" }, { status: 404 });
	// A run whose server process died still says "running"; close it here so
	// the UI never shows a sweep that can never finish.
	record = recoverInterruptedSweep(id, record);
	return Response.json({
		sweep: record.sweep ?? null,
		pendingAdditions: record.pendingAdditions ?? null,
	});
}

export async function POST(
	request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	if (!sameOriginAuthorized(request)) {
		return Response.json(
			{ error: "Re-sweeps require a trusted same-origin request." },
			{ status: 403 },
		);
	}

	const { id } = await ctx.params;
	let record = stores.testStore.get(id);
	if (!record) return Response.json({ error: "Unknown test" }, { status: 404 });
	// A dead process's "running" is not a running sweep: close it before the
	// 409 gate below, or the Re-sweep button would be disabled forever.
	record = recoverInterruptedSweep(id, record);

	// The body is optional: no body (or an empty one) means "use the stored
	// folder". A malformed body is refused before any folder gate.
	const bodyText = await request.text();
	let folder: string | undefined;
	if (bodyText !== "") {
		let body: unknown;
		try {
			body = JSON.parse(bodyText);
		} catch {
			return badBody();
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return badBody();
		}
		const offered = (body as Record<string, unknown>).folder;
		if (offered !== undefined && typeof offered !== "string") {
			return badBody();
		}
		folder = offered;
	}

	// Picking is only for a test that has none; never overwrite a folder.
	if (folder !== undefined && record.folder) {
		return Response.json({ error: "This test already has a folder." }, { status: 409 });
	}
	if (folder === undefined && !record.folder) {
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

	// Validate before storing: a refused folder must leave the record alone.
	if (folder !== undefined) {
		const resolved = await resolveSweepFolder(folder);
		if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 400 });
		stores.testStore.setFolder(id, resolved.folder);
	}

	startResweep(id);
	return Response.json({ started: true }, { status: 202 });
}