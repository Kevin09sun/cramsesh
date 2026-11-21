import * as path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import TurndownService from "turndown";

/**
 * Office-file plumbing for the test-material sweep (Task 4).
 *
 * Both formats are ZIP + XML. PowerPoint gets a small hand parser (slide
 * order from presentation.xml, text from `a:t` runs, notes and embedded
 * images from the slide relationships); Word goes through mammoth, whose
 * HTML is converted to Markdown with turndown (already a dependency).
 * No external install — nothing here shells out.
 */

export interface OfficeImage {
	data: Buffer;
	mime: string;
}

export interface PptxSlide {
	slide: number;
	text: string;
	notes: string;
	images: OfficeImage[];
}

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	emf: "image/x-emf",
	wmf: "image/x-wmf",
};

/** MIME for a media part by extension; unknown parts stay honest. */
export function mimeForImage(name: string): string {
	return IMAGE_MIME[path.extname(name).toLowerCase().slice(1)] ?? "application/octet-stream";
}

function attr(tag: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
	return match?.[1];
}

function decodeXml(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** DrawingML text runs. Runs are one paragraph-ish unit each; newline keeps
 *  them readable without inventing word spacing. */
function drawingText(xml: string): string {
	const runs: string[] = [];
	for (const match of xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
		runs.push(decodeXml(match[1]!));
	}
	return runs.join("\n").trim();
}

async function readPart(zip: JSZip, name: string): Promise<string> {
	const file = zip.file(name);
	return file ? file.async("string") : "";
}

/** OOXML relationship targets are relative to the part's directory; some
 *  producers write absolute part names. Always forward slashes. */
function resolvePart(baseDir: string, target: string): string {
	const clean = target.replace(/\\/g, "/");
	if (clean.startsWith("/")) return clean.slice(1);
	return path.posix.normalize(path.posix.join(baseDir, clean));
}

function slideNumber(name: string): number {
	const match = /slide(\d+)\.xml$/.exec(name);
	return match ? Number(match[1]) : 0;
}

function slideRelsPath(slidePath: string): string {
	return `ppt/slides/_rels/${path.posix.basename(slidePath)}.rels`;
}

/** Presentation-order slide parts: presentation.xml's sldIdLst resolved
 *  through its relationship map. Fallback: slideN.xml ascending. */
async function orderedSlides(zip: JSZip): Promise<string[]> {
	const presentation = await readPart(zip, "ppt/presentation.xml");
	const rels = await readPart(zip, "ppt/_rels/presentation.xml.rels");
	const relMap = new Map<string, string>();
	for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
		const id = attr(match[0]!, "Id");
		const target = attr(match[0]!, "Target");
		if (id && target) relMap.set(id, resolvePart("ppt", target));
	}
	const order: string[] = [];
	const list = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(presentation)?.[1] ?? "";
	for (const match of list.matchAll(/<p:sldId\b[^>]*>/g)) {
		const rid = attr(match[0]!, "r:id");
		const target = rid ? relMap.get(rid) : undefined;
		if (target && zip.file(target)) order.push(target);
	}
	if (order.length) return order;
	return Object.keys(zip.files)
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((a, b) => slideNumber(a) - slideNumber(b));
}

async function notesFor(zip: JSZip, slidePath: string): Promise<string> {
	const rels = await readPart(zip, slideRelsPath(slidePath));
	let notesPath: string | undefined;
	for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
		const type = attr(match[0]!, "Type") ?? "";
		const target = attr(match[0]!, "Target");
		if (type.endsWith("/notesSlide") && target) {
			notesPath = resolvePart(path.posix.dirname(slidePath), target);
		}
	}
	notesPath ??= `ppt/notesSlides/notesSlide${slideNumber(slidePath)}.xml`;
	return drawingText(await readPart(zip, notesPath));
}

async function imagesFor(zip: JSZip, slidePath: string): Promise<OfficeImage[]> {
	const rels = await readPart(zip, slideRelsPath(slidePath));
	const images: OfficeImage[] = [];
	for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
		const type = attr(match[0]!, "Type") ?? "";
		const target = attr(match[0]!, "Target");
		if (!target || !type.endsWith("/image")) continue;
		const part = resolvePart(path.posix.dirname(slidePath), target);
		const data = await zip.file(part)?.async("nodebuffer");
		if (data) images.push({ data, mime: mimeForImage(part) });
	}
	return images;
}

export async function pptxSlides(bytes: Uint8Array): Promise<PptxSlide[]> {
	const zip = await JSZip.loadAsync(bytes);
	const slides: PptxSlide[] = [];
	for (const [index, slidePath] of (await orderedSlides(zip)).entries()) {
		slides.push({
			slide: index + 1,
			text: drawingText(await readPart(zip, slidePath)),
			notes: await notesFor(zip, slidePath),
			images: await imagesFor(zip, slidePath),
		});
	}
	return slides;
}

export async function docxContent(bytes: Uint8Array): Promise<{ markdown: string; images: OfficeImage[] }> {
	const images: OfficeImage[] = [];
	const converted = await mammoth.convertToHtml(
		{ buffer: Buffer.from(bytes) },
		{
			convertImage: mammoth.images.imgElement(async (image) => {
				images.push({ data: await image.readAsBuffer(), mime: image.contentType });
				return { src: "" };
			}),
		},
	);
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	return { markdown: turndown.turndown(converted.value).trim(), images };
}