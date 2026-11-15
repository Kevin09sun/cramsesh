/**
 * AP figures — a finished drawing job's stored SVG, served as a PNG.
 *
 * A generated question may show a figure the tutor had the existing visual
 * job draw. The job record owns the SVG (`result.svg`); this module is the
 * read-only bridge from that record to image bytes. Only a finished `visual`
 * job of the SAME chat is a figure: another chat's job, any other job kind,
 * an unfinished or failed drawing, an oversized SVG or canvas, an unreadable
 * drawing size and an unknown id are never servable.
 *
 * The SVG was written by a model, so its text is never served — only the
 * rasterised PNG leaves this module. Rendering uses the headless module's
 * native resvg path (`nativeOnly`): a stored figure never executes markup,
 * so no browser is involved and none is required. Figures are rendered 1200
 * px wide (the learner's screen is high-density). The rasteriser is a test
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

/** The width every figure is rendered at. */
const FIGURE_WIDTH = 1200;

/** The largest declared side a drawing may have; a larger canvas is refused
 *  rather than allocated. */
const MAX_FIGURE_SIDE = 8000;

/** The drawing job owned by this chat, or null for anything else. */
function figureJob(chatId: string, jobId: string): JobRecord | null {
	// Malformed ids can name no record (and the job store's lookup throws on
	// them), so they are "unknown" rather than an error.
	if (!ID_PATTERN.test(chatId) || !ID_PATTERN.test(jobId)) return null;
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.kind !== "visual" || job.chatId !== chatId) return null;
	return job;
}

interface FigureSize {
	width: number;
	height: number;
}

/** One length attribute: a plain number with an optional lowercase `px`
 *  unit. A percentage or anything else is not a readable size. */
function lengthAttribute(svg: string, name: "width" | "height"): number | null {
	// Anchored to whitespace so `stroke-width` is never read as `width`.
	const match = svg.match(
		new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']?(\\d+(?:\\.\\d+)?)(?:px)?["']?(?=\\s|\\/?>)`),
	);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/** The drawing's declared size: its width and height attributes when both
 *  are plain numbers (an optional `px`), else its viewBox. Null when neither
 *  names a usable size. */
function declaredSize(svg: string): FigureSize | null {
	const width = lengthAttribute(svg, "width");
	const height = lengthAttribute(svg, "height");
	if (width !== null && height !== null) return { width, height };

	const viewBox = svg.match(/(?:^|\s)viewBox\s*=\s*["']([^"']*)["']/);
	if (!viewBox) return null;
	const parts = viewBox[1]!.trim().split(/[\s,]+/).map(Number);
	if (parts.length !== 4) return null;
	const [, , boxWidth, boxHeight] = parts;
	if (
		boxWidth === undefined ||
		boxHeight === undefined ||
		!Number.isFinite(boxWidth) ||
		!Number.isFinite(boxHeight) ||
		boxWidth <= 0 ||
		boxHeight <= 0
	) {
		return null;
	}
	return { width: boxWidth, height: boxHeight };
}

/** The state of a job this module already knows belongs to the chat. */
function stateOf(job: JobRecord): FigureState {
	if (job.status === "running") return "pending";
	const result = job.result as Partial<VisualResult> | undefined;
	const svg = result?.svg;
	if (job.status !== "done" || typeof svg !== "string" || svg.length === 0) return "failed";
	if (Buffer.byteLength(svg, "utf8") > MAX_FIGURE_SVG_BYTES) return "failed";
	const size = declaredSize(svg);
	if (!size || size.width > MAX_FIGURE_SIDE || size.height > MAX_FIGURE_SIDE) return "failed";
	return "ready";
}

/** A drawing job of this chat, by job id. "unknown" covers another chat's
 *  job, an invalid id and any other job kind. */
export function figureState(chatId: string, jobId: string): FigureState {
	const job = figureJob(chatId, jobId);
	return job ? stateOf(job) : "unknown";
}

/** resvg's native path takes its width from `svgViewport`, which honours an
 *  option width only when a height is supplied too — so pass the proportional
 *  height as well; the renderer keeps the drawing's aspect. */
async function rasteriseWithHeadless(svg: string): Promise<Buffer> {
	const size = declaredSize(svg);
	if (!size) throw new Error("figure has no readable size");
	const height = Math.max(1, Math.round((size.height / size.width) * FIGURE_WIDTH));
	return getHeadless().renderSvg(svg, { width: FIGURE_WIDTH, height, nativeOnly: true });
}

let figureRasteriser: (svg: string) => Promise<Buffer> = rasteriseWithHeadless;

/** Test seam: replace the rasterising step so no test needs a real renderer. */
export function setFigureRasteriser(render: (svg: string) => Promise<Buffer>): void {
	figureRasteriser = render;
}

/** Test seam: restore the default (native) rasteriser. */
export function resetFigureRasteriser(): void {
	figureRasteriser = rasteriseWithHeadless;
}

/** PNG of a ready figure, rasterised from its stored SVG. Throws
 *  "figure not ready" otherwise. */
export async function figurePng(chatId: string, jobId: string): Promise<Buffer> {
	const job = figureJob(chatId, jobId);
	if (!job || stateOf(job) !== "ready") throw new Error("figure not ready");
	const svg = (job.result as VisualResult).svg;
	return figureRasteriser(svg);
}
