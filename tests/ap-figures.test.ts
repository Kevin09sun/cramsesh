/**
 * AP FIGURES AND THE FIGURE ROUTE (AP prep stage 3, 2026-11-15).
 *
 * A generated question may show a figure the tutor had the existing visual
 * job draw. The job record owns the SVG (result.svg); this layer is the
 * read-only bridge from that record to image bytes. Only a finished drawing
 * job of the SAME chat is a figure — another chat's job, any other job kind,
 * an unfinished or failed drawing and an unknown id are not servable, and the
 * SVG text itself is never served.
 *
 * GET /api/chats/[id]/figures/[jobId] serves a ready figure as a no-cache
 * `image/png` and answers 404 for every other state; an unexpected
 * rasteriser failure is logged and answers 500. Tests inject a fake
 * rasteriser through the module seam, so nothing here paints a real SVG
 * except the one explicit default-renderer check; the size gate does parse
 * documents with resvg, but it never renders them.
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
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-figures-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { figurePng, figureState, resetFigureRasteriser, setFigureRasteriser } = await import(
	"../src/server/ap-figures.ts"
);
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

// The size gate asks the renderer itself, so every test that expects a ready
// figure needs the native package; without it, skip with the same message the
// default-renderer test uses instead of asserting on a renderer we lack.
let nativeRenderer = true;
try {
	await import("@resvg/resvg-js");
} catch {
	nativeRenderer = false;
}
const NO_RESVG = "the native SVG renderer (@resvg/resvg-js) is unavailable on this machine";
const skipWithoutResvg = nativeRenderer ? false : NO_RESVG;

type FiguresRoute = typeof import("../app/api/chats/[id]/figures/[jobId]/route.ts");
let figuresRoute: FiguresRoute;
before(async () => {
	figuresRoute = await import("../app/api/chats/[id]/figures/[jobId]/route.ts");
});
after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
});

type JobKind = import("../src/core/contracts.ts").JobKind;

const BASE = "http://localhost";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from("fake-figure-png-bytes")]);
const TINY_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#000"/></svg>';
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const MAX_SVG_BYTES = 512 * 1024;

let nextToolCall = 0;

function makeChat(title: string): string {
	return chatStore.createChat(title).id;
}

function makeJob(chatId: string, kind: JobKind = "visual") {
	return jobStore.createJob({ kind, chatId, toolCallId: `tc_${++nextToolCall}` });
}

function makeReadyJob(chatId: string) {
	const job = makeJob(chatId);
	jobStore.updateJob(job.id, { status: "done", result: { svg: TINY_SVG } });
	return job;
}

function getFigure(id: string, jobId: string): Promise<Response> {
	return figuresRoute.GET(new Request(`${BASE}/api/chats/${id}/figures/${jobId}`), {
		params: Promise.resolve({ id, jobId }),
	});
}

describe("the default figure rasteriser", () => {
	it("rasterises a stored drawing with the native SVG renderer 1200 px wide", async (t) => {
		try {
			await import("@resvg/resvg-js");
		} catch {
			t.skip("the native SVG renderer (@resvg/resvg-js) is unavailable on this machine");
			return;
		}
		resetFigureRasteriser();
		const chatId = makeChat("AP figure native");
		const job = makeReadyJob(chatId);

		const png = await figurePng(chatId, job.id);
		assert.ok(png.byteLength > PNG_SIGNATURE.length, "the renderer returned bytes");
		assert.deepEqual(png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE, "the bytes are a PNG");
		// PNG IHDR: width is the 4-byte big-endian integer at offset 16.
		assert.equal(png.readUInt32BE(16), 1200, "the PNG is 1200 px wide");
	});
});

describe("figureState", { skip: skipWithoutResvg }, () => {
	it("is pending for a running drawing, ready for a finished one and failed otherwise", () => {
		const chatId = makeChat("AP figure states");

		const pending = makeJob(chatId);
		assert.equal(figureState(chatId, pending.id), "pending");

		assert.equal(figureState(chatId, makeReadyJob(chatId).id), "ready");

		const errored = makeJob(chatId);
		jobStore.updateJob(errored.id, { status: "error", error: "the drawing failed" });
		assert.equal(figureState(chatId, errored.id), "failed");

		const emptySvg = makeJob(chatId);
		jobStore.updateJob(emptySvg.id, { status: "done", result: { svg: "" } });
		assert.equal(figureState(chatId, emptySvg.id), "failed");

		const noResult = makeJob(chatId);
		jobStore.updateJob(noResult.id, { status: "done" });
		assert.equal(figureState(chatId, noResult.id), "failed");
	});

	it("is failed for a stored SVG over the 512 KB cap", () => {
		const chatId = makeChat("AP figure oversize");
		const job = makeJob(chatId);
		jobStore.updateJob(job.id, { status: "done", result: { svg: "x".repeat(MAX_SVG_BYTES + 1) } });

		assert.equal(figureState(chatId, job.id), "failed");
	});

	it("is failed for a canvas over 8000 or a document the renderer cannot parse", () => {
		const chatId = makeChat("AP figure bounds");
		const cases: Array<[string, string]> = [
			["a width over 8000", `<svg ${NS} width="8001" height="10"><rect/></svg>`],
			["a height over 8000", `<svg ${NS} width="10" height="8001"><rect/></svg>`],
			["a viewBox width over 8000", `<svg ${NS} viewBox="0 0 8001 10"><rect/></svg>`],
			["a viewBox height over 8000", `<svg ${NS} viewBox="0 0 10 8001"><rect/></svg>`],
			["a tall, thin drawing", `<svg ${NS} width="100" height="5000"><rect/></svg>`],
			["a tall, thin viewBox-only drawing", `<svg ${NS} viewBox="0 0 100 5000"><rect/></svg>`],
			[
				"a comment that pretends to be the root",
				`<!-- <svg width="10" height="10"> --><svg ${NS} width="100" height="1000"><rect/></svg>`,
			],
			[
				"a processing instruction that pretends to be the root",
				`<?pi <svg width="10" height="10">?><svg ${NS} width="100" height="1000"><rect/></svg>`,
			],
			[
				"a DOCTYPE internal entity that pretends to be the root",
				`<!DOCTYPE svg [<!ENTITY s "<svg width='10' height='10'>">]><svg ${NS} width="100" height="1000"><rect/></svg>`,
			],
			[
				"an attribute value that pretends to be the root size",
				`<svg ${NS} id=" width='1' height='1' " viewBox="0 0 100 5000"><rect/></svg>`,
			],
			[
				"point units over the rendered-height bound",
				`<svg ${NS} width="1pt" height="800pt" viewBox="0 0 1 1"><rect/></svg>`,
			],
			[
				"percentage sizes that resolve to a tall canvas",
				`<svg ${NS} width="10%" height="100%" viewBox="0 0 10 10"><rect/></svg>`,
			],
			["a document the renderer cannot parse", "<svg><rect/></svg>"],
		];
		for (const [label, svg] of cases) {
			const job = makeJob(chatId);
			jobStore.updateJob(job.id, { status: "done", result: { svg } });
			assert.equal(figureState(chatId, job.id), "failed", label);
		}
	});

	it("is ready when the renderer's own parse gives a canvas within the bound", () => {
		const chatId = makeChat("AP figure sizes");
		const cases: Array<[string, string]> = [
			["plain attributes", `<svg ${NS} width="100" height="50"><rect/></svg>`],
			["px attributes", `<svg ${NS} width="100px" height="50px"><rect/></svg>`],
			["a viewBox fallback", `<svg ${NS} viewBox="0 0 100 50"><rect/></svg>`],
			["the renderer's default when no size is declared", `<svg ${NS}><rect/></svg>`],
			["a stroke-width that is not a width", `<svg ${NS} height="100" stroke-width="1"><rect/></svg>`],
			["exactly at the 8000 side bound", `<svg ${NS} width="8000" height="8000"><rect/></svg>`],
			["exactly at the 8000 rendered-height bound", `<svg ${NS} width="1200" height="8000"><rect/></svg>`],
			[
				"a root size beside a child with a huge width",
				`<svg ${NS} width="100" height="50"><rect width="999999" height="999999"/></svg>`,
			],
		];
		for (const [label, svg] of cases) {
			const job = makeJob(chatId);
			jobStore.updateJob(job.id, { status: "done", result: { svg } });
			assert.equal(figureState(chatId, job.id), "ready", label);
		}
	});

	it("is unknown for another chat's drawing, a non-visual job, an absent job and invalid ids", () => {
		const mine = makeChat("AP figure mine");
		const other = makeChat("AP figure other");
		const foreign = makeReadyJob(other);
		assert.equal(figureState(mine, foreign.id), "unknown", "another chat's drawing is unknown");

		const research = makeJob(mine, "research");
		assert.equal(figureState(mine, research.id), "unknown", "a non-visual job is unknown");

		assert.equal(figureState(mine, "job_never_existed"), "unknown");
		assert.equal(figureState("../chat", foreign.id), "unknown");
		assert.equal(figureState(mine, "../job"), "unknown");
		assert.equal(figureState("", foreign.id), "unknown");
	});
});

describe("figurePng", { skip: skipWithoutResvg }, () => {
	it("rasterises the stored SVG of a ready drawing through the seam", async () => {
		const chatId = makeChat("AP figure png");
		const job = makeReadyJob(chatId);

		const seen: string[] = [];
		setFigureRasteriser(async (svg) => {
			seen.push(svg);
			return PNG;
		});

		const png = await figurePng(chatId, job.id);
		assert.deepEqual(png, PNG);
		assert.deepEqual(seen, [TINY_SVG], "the rasteriser receives the stored SVG");
	});

	it("rasterises a figure exactly at the rendered-height bound", async () => {
		const chatId = makeChat("AP figure bound png");
		const svg = `<svg ${NS} width="1200" height="8000"><rect/></svg>`;
		const job = makeJob(chatId);
		jobStore.updateJob(job.id, { status: "done", result: { svg } });

		const seen: string[] = [];
		setFigureRasteriser(async (value) => {
			seen.push(value);
			return PNG;
		});

		assert.deepEqual(await figurePng(chatId, job.id), PNG);
		assert.deepEqual(seen, [svg], "a figure at the bound still reaches the rasteriser");
	});

	it("refuses every drawing that is not ready without rasterising", async () => {
		const chatId = makeChat("AP figure refusal");
		const other = makeChat("AP figure refusal other");
		const pending = makeJob(chatId);
		const failed = makeJob(chatId);
		jobStore.updateJob(failed.id, { status: "error" });
		const oversize = makeJob(chatId);
		jobStore.updateJob(oversize.id, { status: "done", result: { svg: "x".repeat(MAX_SVG_BYTES + 1) } });
		const unreadable = makeJob(chatId);
		jobStore.updateJob(unreadable.id, { status: "done", result: { svg: "<svg><rect/></svg>" } });
		const tallThin = makeJob(chatId);
		jobStore.updateJob(tallThin.id, { status: "done", result: { svg: `<svg ${NS} width="100" height="5000"><rect/></svg>` } });
		const shadowed = makeJob(chatId);
		jobStore.updateJob(shadowed.id, {
			status: "done",
			result: {
				svg: `<!-- <svg width="10" height="10"> --><svg ${NS} width="100" height="1000"><rect/></svg>`,
			},
		});
		const instruction = makeJob(chatId);
		jobStore.updateJob(instruction.id, {
			status: "done",
			result: {
				svg: `<?pi <svg width="10" height="10">?><svg ${NS} width="100" height="1000"><rect/></svg>`,
			},
		});
		const doctype = makeJob(chatId);
		jobStore.updateJob(doctype.id, {
			status: "done",
			result: {
				svg: `<!DOCTYPE svg [<!ENTITY s "<svg width='10' height='10'>">]><svg ${NS} width="100" height="1000"><rect/></svg>`,
			},
		});
		const spoofed = makeJob(chatId);
		jobStore.updateJob(spoofed.id, {
			status: "done",
			result: {
				svg: `<svg ${NS} id=" width='1' height='1' " viewBox="0 0 100 5000"><rect/></svg>`,
			},
		});
		const points = makeJob(chatId);
		jobStore.updateJob(points.id, {
			status: "done",
			result: { svg: `<svg ${NS} width="1pt" height="800pt" viewBox="0 0 1 1"><rect/></svg>` },
		});
		const percent = makeJob(chatId);
		jobStore.updateJob(percent.id, {
			status: "done",
			result: { svg: `<svg ${NS} width="10%" height="100%" viewBox="0 0 10 10"><rect/></svg>` },
		});
		const foreign = makeReadyJob(other);
		const research = makeJob(chatId, "research");

		let calls = 0;
		setFigureRasteriser(async () => {
			calls++;
			return PNG;
		});

		for (const jobId of [
			pending.id,
			failed.id,
			oversize.id,
			unreadable.id,
			tallThin.id,
			shadowed.id,
			instruction.id,
			doctype.id,
			spoofed.id,
			points.id,
			percent.id,
			foreign.id,
			research.id,
			"job_never_existed",
		]) {
			await assert.rejects(
				figurePng(chatId, jobId),
				(error: Error) => error.message === "figure not ready",
				`${jobId} is not ready`,
			);
		}
		assert.equal(calls, 0, "nothing is rasterised unless the figure is ready");
	});
});

describe("GET /api/chats/[id]/figures/[jobId]", { skip: skipWithoutResvg }, () => {
	it("serves a ready drawing as a no-cache PNG without writing a record", async () => {
		const chatId = makeChat("AP figure route");
		const job = makeReadyJob(chatId);
		setFigureRasteriser(async () => PNG);

		const jobFile = path.join(TMP_DATA, "jobs", `${job.id}.json`);
		const chatFile = path.join(TMP_DATA, "chats", `${chatId}.json`);
		const jobBefore = fs.readFileSync(jobFile);
		const chatBefore = fs.readFileSync(chatFile);

		const res = await getFigure(chatId, job.id);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "image/png");
		assert.equal(res.headers.get("cache-control"), "private, no-cache");
		assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);

		assert.deepEqual(fs.readFileSync(jobFile), jobBefore, "the job record is untouched");
		assert.deepEqual(fs.readFileSync(chatFile), chatBefore, "the chat record is untouched");
	});

	it("is a 404 for every drawing that is not ready, an absent job and invalid segments", async () => {
		const chatId = makeChat("AP figure route 404");
		const other = makeChat("AP figure route 404 other");
		const pending = makeJob(chatId);
		const failed = makeJob(chatId);
		jobStore.updateJob(failed.id, { status: "error" });
		const tallThin = makeJob(chatId);
		jobStore.updateJob(tallThin.id, { status: "done", result: { svg: `<svg ${NS} width="100" height="5000"><rect/></svg>` } });
		const shadowed = makeJob(chatId);
		jobStore.updateJob(shadowed.id, {
			status: "done",
			result: {
				svg: `<!-- <svg width="10" height="10"> --><svg ${NS} width="100" height="1000"><rect/></svg>`,
			},
		});
		const instruction = makeJob(chatId);
		jobStore.updateJob(instruction.id, {
			status: "done",
			result: {
				svg: `<?pi <svg width="10" height="10">?><svg ${NS} width="100" height="1000"><rect/></svg>`,
			},
		});
		const doctype = makeJob(chatId);
		jobStore.updateJob(doctype.id, {
			status: "done",
			result: {
				svg: `<!DOCTYPE svg [<!ENTITY s "<svg width='10' height='10'>">]><svg ${NS} width="100" height="1000"><rect/></svg>`,
			},
		});
		const spoofed = makeJob(chatId);
		jobStore.updateJob(spoofed.id, {
			status: "done",
			result: {
				svg: `<svg ${NS} id=" width='1' height='1' " viewBox="0 0 100 5000"><rect/></svg>`,
			},
		});
		const percent = makeJob(chatId);
		jobStore.updateJob(percent.id, {
			status: "done",
			result: { svg: `<svg ${NS} width="10%" height="100%" viewBox="0 0 10 10"><rect/></svg>` },
		});
		const foreign = makeReadyJob(other);
		const research = makeJob(chatId, "research");

		let calls = 0;
		setFigureRasteriser(async () => {
			calls++;
			return PNG;
		});

		for (const jobId of [
			pending.id,
			failed.id,
			tallThin.id,
			shadowed.id,
			instruction.id,
			doctype.id,
			spoofed.id,
			percent.id,
			foreign.id,
			research.id,
			"job_never_existed",
		]) {
			assert.equal((await getFigure(chatId, jobId)).status, 404, `job ${jobId} is not servable`);
		}
		for (const [id, jobId] of [
			["../chat", pending.id],
			["bad id", pending.id],
			[chatId, "job/1"],
			[chatId, ".."],
		] as const) {
			assert.equal((await getFigure(id, jobId)).status, 404, `${id}/${jobId} is malformed`);
		}
		assert.equal(calls, 0, "nothing is rasterised unless the figure is ready");
	});

	it("is a 404 when the drawing stops being ready between the check and the render", async () => {
		const chatId = makeChat("AP figure route race");
		const job = makeReadyJob(chatId);
		setFigureRasteriser(async () => {
			throw new Error("figure not ready");
		});

		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			const res = await getFigure(chatId, job.id);
			assert.equal(res.status, 404, "an expected refusal is a 404");
			assert.equal(logged.length, 0, "an expected refusal is not logged");
		} finally {
			console.error = original;
		}
	});

	it("answers 500 and logs when rasterising fails unexpectedly", async () => {
		const chatId = makeChat("AP figure route error");
		const job = makeReadyJob(chatId);
		setFigureRasteriser(async () => {
			throw new Error("raster exploded");
		});

		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			const res = await getFigure(chatId, job.id);
			assert.equal(res.status, 500);
			assert.deepEqual(await res.json(), { error: "Could not render the figure" });
			assert.equal(logged.length, 1, "the failure is logged");
		} finally {
			console.error = original;
		}
	});
});
