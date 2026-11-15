/**
 * AP figures — a finished drawing job's stored SVG, served as a PNG.
 *
 * A generated question may show a figure the tutor had the existing visual
 * job draw. The job record owns the SVG (`result.svg`); this module is the
 * read-only bridge from that record to image bytes. Only a finished `visual`
 * job of the SAME chat is a figure: another chat's job, any other job kind,
 * an unfinished or failed drawing, an oversized SVG and an unknown id are
 * never servable.
 *
 * The SVG was written by a model, so its text is never served — only the
 * rasterised PNG leaves this module. Rendering uses the headless module's
 * native resvg path (`nativeOnly`): a stored figure never executes markup,
 * so no browser is involved and none is required. The rasteriser is a test
 * seam; tests inject fixed bytes and nothing paints a real SVG.
 */

import { getHeadless } from "../agent/subagents/headless.ts";
import type { JobRecord, VisualResult } from "../core/contracts.ts";
import { stores } from "./stores.ts";

export type FigureState = "ready" | "pending" | "failed" | "unknown";

/** The chat store's and job store's id guard (src/store/chats.ts, jobs.ts). */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A stored SVG above this many UTF-8 bytes is refused as failed (512 KB). */
const MAX_FIGURE_SVG_BYTES = 512 * 1024;

/** The drawing job owned by this chat, or null for anything else. */
function figureJob(chatId: string, jobId: string): JobRecord | null {
	// Malformed ids can name no record (and the job store's lookup throws on
	// them), so they are "unknown" rather than an error.
	if (!ID_PATTERN.test(chatId) || !ID_PATTERN.test(jobId)) return null;
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.kind !== "visual" || job.chatId !== chatId) return null;
	return job;
}

/** The state of a job this module already knows belongs to the chat. */
function stateOf(job: JobRecord): FigureState {
	if (job.status === "running") return "pending";
	const result = job.result as Partial<VisualResult> | undefined;
	const svg = result?.svg;
	if (
		job.status === "done" &&
		typeof svg === "string" &&
		svg.length > 0 &&
		Buffer.byteLength(svg, "utf8") <= MAX_FIGURE_SVG_BYTES
	) {
		return "ready";
	}
	return "failed";
}

/** A drawing job of this chat, by job id. "unknown" covers another chat's
 *  job, an invalid id and any other job kind. */
export function figureState(chatId: string, jobId: string): FigureState {
	const job = figureJob(chatId, jobId);
	return job ? stateOf(job) : "unknown";
}

/** The headless API's viewport options take width and height together
 *  (`svgViewport`), so it cannot be asked for a width alone; the drawing is
 *  rasterised at its own declared size. */
async function rasteriseWithHeadless(svg: string): Promise<Buffer> {
	return getHeadless().renderSvg(svg, { nativeOnly: true });
}

let figureRasteriser: (svg: string) => Promise<Buffer> = rasteriseWithHeadless;

/** Test seam: replace the rasterising step so no test needs a real renderer. */
export function setFigureRasteriser(render: (svg: string) => Promise<Buffer>): void {
	figureRasteriser = render;
}

/** PNG of a ready figure, rasterised from its stored SVG. Throws
 *  "figure not ready" otherwise. */
export async function figurePng(chatId: string, jobId: string): Promise<Buffer> {
	const job = figureJob(chatId, jobId);
	if (!job || stateOf(job) !== "ready") throw new Error("figure not ready");
	const svg = (job.result as VisualResult).svg;
	return figureRasteriser(svg);
}
