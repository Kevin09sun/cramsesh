import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { walkFiles } from "../../tools/fs-shared.ts";
import { getHeadless } from "../headless.ts";
import { pdfExtract, pdfInfo, type PdfPageInfo } from "../pdf-ops.ts";
import { docxContent, mimeForImage, pptxSlides } from "./office.ts";

/**
 * Test-material sweep, stage 1 (Task 4): enumerate a learner's materials
 * folder and transcribe every supported file to Markdown carrying
 * `<!-- source: … -->` markers. Vision descriptions come from the injected
 * `describe` callback (wired to the vision model by a later task), so this
 * module holds no model call of its own.
 *
 * Failures never escape `transcribeFile` except on abort: a whole file that
 * cannot be read becomes one `unreadable` entry with a reason, and a failed
 * vision call records `(vision failed)` while keeping the page's text.
 */

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export const SWEEP_EXTENSIONS: ReadonlySet<string> = new Set([
	".pdf",
	".pptx",
	".docx",
	...TEXT_EXTENSIONS,
	...IMAGE_EXTENSIONS,
]);

export interface SweepFile {
	rel: string;
	abs: string;
	ext: string;
	hash: string;
}

export type Describe = (
	images: Array<{ png: Buffer; mime: string }>,
	hint: string,
) => Promise<string>;

export interface Transcript {
	rel: string;
	markdown: string;
	pages: number;
	visionPages: number;
	unreadable: string[];
}

export interface TranscribeDeps {
	describe: Describe;
	signal?: AbortSignal;
	onActivity?: (line: string) => void;
}

/** Exact routing rule: a page also goes to vision when it has any image,
 *  is math-heavy, or carries too little text to stand on its own. */
export function needsVision(page: PdfPageInfo): boolean {
	return page.image_count > 0 || page.math_density >= 0.15 || page.text_length < 200;
}

const VISION_HINT =
	"Describe this material faithfully: figures, diagrams, tables and pictures — " +
	"include labels, axes, captions and values, and keep the reading order. " +
	"If it is a scanned page, transcribe the text instead of summarizing it.";

const DPI = 150;
const CONCURRENCY = 4;

function marker(rel: string, unit?: string): string {
	return unit ? `<!-- source: ${rel} ${unit} -->` : `<!-- source: ${rel} -->`;
}

function reasonOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const flat = message.replace(/\s+/g, " ").trim();
	if (!flat) return "unknown error";
	return flat.length > 200 ? `${flat.slice(0, 197)}…` : flat;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
}

function failed(file: SweepFile, error: unknown, signal?: AbortSignal): Transcript {
	if (signal?.aborted) throw error;
	return {
		rel: file.rel,
		markdown: "",
		pages: 0,
		visionPages: 0,
		unreadable: [`${file.rel} (${reasonOf(error)})`],
	};
}

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** pdfExtract prefixes each page with `--- Page N ---`; the sweep's own
 *  marker already names the page. */
function stripPageHeader(text: string, page: number): string {
	const prefix = `--- Page ${page} ---\n`;
	return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

async function transcribePdf(file: SweepFile, deps: TranscribeDeps): Promise<Transcript> {
	const unreadable: string[] = [];
	try {
		const info = await pdfInfo(file.abs);
		throwIfAborted(deps.signal);
		const descriptions = new Map<number, string>();
		const visionTargets = info.pages.filter(needsVision);
		if (visionTargets.length) {
			// renderPdfPages is native (pdfjs + Skia) — no browser gate. A
			// render failure is the same per-page outcome as a describe failure.
			const outcomes = await mapLimit(visionTargets, CONCURRENCY, async (page) => {
				throwIfAborted(deps.signal);
				try {
					const rendered = await getHeadless().renderPdfPages(file.abs, [page.page], { dpi: DPI });
					const png = rendered.find((r) => r.page === page.page)?.png;
					if (!png) throw new Error("renderer returned no image");
					deps.onActivity?.(`Describing ${file.rel} — page ${page.page}/${info.page_count}`);
					return { page: page.page, description: await deps.describe([{ png, mime: "image/png" }], VISION_HINT) };
				} catch (error) {
					if (deps.signal?.aborted) throw error;
					return { page: page.page, description: null };
				}
			});
			for (const outcome of outcomes) {
				if (outcome.description === null) unreadable.push(`${file.rel} p. ${outcome.page} (vision failed)`);
				else descriptions.set(outcome.page, outcome.description);
			}
		}

		const sections: string[] = [];
		for (const page of info.pages) {
			throwIfAborted(deps.signal);
			deps.onActivity?.(`Reading ${file.rel} — page ${page.page}/${info.page_count}`);
			const text = stripPageHeader(await pdfExtract(file.abs, String(page.page)), page.page).trim();
			const parts = [marker(file.rel, `p. ${page.page}`)];
			if (text) parts.push(text);
			const description = descriptions.get(page.page);
			if (description) parts.push(description);
			sections.push(parts.join("\n\n"));
		}

		return {
			rel: file.rel,
			markdown: sections.join("\n\n"),
			pages: info.page_count,
			visionPages: descriptions.size,
			unreadable,
		};
	} catch (error) {
		return failed(file, error, deps.signal);
	}
}

async function transcribePptx(file: SweepFile, deps: TranscribeDeps): Promise<Transcript> {
	const unreadable: string[] = [];
	try {
		const slides = await pptxSlides(await fs.readFile(file.abs));
		const descriptions = new Map<number, string>();
		const imageSlides = slides.filter((slide) => slide.images.length > 0);
		// Same bounded pool as PDF pages; assembly below keeps slide order.
		const outcomes = await mapLimit(imageSlides, CONCURRENCY, async (slide) => {
			throwIfAborted(deps.signal);
			deps.onActivity?.(`Describing ${file.rel} — slide ${slide.slide}/${slides.length}`);
			try {
				return {
					slide: slide.slide,
					description: await deps.describe(
						slide.images.map((image) => ({ png: image.data, mime: image.mime })),
						VISION_HINT,
					),
				};
			} catch (error) {
				if (deps.signal?.aborted) throw error;
				return { slide: slide.slide, description: null };
			}
		});
		for (const outcome of outcomes) {
			if (outcome.description === null) unreadable.push(`${file.rel} slide ${outcome.slide} (vision failed)`);
			else descriptions.set(outcome.slide, outcome.description);
		}

		const sections: string[] = [];
		for (const slide of slides) {
			throwIfAborted(deps.signal);
			deps.onActivity?.(`Reading ${file.rel} — slide ${slide.slide}/${slides.length}`);
			const parts = [marker(file.rel, `slide ${slide.slide}`)];
			if (slide.text) parts.push(slide.text);
			if (slide.notes) parts.push(`Speaker notes: ${slide.notes}`);
			const description = descriptions.get(slide.slide);
			if (description) parts.push(description);
			sections.push(parts.join("\n\n"));
		}
		const describedSlides = descriptions.size;
		return {
			rel: file.rel,
			markdown: sections.join("\n\n"),
			pages: slides.length,
			visionPages: describedSlides,
			unreadable,
		};
	} catch (error) {
		return failed(file, error, deps.signal);
	}
}

async function transcribeDocx(file: SweepFile, deps: TranscribeDeps): Promise<Transcript> {
	const unreadable: string[] = [];
	try {
		const content = await docxContent(await fs.readFile(file.abs));
		const parts = [marker(file.rel)];
		if (content.markdown) parts.push(content.markdown);
		let described = 0;
		for (const image of content.images) {
			throwIfAborted(deps.signal);
			try {
				const description = await deps.describe([{ png: image.data, mime: image.mime }], VISION_HINT);
				parts.push(`${marker(file.rel)}\n\n${description}`);
				described++;
			} catch (error) {
				if (deps.signal?.aborted) throw error;
				const entry = `${file.rel} (vision failed)`;
				if (!unreadable.includes(entry)) unreadable.push(entry);
			}
		}
		return {
			rel: file.rel,
			markdown: parts.join("\n\n"),
			pages: 1,
			visionPages: described > 0 ? 1 : 0,
			unreadable,
		};
	} catch (error) {
		return failed(file, error, deps.signal);
	}
}

async function transcribeImage(file: SweepFile, deps: TranscribeDeps): Promise<Transcript> {
	try {
		const data = await fs.readFile(file.abs);
		try {
			const description = await deps.describe([{ png: data, mime: mimeForImage(file.abs) }], VISION_HINT);
			return {
				rel: file.rel,
				markdown: `${marker(file.rel)}\n\n${description}`,
				pages: 1,
				visionPages: 1,
				unreadable: [],
			};
		} catch (error) {
			if (deps.signal?.aborted) throw error;
			return {
				rel: file.rel,
				markdown: marker(file.rel),
				pages: 1,
				visionPages: 0,
				unreadable: [`${file.rel} (vision failed)`],
			};
		}
	} catch (error) {
		return failed(file, error, deps.signal);
	}
}

async function transcribeText(file: SweepFile): Promise<Transcript> {
	try {
		const text = (await fs.readFile(file.abs, "utf8")).trim();
		return {
			rel: file.rel,
			markdown: text ? `${marker(file.rel)}\n\n${text}` : marker(file.rel),
			pages: 1,
			visionPages: 0,
			unreadable: [],
		};
	} catch (error) {
		return failed(file, error);
	}
}

export async function transcribeFile(file: SweepFile, deps: TranscribeDeps): Promise<Transcript> {
	throwIfAborted(deps.signal);
	switch (file.ext.toLowerCase()) {
		case ".pdf":
			return transcribePdf(file, deps);
		case ".pptx":
			return transcribePptx(file, deps);
		case ".docx":
			return transcribeDocx(file, deps);
		default:
			if (IMAGE_EXTENSIONS.has(file.ext.toLowerCase())) return transcribeImage(file, deps);
			if (TEXT_EXTENSIONS.has(file.ext.toLowerCase())) return transcribeText(file);
			return {
				rel: file.rel,
				markdown: "",
				pages: 0,
				visionPages: 0,
				unreadable: [`${file.rel} (unsupported type)`],
			};
	}
}

/** Walk budget for a materials folder — generous because OneDrive trees can
 *  be deep. Hashing happens only after the walk, so it cannot eat this. */
const WALK_BUDGET_MS = 120_000;

type EnumerateWalk = typeof walkFiles;

export async function enumerateFolder(
	folder: string,
	walk: EnumerateWalk = walkFiles,
): Promise<{ files: SweepFile[]; unsupported: string[]; timedOut: boolean }> {
	const resolved = path.resolve(folder);
	let root = resolved;
	try {
		root = await fs.realpath(resolved);
	} catch {
		// Missing/unreadable folder: walkFiles yields nothing anyway.
	}
	const supported: Array<{ rel: string; abs: string; ext: string }> = [];
	const unsupported: string[] = [];
	const { timedOut } = await walk(
		root,
		(abs) => {
			const rel = path.relative(root, abs).split(path.sep).join("/");
			const ext = path.extname(abs).toLowerCase();
			if (SWEEP_EXTENSIONS.has(ext)) supported.push({ rel, abs, ext });
			else unsupported.push(rel);
			return false;
		},
		undefined,
		{ deadline: Date.now() + WALK_BUDGET_MS },
	);
	// Hash after the walk: a partial list from a timed-out walk is still
	// listed and flagged, never silently reported as complete.
	const files: SweepFile[] = [];
	for (const entry of supported) {
		const bytes = await fs.readFile(entry.abs);
		files.push({ ...entry, hash: createHash("sha256").update(bytes).digest("hex") });
	}
	files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	unsupported.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return { files, unsupported, timedOut };
}