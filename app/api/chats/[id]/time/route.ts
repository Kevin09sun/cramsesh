import { parseStudyChunk } from "@/src/core";
import { getChat, stores } from "@/src/server";

/**
 * The session clock's write seam (issue #16, owner-approved 2026-11-27).
 *
 * The open chat page counts time while the learner is in the session
 * (components/study-clock.ts) and posts a chunk every ~15 seconds and once
 * more as the page is left. One body {day, ms}: the learner's LOCAL calendar
 * day and the counted milliseconds. The store merges chunks per day, so a
 * session holds at most one entry per day regardless of how many arrive.
 *
 * Validation is the shared pure rule (core/study-time.ts): a real calendar
 * day, an integer, positive, at most ten minutes per chunk. Anything else
 * is a 400 and writes nothing — a forged or buggy client must never inflate
 * a record. Unknown sessions are a 404; time is only ever added to a
 * record that exists.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const chunk = parseStudyChunk(await req.json().catch(() => null));
	if (!chunk) return Response.json({ error: "Invalid time chunk" }, { status: 400 });

	const timeMs = stores.chatStore.addStudyTime(id, chunk.day, chunk.ms);
	return Response.json({ timeMs });
}