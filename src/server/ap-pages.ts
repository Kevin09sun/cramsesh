/**
 * AP page images — one stored paper's original page as a PNG.
 *
 * A released question is shown as the paper's own page, not a retyped copy.
 * Rendering is expensive, so each page is painted once through the headless
 * PDF engine (pdfjs + Skia — no browser) and cached beside the paper, in
 * data/ap-papers/<courseId>/pages/<file-without-.pdf>-p<page>.png. That whole
 * tree is already excluded from the synced data, exactly like the PDFs.
 *
 * The cache file name is built only from the validated paper file name and an
 * integer page. Writes share the paper store's atomic writer (temp beside the
 * target, exclusive create, rename), so two requests racing on one uncached
 * page both render and the last rename wins — never a half-written image. A
 * cached file that is empty or lacks the PNG signature is treated as a miss
 * and overwritten. When a paper is re-saved, the paper store clears its page
 * cache so old pages never show behind the new bytes. The renderer is a test
 * seam: tests inject fixed bytes and nothing paints a real PDF.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { apPageCachePath, apPaperPath, clearApPageCache, writeBytesAtomic } from "./ap-papers.ts";
import { getHeadless } from "../agent/subagents/headless.ts";

/** Page images are rendered at 150 dpi on first view (owner decision). */
export const AP_PAGE_DPI = 150;

/** The eight-byte PNG signature; a cache file that lacks it is not a page. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Re-saved papers clear their cached pages through the paper store's clear;
 *  this is the page layer's public name for the same operation. */
export { clearApPageCache };

/** A renderer may return undefined when the PDF has no such page. */
type ApPageRenderer = (pdfPath: string, page: number, dpi: number) => Promise<Buffer | undefined>;

async function renderWithHeadless(pdfPath: string, page: number, dpi: number): Promise<Buffer | undefined> {
	const [rendered] = await getHeadless().renderPdfPages(pdfPath, [page], { dpi });
	return rendered?.png;
}

let apPageRenderer: ApPageRenderer = renderWithHeadless;

/** Test seam: replace the painting step so no test renders a real PDF. */
export function setApPageRenderer(
	render: (pdfPath: string, page: number, dpi: number) => Promise<Buffer>,
): void {
	apPageRenderer = render;
}

/** A cached file is usable only when it is a non-empty PNG. */
function isPng(bytes: Buffer): boolean {
	return bytes.byteLength >= PNG_SIGNATURE.length && PNG_SIGNATURE.equals(bytes.subarray(0, PNG_SIGNATURE.length));
}

/**
 * PNG bytes of one page of a stored paper. Rendered once, then served from
 * the course's page cache. Validates the course id and file through the
 * paper store first (the file name reaches the filesystem), so an unsafe name
 * throws its refusal rather than touching a path.
 */
export async function apPageImage(courseId: string, file: string, page: number): Promise<Buffer> {
	const paperPath = apPaperPath(courseId, file); // validates the course id and file name
	if (!Number.isSafeInteger(page) || page < 1) throw new Error("no such page");
	if (!fs.existsSync(paperPath)) throw new Error("paper not on this computer");

	const cachedPath = apPageCachePath(courseId, file, page);
	try {
		const cached = await fsp.readFile(cachedPath);
		if (isPng(cached)) return cached;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const png = await apPageRenderer(paperPath, page, AP_PAGE_DPI);
	if (png === undefined) throw new Error("no such page");

	await writeBytesAtomic(cachedPath, png);
	return png;
}
