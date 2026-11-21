/**
 * Task 4 — enumerate + transcribe. Fixtures are built in a temp dir per test:
 * PDFs from the tiny-pdf helper, pptx/docx as JSZip archives. Vision is the
 * injected `describe` stub; the renderer is the headlessOverride seam.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import JSZip from "jszip";
import type { walkFiles } from "../src/agent/tools/fs-shared.ts";
import { headlessOverride, type HeadlessApi } from "../src/agent/subagents/headless.ts";
import {
	enumerateFolder,
	transcribeFile,
	type Describe,
	type SweepFile,
} from "../src/agent/subagents/sweep/transcribe.ts";
import { pdfExtract, pdfInfo } from "../src/agent/subagents/pdf-ops.ts";
import { tinyPdf, type Run } from "./helpers/tiny-pdf.ts";

const LONG_TEXT =
	"Photosynthesis converts light energy into chemical energy stored in glucose and releases oxygen as a byproduct " +
	"of the light dependent reactions that happen inside the chloroplast thylakoid membranes of every plant cell. " +
	"Chlorophyll absorbs red and blue wavelengths while reflecting green light back to the observer.";

const ONE_PX_PNG = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63640000000500015e2b4b3f0000000049454e44ae426082",
	"hex",
);

function fakeHeadless(overrides: Partial<HeadlessApi> = {}): HeadlessApi {
	return {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => {
			throw new Error("unused in this test");
		},
		renderSvg: async () => Buffer.alloc(0),
		renderPdfPages: async (_pdfPath, pages) => pages.map((page) => ({ page, png: Buffer.from("fake-png") })),
		...overrides,
	};
}

function sweepFile(abs: string, root: string): SweepFile {
	return {
		rel: path.relative(root, abs).split(path.sep).join("/"),
		abs,
		ext: path.extname(abs).toLowerCase(),
		hash: createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
	};
}

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-transcribe-"));
});
afterEach(() => {
	headlessOverride.current = undefined;
	fs.rmSync(root, { recursive: true, force: true });
});

function make(name: string, bytes: string | Uint8Array | Buffer): string {
	const abs = path.join(root, name);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, bytes);
	return abs;
}

/** pdfjs skips glyphs that start past the page edge, so wrap long text into
 *  short placed lines — the fixture must really exceed 200 chars per page. */
function wrapRuns(text: string): Run[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line && line.length + word.length + 1 > 85) {
			lines.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) lines.push(line);
	return lines.map((text, index) => ({ text, x: 40, y: 700 - index * 18 }));
}

function imageAndTextPdf(): Uint8Array<ArrayBuffer> {
	return tinyPdf([
		{ image: true, runs: wrapRuns("Diagram of a cell") },
		{ runs: wrapRuns(LONG_TEXT) },
	]);
}

interface PptxSlideSpec {
	/** Paragraphs; a string is one run, an array splits one paragraph into runs. */
	paragraphs: Array<string | string[]>;
	notes?: string;
	/** Notes part number to attach; defaults to the slide's own number. */
	notesPart?: number;
	/** Marker bytes for this slide's embedded picture. */
	image?: Buffer;
}

function xmlText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function paragraphsXml(paragraphs: PptxSlideSpec["paragraphs"]): string {
	return paragraphs
		.map((paragraph) => {
			const runs = (Array.isArray(paragraph) ? paragraph : [paragraph])
				.map((run) => `<a:r><a:t>${xmlText(run)}</a:t></a:r>`)
				.join("");
			return `<a:p>${runs}</a:p>`;
		})
		.join("");
}

/** Build a pptx. `listed` controls sldIdLst order/subset; every slide part is
 *  still written, so unreferenced files exercise orderedSlides' append path. */
async function pptxBytes(specs: PptxSlideSpec[], opts: { listed?: number[] } = {}): Promise<Uint8Array> {
	const zip = new JSZip();
	const listed = opts.listed ?? specs.map((_, index) => index + 1);
	zip.file(
		"ppt/presentation.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
		<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
			<p:sldIdLst>${listed
				.map((slide, index) => `<p:sldId id="${255 + index}" r:id="rId${slide}"/>`)
				.join("")}</p:sldIdLst>
		</p:presentation>`,
	);
	zip.file(
		"ppt/_rels/presentation.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
		<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			${specs
				.map(
					(_, index) =>
						`<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
				)
				.join("\n\t\t\t")}
		</Relationships>`,
	);
	for (const [index, spec] of specs.entries()) {
		const slide = index + 1;
		zip.file(
			`ppt/slides/slide${slide}.xml`,
			`<?xml version="1.0" encoding="UTF-8"?>
			<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
				<p:cSld><p:spTree><p:sp><p:txBody>${paragraphsXml(spec.paragraphs)}</p:txBody></p:sp></p:spTree></p:cSld>
			</p:sld>`,
		);
		const rels: string[] = [];
		if (spec.notes !== undefined) {
			rels.push(
				`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${spec.notesPart ?? slide}.xml"/>`,
			);
		}
		if (spec.image) {
			rels.push(
				`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${slide}.png"/>`,
			);
			zip.file(`ppt/media/image${slide}.png`, spec.image);
		}
		if (rels.length) {
			zip.file(
				`ppt/slides/_rels/slide${slide}.xml.rels`,
				`<?xml version="1.0" encoding="UTF-8"?>
				<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
			);
		}
		if (spec.notes !== undefined) {
			zip.file(
				`ppt/notesSlides/notesSlide${spec.notesPart ?? slide}.xml`,
				`<?xml version="1.0" encoding="UTF-8"?>
				<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
					<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xmlText(spec.notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
				</p:notes>`,
			);
		}
	}
	return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

async function docxBytes(imageCount = 1): Promise<Uint8Array> {
	const zip = new JSZip();
	const drawings = Array.from({ length: imageCount }, (_, index) => index + 1)
		.map(
			(n) => `<w:p><w:r><w:drawing>
					<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
						<wp:docPr id="${n}" name="Picture ${n}"/>
						<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
							<pic:pic><pic:blipFill><a:blip r:embed="img${n}"/></pic:blipFill></pic:pic>
						</a:graphicData></a:graphic>
					</wp:inline>
				</w:drawing></w:r></w:p>`,
		)
		.join("");
	const imageRels = Array.from({ length: imageCount }, (_, index) => index + 1)
		.map(
			(n) =>
				`<Relationship Id="img${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${n}.png"/>`,
		)
		.join("");
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8"?>
		<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
			<Default Extension="xml" ContentType="application/xml"/>
			<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
			<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
		</Types>`,
	);
	zip.file(
		"word/document.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
		<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
			xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
			xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
			xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
			<w:body>
				<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
				<w:p><w:r><w:t>Cells are the unit of life.</w:t></w:r></w:p>
				${drawings}
			</w:body>
		</w:document>`,
	);
	zip.file(
		"word/_rels/document.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
		<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
			${imageRels}
		</Relationships>`,
	);
	for (let n = 1; n <= imageCount; n++) zip.file(`word/media/image${n}.png`, ONE_PX_PNG);
	zip.file(
		"word/styles.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
		<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
			<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
		</w:styles>`,
	);
	return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

describe("enumerateFolder", () => {
	it("lists supported files with hashes and unsupported separately", async () => {
		const pdfBytes = tinyPdf([{ runs: wrapRuns(LONG_TEXT) }]);
		make("a.pdf", pdfBytes);
		make("notes.md", "# Notes\n");
		make("sub/ch1.txt", "chapter one");
		make("image.png", ONE_PX_PNG);
		make("data.bin", Buffer.from([0, 1, 2, 3]));

		const { files, unsupported, timedOut } = await enumerateFolder(root);
		assert.deepEqual(
			files.map((f) => f.rel),
			["a.pdf", "image.png", "notes.md", "sub/ch1.txt"],
		);
		assert.deepEqual(unsupported, ["data.bin"]);
		assert.equal(timedOut, false);
		const pdf = files.find((f) => f.rel === "a.pdf")!;
		assert.equal(pdf.ext, ".pdf");
		assert.equal(pdf.abs, path.join(root, "a.pdf"));
		assert.equal(pdf.hash, createHash("sha256").update(pdfBytes).digest("hex"));
		assert.ok(files.every((f) => f.hash.length === 64));
	});

	it("reports a timed-out walk instead of silently listing a partial folder", async () => {
		const pdfBytes = tinyPdf([{ runs: wrapRuns(LONG_TEXT) }]);
		make("a.pdf", pdfBytes);
		const realRoot = fs.realpathSync(root);
		const fakeWalk: typeof walkFiles = async (_dir, visit) => {
			await visit(path.join(realRoot, "a.pdf"));
			return { timedOut: true, aborted: false };
		};

		const result = await enumerateFolder(root, fakeWalk);

		assert.equal(result.timedOut, true);
		assert.deepEqual(result.files.map((f) => f.rel), ["a.pdf"]);
		assert.equal(result.files[0]!.hash, createHash("sha256").update(pdfBytes).digest("hex"));
	});
});

describe("transcribeFile — pdf", () => {
	it("pdf page with an image is described and marked", async () => {
		const pdf = make("book.pdf", imageAndTextPdf());
		const calls: Array<{ images: Array<{ png: Buffer; mime: string }>; hint: string }> = [];
		const rendered: number[] = [];
		headlessOverride.current = fakeHeadless({
			renderPdfPages: async (_p, pages) => {
				rendered.push(...pages);
				return pages.map((page) => ({ page, png: Buffer.from("fake-png") }));
			},
		});
		const describeStub: Describe = async (images, hint) => {
			calls.push({ images, hint });
			return "A labelled cell diagram.";
		};

		const transcript = await transcribeFile(sweepFile(pdf, root), { describe: describeStub });

		assert.equal(calls.length, 1, "only the image page goes to vision");
		assert.equal(calls[0]!.images.length, 1);
		assert.equal(calls[0]!.images[0]!.mime, "image/png");
		assert.match(calls[0]!.hint, /labels|axes|captions/i);
		assert.deepEqual(rendered, [1]);
		assert.match(transcript.markdown, /<!-- source: book\.pdf p\. 1 -->/);
		assert.match(transcript.markdown, /A labelled cell diagram\./);
		assert.match(transcript.markdown, /<!-- source: book\.pdf p\. 2 -->/);
		assert.match(transcript.markdown, /Photosynthesis converts/);
		assert.equal(transcript.pages, 2);
		assert.equal(transcript.visionPages, 1);
		assert.deepEqual(transcript.unreadable, []);
	});

	it("text-only pdf page is not sent to describe", async () => {
		const pdf = make("clean.pdf", tinyPdf([{ runs: wrapRuns(LONG_TEXT) }]));
		let callCount = 0;
		headlessOverride.current = fakeHeadless();
		const describeStub: Describe = async () => {
			callCount++;
			return "should not run";
		};

		const transcript = await transcribeFile(sweepFile(pdf, root), { describe: describeStub });

		assert.equal(callCount, 0);
		assert.equal(transcript.visionPages, 0);
		assert.match(transcript.markdown, /<!-- source: clean\.pdf p\. 1 -->/);
		assert.match(transcript.markdown, /Photosynthesis converts/);
		assert.deepEqual(transcript.unreadable, []);
	});

	it("describe throwing records (vision failed) and keeps text", async () => {
		const pdf = make("diagram.pdf", imageAndTextPdf());
		headlessOverride.current = fakeHeadless();
		const describeStub: Describe = async () => {
			throw new Error("vision model unavailable");
		};

		const transcript = await transcribeFile(sweepFile(pdf, root), { describe: describeStub });

		assert.deepEqual(transcript.unreadable, ["diagram.pdf p. 1 (vision failed)"]);
		assert.equal(transcript.visionPages, 0);
		assert.match(transcript.markdown, /Diagram of a cell/);
		assert.match(transcript.markdown, /Photosynthesis converts/);
	});

	it("renderer failure -> vision page is unreadable but text is kept", async () => {
		const pdf = make("noeyes.pdf", imageAndTextPdf());
		let callCount = 0;
		headlessOverride.current = fakeHeadless({
			renderPdfPages: async () => {
				throw new Error("render engine exploded");
			},
		});
		const describeStub: Describe = async () => {
			callCount++;
			return "should not run";
		};

		const transcript = await transcribeFile(sweepFile(pdf, root), { describe: describeStub });

		assert.equal(callCount, 0);
		assert.deepEqual(transcript.unreadable, ["noeyes.pdf p. 1 (vision failed)"]);
		assert.match(transcript.markdown, /Diagram of a cell/);
		assert.match(transcript.markdown, /Photosynthesis converts/);
		assert.equal(transcript.visionPages, 0);
	});

	it("corrupt pdf -> unreadable with reason, no throw", async () => {
		const pdf = make("bad.pdf", Buffer.from("this is definitely not a pdf"));
		const describeStub: Describe = async () => "unused";

		const transcript = await transcribeFile(sweepFile(pdf, root), { describe: describeStub });

		assert.equal(transcript.markdown, "");
		assert.equal(transcript.unreadable.length, 1);
		assert.match(transcript.unreadable[0]!, /^bad\.pdf \(.+\)$/);
		assert.equal(transcript.pages, 0);
		assert.equal(transcript.visionPages, 0);
	});

	it("parses the whole PDF once, not once per page (I5)", async () => {
		const pdf = make("once.pdf", imageAndTextPdf());
		headlessOverride.current = fakeHeadless();
		const specs: string[] = [];
		const describeStub: Describe = async () => "A labelled diagram.";

		const transcript = await transcribeFile(sweepFile(pdf, root), {
			describe: describeStub,
			pdf: {
				info: pdfInfo,
				extract: async (abs, spec) => {
					specs.push(spec);
					return pdfExtract(abs, spec);
				},
			},
		});

		assert.deepEqual(specs, ["1-2"], "one full-document extraction for the whole file");
		assert.match(transcript.markdown, /<!-- source: once\.pdf p\. 1 -->/);
		assert.match(transcript.markdown, /Diagram of a cell/);
		assert.match(transcript.markdown, /<!-- source: once\.pdf p\. 2 -->/);
		assert.match(transcript.markdown, /Photosynthesis converts/);
		assert.equal(transcript.pages, 2);
	});

	it("renders vision pages in batches of eight (I5)", async () => {
		const pdf = make("many.pdf", tinyPdf(Array.from({ length: 10 }, (_, i) => ({
			image: true,
			runs: wrapRuns(`${LONG_TEXT} page ${i + 1}`),
		}))));
		const batches: number[][] = [];
		headlessOverride.current = fakeHeadless({
			renderPdfPages: async (_p, pages) => {
				batches.push([...pages]);
				return pages.map((page) => ({ page, png: Buffer.from("fake-png") }));
			},
		});
		const describeStub: Describe = async () => "described";

		const transcript = await transcribeFile(sweepFile(pdf, root), { describe: describeStub });

		assert.deepEqual(batches, [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10]], "one render per batch of eight");
		assert.equal(transcript.visionPages, 10);
	});

	it("with no reader, vision pages are marked failed without rendering (I5)", async () => {
		const pdf = make("noreader.pdf", imageAndTextPdf());
		let renders = 0;
		headlessOverride.current = fakeHeadless({
			renderPdfPages: async (_p, pages) => {
				renders++;
				return pages.map((page) => ({ page, png: Buffer.from("fake-png") }));
			},
		});
		let describes = 0;
		const describeStub: Describe = async () => {
			describes++;
			throw new Error("no reader");
		};

		const transcript = await transcribeFile(sweepFile(pdf, root), {
			describe: describeStub,
			hasReader: false,
		});

		assert.equal(renders, 0, "nothing is rendered when nobody can read it");
		assert.equal(describes, 0);
		assert.deepEqual(transcript.unreadable, ["noreader.pdf p. 1 (vision failed)"]);
		assert.match(transcript.markdown, /Diagram of a cell/, "the page's text still transcribes");
	});
});

describe("transcribeFile — office", () => {
	it("pptx slide text, notes and image description land under slide markers", async () => {
		// sldIdLst order is slide 2 then slide 1; notes parts are cross-numbered.
		const pptx = make(
			"deck.pptx",
			await pptxBytes(
				[
					{ paragraphs: ["Cell theory"], notes: "Cell theory speaker note", notesPart: 2 },
					{
						paragraphs: [["Photo", "synthesis"], "Second paragraph"],
						notes: "Mitosis speaker note",
						notesPart: 1,
						image: ONE_PX_PNG,
					},
				],
				{ listed: [2, 1] },
			),
		);
		const calls: Array<{ images: Array<{ png: Buffer; mime: string }>; hint: string }> = [];
		const describeStub: Describe = async (images, hint) => {
			calls.push({ images, hint });
			return "A labelled mitosis diagram.";
		};

		const transcript = await transcribeFile(sweepFile(pptx, root), { describe: describeStub });

		const slide1At = transcript.markdown.indexOf("<!-- source: deck.pptx slide 1 -->");
		const slide2At = transcript.markdown.indexOf("<!-- source: deck.pptx slide 2 -->");
		assert.ok(slide1At >= 0 && slide2At > slide1At, "slide markers in presentation order");
		const first = transcript.markdown.slice(slide1At, slide2At);
		const second = transcript.markdown.slice(slide2At);
		// Displayed slide 1 = slide2.xml, with its cross-numbered notes.
		assert.match(first, /Photosynthesis\nSecond paragraph/, "word runs join; paragraphs break");
		assert.ok(!/Photo\nsynthesis/.test(first), "a word split across runs stays whole");
		assert.match(first, /Mitosis speaker note/);
		assert.match(first, /A labelled mitosis diagram\./);
		// Displayed slide 2 = slide1.xml, with its own notes.
		assert.match(second, /Cell theory/);
		assert.match(second, /Cell theory speaker note/);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.images.length, 1);
		assert.equal(calls[0]!.images[0]!.mime, "image/png");
		assert.equal(transcript.pages, 2);
		assert.equal(transcript.visionPages, 1);
		assert.deepEqual(transcript.unreadable, []);
	});

	it("pptx image descriptions run in a bounded pool and land in slide order", async () => {
		const specs = Array.from({ length: 5 }, (_, index) => ({
			paragraphs: [`Slide ${index + 1}`],
			image: Buffer.from(`image-${index + 1}`),
		}));
		const pptx = make("five.pptx", await pptxBytes(specs));
		let active = 0;
		let maxActive = 0;
		const describeStub: Describe = async (images) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active--;
			return `described ${images[0]!.png.toString()}`;
		};

		const transcript = await transcribeFile(sweepFile(pptx, root), { describe: describeStub });

		assert.equal(maxActive, 4, "bounded concurrency of four");
		for (let slide = 1; slide <= 5; slide++) {
			const start = transcript.markdown.indexOf(`<!-- source: five.pptx slide ${slide} -->`);
			const next = transcript.markdown.indexOf(`<!-- source: five.pptx slide ${slide + 1} -->`);
			const section = transcript.markdown.slice(start, next === -1 ? undefined : next);
			assert.match(section, new RegExp(`described image-${slide}`), `description for slide ${slide}`);
		}
		assert.equal(transcript.visionPages, 5);
		assert.deepEqual(transcript.unreadable, []);
	});

	it("pptx slides missing from sldIdLst are appended in filename order", async () => {
		const pptx = make(
			"partial.pptx",
			await pptxBytes(
				[{ paragraphs: ["One"] }, { paragraphs: ["Two"] }, { paragraphs: ["Three"] }],
				{ listed: [3, 1] },
			),
		);
		const describeStub: Describe = async () => "unused";

		const transcript = await transcribeFile(sweepFile(pptx, root), { describe: describeStub });

		const order = ["Three", "One", "Two"].map((text) =>
			transcript.markdown.indexOf(text),
		);
		assert.ok(order.every((at) => at >= 0), "all slides transcribed");
		assert.deepEqual([...order].sort((a, b) => a - b), order, "listed order then appended file");
		assert.match(transcript.markdown, /<!-- source: partial\.pptx slide 3 -->/);
		assert.equal(transcript.pages, 3);
	});

	it("docx headings become markdown", async () => {
		const docx = make("notes.docx", await docxBytes());
		const calls: Array<{ images: Array<{ png: Buffer; mime: string }>; hint: string }> = [];
		const describeStub: Describe = async (images, hint) => {
			calls.push({ images, hint });
			return "A labelled diagram of a plant cell.";
		};

		const transcript = await transcribeFile(sweepFile(docx, root), { describe: describeStub });

		assert.match(transcript.markdown, /<!-- source: notes\.docx -->/);
		assert.match(transcript.markdown, /^# Chapter One/m);
		assert.match(transcript.markdown, /Cells are the unit of life\./);
		assert.equal(calls.length, 1, "the embedded image is described");
		assert.equal(calls[0]!.images[0]!.mime, "image/png");
		assert.match(transcript.markdown, /A labelled diagram of a plant cell\./);
		assert.equal(transcript.pages, 1);
		assert.equal(transcript.visionPages, 1);
		assert.deepEqual(transcript.unreadable, []);
	});

	it("docx records one (vision failed) entry for multiple failed images", async () => {
		const docx = make("dup.docx", await docxBytes(2));
		const describeStub: Describe = async () => {
			throw new Error("vision down");
		};

		const transcript = await transcribeFile(sweepFile(docx, root), { describe: describeStub });

		assert.deepEqual(transcript.unreadable, ["dup.docx (vision failed)"]);
		assert.match(transcript.markdown, /Cells are the unit of life\./);
		assert.equal(transcript.visionPages, 0);
	});

	it("corrupt pptx -> unreadable with reason, no throw", async () => {
		const bad = make("broken.pptx", Buffer.from("not a zip"));
		const describeStub: Describe = async () => "unused";

		const transcript = await transcribeFile(sweepFile(bad, root), { describe: describeStub });

		assert.equal(transcript.markdown, "");
		assert.equal(transcript.unreadable.length, 1);
		assert.match(transcript.unreadable[0]!, /^broken\.pptx \(.+\)$/);
	});
});

describe("transcribeFile — image and text", () => {
	it("an image file is described once under its file marker", async () => {
		const img = make("cells.png", ONE_PX_PNG);
		const calls: Array<{ images: Array<{ png: Buffer; mime: string }>; hint: string }> = [];
		const describeStub: Describe = async (images, hint) => {
			calls.push({ images, hint });
			return "A microscope photo of onion cells.";
		};

		const transcript = await transcribeFile(sweepFile(img, root), { describe: describeStub });

		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.images[0]!.mime, "image/png");
		assert.match(transcript.markdown, /<!-- source: cells\.png -->/);
		assert.match(transcript.markdown, /A microscope photo of onion cells\./);
		assert.equal(transcript.visionPages, 1);
		assert.deepEqual(transcript.unreadable, []);
	});

	it("a text file is read as-is under its file marker", async () => {
		const txt = make("summary.md", "# Summary\n\nAll living things are made of cells.");
		const describeStub: Describe = async () => "unused";

		const transcript = await transcribeFile(sweepFile(txt, root), { describe: describeStub });

		assert.match(transcript.markdown, /^<!-- source: summary\.md -->/);
		assert.match(transcript.markdown, /All living things are made of cells\./);
		assert.equal(transcript.visionPages, 0);
		assert.deepEqual(transcript.unreadable, []);
	});
});