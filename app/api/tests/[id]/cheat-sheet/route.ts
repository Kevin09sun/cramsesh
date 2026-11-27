/**
 * GET/POST /api/tests/[id]/cheat-sheet — the revision sheet's build seam
 * (issue #15).
 *
 * POST starts a background build from the test's confirmed plan and the
 * material the sweep cached. The plan must be confirmed (409 otherwise: the
 * sheet derives from approved scope, never a pending proposal), and a build
 * already running is a 409. A dead process's "running" is closed first, so
 * the button can never be disabled forever.
 *
 * GET serves the stored sheet (null until the first successful build) and
 * the build state (null when idle). The page polls it while building.
 *
 * Reads stay unguarded like every other route; the mutation carries the
 * shared same-origin guard. The launch is fire-and-forget: 202
 * { started: true }.
 */

import { normalizeCheatSheet } from "@/src/core";
import {
	recoverInterruptedCheatSheet,
	sameOriginAuthorized,
	startCheatSheetBuild,
	stores,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await ctx.params;
	let record = stores.testStore.get(id);
	if (!record) return Response.json({ error: "Unknown test" }, { status: 404 });
	record = recoverInterruptedCheatSheet(record);
	return Response.json({
		cheatSheet: normalizeCheatSheet(record.cheatSheet),
		build: record.cheatSheetBuild ?? null,
	});
}

export async function POST(
	request: Request,
	ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
	if (!sameOriginAuthorized(request)) {
		return Response.json(
			{ error: "Building a cheat sheet requires a trusted same-origin request." },
			{ status: 403 },
		);
	}

	const { id } = await ctx.params;
	let record = stores.testStore.get(id);
	if (!record) return Response.json({ error: "Unknown test" }, { status: 404 });
	record = recoverInterruptedCheatSheet(record);

	if (!record.planConfirmed) {
		return Response.json({ error: "Confirm the plan before building a cheat sheet." }, { status: 409 });
	}
	if (record.cheatSheetBuild?.status === "running") {
		return Response.json({ error: "A cheat sheet is already being built." }, { status: 409 });
	}

	startCheatSheetBuild(id);
	return Response.json({ started: true }, { status: 202 });
}