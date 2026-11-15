/**
 * GET /api/chats/[id]/figures/[jobId] — one finished drawing of a chat as a
 * PNG (AP prep stage 3, 2026-11-15).
 *
 * The URL is only a pair of ids to look up. A figure is served only for a
 * finished `visual` job of this chat whose stored SVG is ready; every other
 * combination — another chat's job, another job kind, an unfinished or failed
 * drawing, a malformed segment — is a 404. The model-written SVG text is
 * never served, only the rasterised PNG. The response is `no-cache` because a
 * job id names one drawing but its bytes are rendered on request. The route
 * never creates, modifies or deletes a job or chat record. An unexpected
 * rasteriser failure is logged and answers 500.
 */

import { figurePng, figureState } from "@/src/server";

export const dynamic = "force-dynamic";

const PNG_HEADERS = {
	"content-type": "image/png",
	"cache-control": "private, no-cache",
};

/** The only failure a URL can rightly earn; anything else is a real fault. */
function isExpectedFigureError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message === "figure not ready";
}

function notFound(): Response {
	return Response.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
	_request: Request,
	ctx: { params: Promise<{ id: string; jobId: string }> },
): Promise<Response> {
	const { id, jobId } = await ctx.params;
	// The same id guard the chat and job stores use: a malformed segment can
	// name no record, so it is a 404 before any store read.
	if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(jobId)) return notFound();
	if (figureState(id, jobId) !== "ready") return notFound();

	try {
		const png = await figurePng(id, jobId);
		// Copy into a plain Uint8Array: Buffer's ArrayBufferLike backing is not
		// a BodyInit in the DOM types.
		return new Response(new Uint8Array(png), { status: 200, headers: PNG_HEADERS });
	} catch (error) {
		if (isExpectedFigureError(error)) return notFound();
		console.error(`AP figure failed for ${id}/${jobId}:`, error);
		return Response.json({ error: "Could not render the figure" }, { status: 500 });
	}
}
