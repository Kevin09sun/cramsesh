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
import { headlessOverride, type HeadlessApi } from "../src/agent/subagents/headless.ts";
import {
	enumerateFolder,
	transcribeFile,
	type Describe,
	type SweepFile,
} from "../src/agent/subagents/sweep/transcribe.ts";
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

async function pptxBytes(): Promise<Uint8Array> {
	const zip = new JSZip();
	zip.file(
		"ppt/presentation.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
		<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
			<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
		</p:presentation>`,
	);
	zip.file(
		"ppt/_rels/presentation.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
		<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
			<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
		</Relationships>`,
	);
	zip.file(
		"ppt/slides/slide1.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
		<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
			<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Cell theory</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
		</p:sld>`,
	);
	zip.file(
		"ppt/slides/_rels/slide1.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
		<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
		</Relationships>`,
	);
	zip.file(
		"ppt/notesSlides/notesSlide1.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
		<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
			<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Remember: cells arise from cells.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
		</p:notes>`,
	);
	zip.file(
		"ppt/slides/slide2.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
		<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
			<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Mitosis stages</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
		</p:sld>`,
	);
	zip.file(
		"ppt/slides/_rels/slide2.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
		<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
		</Relationships>`,
	);
	zip.file("ppt/media/image1.png", ONE_PX_PNG);
	return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

async function docxBytes(): Promise<Uint8Array> {
	const zip = new JSZip();
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
				<w:p><w:r><w:drawing>
					<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
						<wp:docPr id="1" name="Picture 1"/>
						<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
							<pic:pic><pic:blipFill><a:blip r:embed="rId2"/></pic:blipFill></pic:pic>
						</a:graphicData></a:graphic>
					</wp:inline>
				</w:drawing></w:r></w:p>
			</w:body>
		</w:document>`,
	);
	zip.file(
		"word/_rels/document.xml.rels",
		`<?xml version="1.0" encoding="UTF-8"?>
		<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
			<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
		</Relationships>`,
	);
	zip.file("word/media/image1.png", ONE_PX_PNG);
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

		const { files, unsupported } = await enumerateFolder(root);
		assert.deepEqual(
			files.map((f) => f.rel),
			["a.pdf", "image.png", "notes.md", "sub/ch1.txt"],
		);
		assert.deepEqual(unsupported, ["data.bin"]);
		const pdf = files.find((f) => f.rel === "a.pdf")!;
		assert.equal(pdf.ext, ".pdf");
		assert.equal(pdf.abs, path.join(root, "a.pdf"));
		assert.equal(pdf.hash, createHash("sha256").update(pdfBytes).digest("hex"));
		assert.ok(files.every((f) => f.hash.length === 64));
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
});

describe("transcribeFile — office", () => {
	it("pptx slide text, notes and image description land under slide markers", async () => {
		const pptx = make("deck.pptx", await pptxBytes());
		const calls: Array<{ images: Array<{ png: Buffer; mime: string }>; hint: string }> = [];
		const describeStub: Describe = async (images, hint) => {
			calls.push({ images, hint });
			return "A labelled mitosis diagram.";
		};

		const transcript = await transcribeFile(sweepFile(pptx, root), { describe: describeStub });

		assert.match(transcript.markdown, /<!-- source: deck\.pptx slide 1 -->/);
		assert.match(transcript.markdown, /Cell theory/);
		assert.match(transcript.markdown, /Remember: cells arise from cells\./);
		assert.match(transcript.markdown, /<!-- source: deck\.pptx slide 2 -->/);
		assert.match(transcript.markdown, /Mitosis stages/);
		const slide2At = transcript.markdown.indexOf("<!-- source: deck.pptx slide 2 -->");
		const descriptionAt = transcript.markdown.indexOf("A labelled mitosis diagram.");
		assert.ok(descriptionAt > slide2At, "description lands under slide 2");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.images.length, 1);
		assert.equal(calls[0]!.images[0]!.mime, "image/png");
		assert.equal(transcript.pages, 2);
		assert.equal(transcript.visionPages, 1);
		assert.deepEqual(transcript.unreadable, []);
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