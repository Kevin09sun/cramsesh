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
 * integer page, and every write is atomic (temp beside the target, exclusive
 * create, rename), so two requests racing on one uncached page both render
 * and the last rename wins — never a half-written image. The renderer is a
 * test seam: tests inject fixed bytes and nothing paints a real PDF.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { apPaperPath, apPapersDir } from "./ap-papers.ts";
import { getHeadless } from "../agent/subagents/headless.ts";

/** Page images are rendered at 150 dpi on first view (owner decision). */
export const AP_PAGE_DPI = 150;

/** The cache filename's suffix convention: "ced.pdf" page 3 → "ced-p3.png". */
function pageCachePath(courseId: string, file: string, page: number): string {
	return path.join(apPapersDir(courseId), "pages", `${file.replace(/\.pdf$/, "")}-p${page}.png`);
}

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

/**
 * PNG bytes of one page of a stored paper. Rendered once, then served from
 * the course's page cache. Validates the course id and file through the
 * paper store first (the file name reaches the filesystem), so an unsafe name
 * throws its refusal rather than touching a path.
 */
export async function apPageImage(courseId: string, file: string, page: number): Promise<Buffer> {
	const paperPath = apPaperPath(courseId, file); // validates the course id and file name
	if (!Number.isInteger(page) || page < 1) throw new Error("no such page");
	if (!fs.existsSync(paperPath)) throw new Error("paper not on this computer");

	const cachedPath = pageCachePath(courseId, file, page);
	try {
		return await fsp.readFile(cachedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const png = await apPageRenderer(paperPath, page, AP_PAGE_DPI);
	if (png === undefined) throw new Error("no such page");

	await writePageAtomic(cachedPath, png);
	return png;
}

/** Write beside the target, then rename over it; a failure removes the temp
 *  file so a crash never leaves a half image in the cache. The exclusive
 *  open means an existing file or symlink is never followed or truncated. */
async function writePageAtomic(target: string, bytes: Uint8Array): Promise<void> {
	await fsp.mkdir(path.dirname(target), { recursive: true });
	const temp = `${target}.${randomUUID()}.tmp`;
	let created = false;
	try {
		const handle = await fsp.open(temp, "wx");
		created = true;
		try {
			await handle.writeFile(bytes);
		} finally {
			await handle.close();
		}
		await fsp.rename(temp, target);
	} catch (error) {
		// Never mask the write error; a leftover temp is harmless (it is ignored
		// with the rest of ap-papers/) and a path we did not create is left alone.
		if (created) {
			try {
				await fsp.rm(temp, { force: true });
			} catch {
				// report the original failure, not cleanup noise
			}
		}
		throw error;
	}
}