/**
 * GET /api/ap/[id]/pages/[file]/[page] — one original page image of a stored
 * paper (AP prep stage 2, 2026-11-14).
 *
 * The URL's file segment is only a name to look up: a page is served only
 * when the course manifest holds this file as an frq or ced document. The
 * learner never sees the scoring guideline, so a scoring document is always a
 * 404 — present or not. The image itself is rendered once and served from the
 * local page cache with a year-long private immutable header. An unknown
 * course, an unknown document, an absent paper and an invalid page are all
 * 404s (the second computer's missing paper must not throw). Reads stay
 * unguarded like every other read route.
 */

import { apPageImage, stores } from "@/src/server";

export const dynamic = "force-dynamic";

const PNG_HEADERS = {
	"content-type": "image/png",
	"cache-control": "private, max-age=31536000, immutable",
};

function notFound(): Response {
	return Response.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
	_request: Request,
	ctx: { params: Promise<{ id: string; file: string; page: string }> },
): Promise<Response> {
	const { id, file, page } = await ctx.params;
	const record = stores.apCourseStore.get(id);
	if (!record) return Response.json({ error: "Unknown AP course" }, { status: 404 });

	const document = record.documents.find(
		(candidate) => candidate.file === file && (candidate.kind === "frq" || candidate.kind === "ced"),
	);
	if (!document) return Response.json({ error: "Unknown AP document" }, { status: 404 });

	if (!/^\d+$/.test(page)) return notFound();
	try {
		const png = await apPageImage(id, file, Number(page));
		// Copy into a plain Uint8Array: Buffer's ArrayBufferLike backing is not
		// a BodyInit in the DOM types.
		return new Response(new Uint8Array(png), { status: 200, headers: PNG_HEADERS });
	} catch {
		// An absent paper or a page the paper does not have is a 404, not a
		// thrown error.
		return notFound();
	}
}