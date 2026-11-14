/**
 * AP PAGE IMAGES AND THE QUESTION DISPLAY ROUTE (AP prep stage 2, 2026-11-14).
 *
 * A stored paper's original pages are rendered once through the headless
 * seam and cached under data/ap-papers/<courseId>/pages/ — local only, like
 * the PDFs themselves. Tests inject a fake renderer, so nothing here paints a
 * real PDF: the first call renders and writes the cache, the second is served
 * from it.
 *
 * GET /api/ap/[id]/pages/[file]/[page] serves an image/png only for a file
 * the course manifest holds as an frq or ced document — never a scoring
 * guideline — and answers 404 for an unknown course, an unknown document, an
 * absent paper or an invalid page. GET /api/ap/[id]/questions/[qid] is the
 * display projection: id, title, paper file, pages, presence and the parts'
 * topics — never a rubric point, a point id or a scoring page.
 *
 * Runs under an isolated LH_DATA_DIR, set before any config-loading import
 * (the test-prep-store discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-pages-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { AP_PAGE_DPI, apPageImage, clearApPageCache, setApPageRenderer } = await import("../src/server/ap-pages.ts");
const { apPaperPath, apPapersDir, downloadApPaper, setApPaperFetch } = await import("../src/server/ap-papers.ts");
const { apCourseStore } = await import("../src/store/ap-courses.ts");
const { apIndexStore } = await import("../src/store/ap-index.ts");

type PagesRoute = typeof import("../app/api/ap/[id]/pages/[file]/[page]/route.ts");
type QuestionsRoute = typeof import("../app/api/ap/[id]/questions/[qid]/route.ts");
let pagesRoute: PagesRoute;
let questionsRoute: QuestionsRoute;
before(async () => {
	pagesRoute = await import("../app/api/ap/[id]/pages/[file]/[page]/route.ts");
	questionsRoute = await import("../app/api/ap/[id]/questions/[qid]/route.ts");
});
after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

type ApDocument = import("../src/core/ap.ts").ApDocument;
type ApRealQuestion = import("../src/core/ap-frq.ts").ApRealQuestion;

const BASE = "http://localhost";
const PDF = "%PDF-1.7\n% test paper\n";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from("fake-png-bytes")]);
const KNOWN_POINT_TEXT = "KNOWN RUBRIC POINT TEXT";

/** Put a real PDF where the store will look for one. */
function writePaper(courseId: string, file: string): void {
	const target = apPaperPath(courseId, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, PDF);
}

/** Put one document in a fresh course's manifest; returns the course id. */
function courseWithDocument(title: string, kind: ApDocument["kind"], file: string): string {
	const course = apCourseStore.create(title);
	apCourseStore.putDocument(course.id, {
		id: file.replace(/\.pdf$/, ""),
		kind,
		label: file,
		url: "",
		file,
	});
	return course.id;
}

function pageCachePath(courseId: string, file: string, page: number): string {
	return path.join(apPapersDir(courseId), "pages", `${file.replace(/\.pdf$/, "")}-p${page}.png`);
}

function getPage(id: string, file: string, page: string): Promise<Response> {
	return pagesRoute.GET(new Request(`${BASE}/api/ap/${id}/pages/${file}/${page}`), {
		params: Promise.resolve({ id, file, page }),
	});
}

function getQuestion(id: string, qid: string): Promise<Response> {
	return questionsRoute.GET(new Request(`${BASE}/api/ap/${id}/questions/${qid}`), {
		params: Promise.resolve({ id, qid }),
	});
}

function question(topicId: string): ApRealQuestion {
	return {
		id: "2023-2",
		paperId: "frq-2023",
		scoringId: "scoring-2023",
		year: 2023,
		number: 2,
		pages: [2, 3],
		scoringPages: [7],
		parts: [
			{ label: "a", topicId, points: [{ id: "a1", text: KNOWN_POINT_TEXT }] },
			{ label: "b", points: [{ id: "b1", text: "a second secret point" }] },
			{ label: "c", topicId: "topic_gone", points: [{ id: "c1", text: "a third secret point" }] },
		],
	};
}

describe("apPageImage", () => {
	it("renders a page once at AP_PAGE_DPI and serves the cached bytes after that", async () => {
		const courseId = courseWithDocument("AP Page cache", "frq", "frq-2023.pdf");
		writePaper(courseId, "frq-2023.pdf");

		const calls: Array<{ pdfPath: string; page: number; dpi: number }> = [];
		setApPageRenderer(async (pdfPath, page, dpi) => {
			calls.push({ pdfPath, page, dpi });
			return PNG;
		});

		assert.equal(AP_PAGE_DPI, 150);
		const first = await apPageImage(courseId, "frq-2023.pdf", 1);
		assert.deepEqual(first, PNG);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { pdfPath: apPaperPath(courseId, "frq-2023.pdf"), page: 1, dpi: 150 });

		const cached = pageCachePath(courseId, "frq-2023.pdf", 1);
		assert.ok(fs.existsSync(cached), "the rendered page is cached");
		assert.deepEqual(fs.readFileSync(cached), PNG);
		assert.ok(
			cached.startsWith(path.join(apPapersDir(courseId), "pages")),
			"the cache lives in the course's pages folder under ap-papers/",
		);

		const second = await apPageImage(courseId, "frq-2023.pdf", 1);
		assert.deepEqual(second, PNG);
		assert.equal(calls.length, 1, "the second call is served from the cache");
	});

	it("throws paper not on this computer without rendering when the PDF is absent", async () => {
		const courseId = courseWithDocument("AP Page absent", "frq", "frq-2023.pdf");
		let calls = 0;
		setApPageRenderer(async () => {
			calls++;
			return PNG;
		});

		await assert.rejects(
			apPageImage(courseId, "frq-2023.pdf", 1),
			(error: Error) => error.message === "paper not on this computer",
		);
		assert.equal(calls, 0, "an absent paper is never rendered");
	});

	it("throws no such page for an out-of-range page and for a page that is not a positive integer", async () => {
		const courseId = courseWithDocument("AP Page bad", "frq", "frq-2023.pdf");
		writePaper(courseId, "frq-2023.pdf");
		setApPageRenderer(async () => undefined as unknown as Buffer);

		await assert.rejects(
			apPageImage(courseId, "frq-2023.pdf", 99),
			(error: Error) => error.message === "no such page",
		);
		for (const page of [0, -1, 1.5]) {
			await assert.rejects(
				apPageImage(courseId, "frq-2023.pdf", page),
				(error: Error) => error.message === "no such page",
			);
		}
	});

	it("treats an empty or non-PNG cache file as a miss and re-renders", async () => {
		const courseId = courseWithDocument("AP Page corrupt", "frq", "frq-2023.pdf");
		writePaper(courseId, "frq-2023.pdf");
		let calls = 0;
		setApPageRenderer(async () => {
			calls++;
			return PNG;
		});

		const cached = pageCachePath(courseId, "frq-2023.pdf", 1);
		fs.mkdirSync(path.dirname(cached), { recursive: true });

		fs.writeFileSync(cached, "");
		assert.deepEqual(await apPageImage(courseId, "frq-2023.pdf", 1), PNG);
		assert.equal(calls, 1, "an empty cache file is a miss");
		assert.deepEqual(fs.readFileSync(cached), PNG, "the miss is overwritten");

		fs.writeFileSync(cached, "not a png");
		assert.deepEqual(await apPageImage(courseId, "frq-2023.pdf", 1), PNG);
		assert.equal(calls, 2, "a file without the PNG signature is a miss");
		assert.deepEqual(fs.readFileSync(cached), PNG, "the garbage is overwritten");
	});

	it("clearApPageCache tolerates a missing folder and never touches another paper's pages", async () => {
		const courseId = courseWithDocument("AP Page clear", "frq", "frq-2023.pdf");
		await clearApPageCache(courseId, "frq-2023.pdf"); // no pages folder yet: no throw

		writePaper(courseId, "frq-2023.pdf");
		writePaper(courseId, "frq-2023-set2.pdf");
		setApPageRenderer(async () => PNG);
		await apPageImage(courseId, "frq-2023.pdf", 1);
		await apPageImage(courseId, "frq-2023-set2.pdf", 1);

		await clearApPageCache(courseId, "frq-2023.pdf");
		assert.equal(fs.existsSync(pageCachePath(courseId, "frq-2023.pdf", 1)), false);
		assert.equal(fs.existsSync(pageCachePath(courseId, "frq-2023-set2.pdf", 1)), true);
	});

	it("validates the course id and file name through the paper store", async () => {
		await assert.rejects(apPageImage("../course", "frq-2023.pdf", 1), /Invalid course id/);
		await assert.rejects(apPageImage("course-safe", "../x.pdf", 1), /Invalid paper file/);
	});
});

describe("paper re-save clears the page cache", () => {
	it("a re-downloaded paper loses its cached pages but another paper keeps its own", async () => {
		const courseId = courseWithDocument("AP Page resave", "frq", "frq-2023.pdf");
		writePaper(courseId, "frq-2023.pdf");
		writePaper(courseId, "frq-2023-set2.pdf");
		setApPageRenderer(async () => PNG);
		await apPageImage(courseId, "frq-2023.pdf", 1);
		await apPageImage(courseId, "frq-2023.pdf", 2);
		await apPageImage(courseId, "frq-2023-set2.pdf", 1);

		const own = [1, 2].map((page) => pageCachePath(courseId, "frq-2023.pdf", page));
		const other = pageCachePath(courseId, "frq-2023-set2.pdf", 1);
		assert.ok(own.every((file) => fs.existsSync(file)), "both pages were cached first");

		setApPaperFetch((async () => new Response(PDF)) as typeof fetch);
		await downloadApPaper(courseId, "https://www.collegeboard.org/frq-2023.pdf", "frq-2023.pdf");

		assert.equal(own.some((file) => fs.existsSync(file)), false, "the re-saved paper's pages are gone");
		assert.equal(fs.existsSync(other), true, "another paper's pages survive");
	});

	it("a refused re-download leaves the cache untouched", async () => {
		const courseId = courseWithDocument("AP Page failed resave", "frq", "frq-2023.pdf");
		writePaper(courseId, "frq-2023.pdf");
		setApPageRenderer(async () => PNG);
		await apPageImage(courseId, "frq-2023.pdf", 1);
		const cached = pageCachePath(courseId, "frq-2023.pdf", 1);
		const before = fs.readFileSync(cached);

		setApPaperFetch((async () => new Response("<html>not a paper</html>")) as typeof fetch);
		await assert.rejects(
			downloadApPaper(courseId, "https://www.collegeboard.org/frq-2023.pdf", "frq-2023.pdf"),
			(error: Error) => error.message === "Not a PDF",
		);
		assert.deepEqual(fs.readFileSync(cached), before, "a failed save never clears the old paper's pages");
	});
});

describe("GET /api/ap/[id]/pages/[file]/[page]", () => {
	it("serves a rendered page as a no-cache PNG for an frq or ced document", async () => {
		const frqCourse = courseWithDocument("AP Pages frq", "frq", "frq-2023.pdf");
		writePaper(frqCourse, "frq-2023.pdf");
		const cedCourse = courseWithDocument("AP Pages ced", "ced", "ced.pdf");
		writePaper(cedCourse, "ced.pdf");
		setApPageRenderer(async () => PNG);

		const res = await getPage(frqCourse, "frq-2023.pdf", "2");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "image/png");
		assert.equal(res.headers.get("cache-control"), "private, no-cache");
		assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);

		const ced = await getPage(cedCourse, "ced.pdf", "1");
		assert.equal(ced.status, 200, "a ced document is shown too");
	});

	it("is a 404 for an unknown course, a file not among the documents, an absent paper and an invalid page", async () => {
		setApPageRenderer(async () => PNG);

		assert.equal((await getPage("ap_never_existed", "frq-2023.pdf", "1")).status, 404);

		const courseId = courseWithDocument("AP Pages missing", "frq", "frq-2023.pdf");
		assert.equal((await getPage(courseId, "frq-2023.pdf", "1")).status, 404, "the paper is absent");

		writePaper(courseId, "frq-2023.pdf");
		assert.equal((await getPage(courseId, "other.pdf", "1")).status, 404, "the file is not in the manifest");

		for (const page of ["0", "-1", "abc", "1.5"]) {
			assert.equal((await getPage(courseId, "frq-2023.pdf", page)).status, 404, `page ${page} is invalid`);
		}
	});

	it("never serves a scoring guideline, even when it is on this computer", async () => {
		const courseId = courseWithDocument("AP Pages scoring", "scoring", "scoring-2023.pdf");
		writePaper(courseId, "scoring-2023.pdf");
		let calls = 0;
		setApPageRenderer(async () => {
			calls++;
			return PNG;
		});

		const res = await getPage(courseId, "scoring-2023.pdf", "1");
		assert.equal(res.status, 404);
		assert.equal(calls, 0, "a scoring page is never rendered");
	});

	it("is a 404 with no render for hostile or malformed segments", async () => {
		const courseId = courseWithDocument("AP Pages segments", "frq", "frq-2023.pdf");
		writePaper(courseId, "frq-2023.pdf");
		let calls = 0;
		setApPageRenderer(async () => {
			calls++;
			return PNG;
		});

		for (const page of ["1e3", "123456789012345678901234567890"]) {
			assert.equal((await getPage(courseId, "frq-2023.pdf", page)).status, 404, `page ${page} is invalid`);
		}
		for (const file of ["..", "%2e%2e%2fced.pdf", "ced.pdf"]) {
			assert.equal((await getPage(courseId, file, "1")).status, 404, `file ${file} is not servable`);
		}
		assert.equal(calls, 0, "nothing is rendered");
	});

	it("answers 500 and logs when rendering fails unexpectedly", async () => {
		const courseId = courseWithDocument("AP Pages error", "frq", "frq-2023.pdf");
		writePaper(courseId, "frq-2023.pdf");
		setApPageRenderer(async () => {
			throw new Error("paint exploded");
		});

		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			const res = await getPage(courseId, "frq-2023.pdf", "1");
			assert.equal(res.status, 500);
			assert.deepEqual(await res.json(), { error: "Could not render the page" });
			assert.equal(logged.length, 1, "the failure is logged");
		} finally {
			console.error = original;
		}
	});
});

describe("GET /api/ap/[id]/questions/[qid]", () => {
	it("projects the question for display without any rubric text or scoring page", async () => {
		const course = apCourseStore.create("AP Questions");
		apCourseStore.putDocument(course.id, {
			id: "frq-2023",
			kind: "frq",
			label: "2023 FRQ",
			url: "",
			file: "frq-2023.pdf",
		});
		const saved = apCourseStore.savePlan(
			course.id,
			[{ title: "Unit 1", points: [{ text: "Limits", source: "ced.pdf" }] }],
			true,
		);
		const topicId = saved.sections[0]!.points[0]!.id;
		apIndexStore.putPaper(course.id, "frq-2023", [question(topicId)]);
		writePaper(course.id, "frq-2023.pdf");

		const res = await getQuestion(course.id, "2023-2");
		assert.equal(res.status, 200);
		const body = (await res.json()) as Record<string, unknown>;
		assert.deepEqual(body, {
			id: "2023-2",
			title: "2023 FRQ 2",
			file: "frq-2023.pdf",
			pages: [2, 3],
			present: true,
			parts: [
				{ label: "a", topicId, topicText: "Limits" },
				{ label: "b" },
				{ label: "c" },
			],
		});

		const text = JSON.stringify(body);
		assert.equal(text.includes(KNOWN_POINT_TEXT), false, "no rubric point text");
		assert.equal(text.includes("secret point"), false, "no other rubric point text");
		assert.equal("scoringPages" in body, false, "no scoring pages");
		assert.equal("points" in (body.parts as Array<Record<string, unknown>>)[0]!, false, "no rubric points");
	});

	it("reports present false when the paper is not on this computer but still projects it", async () => {
		const course = apCourseStore.create("AP Questions absent");
		apCourseStore.putDocument(course.id, {
			id: "frq-2023",
			kind: "frq",
			label: "2023 FRQ",
			url: "",
			file: "frq-2023.pdf",
		});
		apIndexStore.putPaper(course.id, "frq-2023", [question("topic_gone")]);

		const res = await getQuestion(course.id, "2023-2");
		assert.equal(res.status, 200);
		const body = (await res.json()) as {
			file: string;
			present: boolean;
			parts: Array<{ label: string; topicId?: string; topicText?: string }>;
		};
		assert.equal(body.file, "frq-2023.pdf");
		assert.equal(body.present, false);
		assert.deepEqual(body.parts, [{ label: "a" }, { label: "b" }, { label: "c" }]);
	});

	it("is a 404 for an unknown course or question", async () => {
		assert.equal((await getQuestion("ap_never_existed", "2023-2")).status, 404);

		const course = apCourseStore.create("AP Questions 404");
		apIndexStore.putPaper(course.id, "frq-2023", [question("topic_gone")]);
		assert.equal((await getQuestion(course.id, "1999-1")).status, 404);
	});
});
