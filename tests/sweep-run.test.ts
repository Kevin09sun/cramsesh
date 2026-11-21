/**
 * Task 6 — the sweep orchestrator.
 *
 * Ties the stages together: enumerate, cache/transcribe, chunk/extract,
 * merge, save. The model-backed extractor and merger are replaced through
 * `deps.stages` (the documented test seam); vision is the injected
 * `describe` stub. A temp LH_DATA_DIR holds the test records and transcript
 * cache, and each test gets its own materials folder.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import type { Candidate } from "../src/agent/subagents/sweep/extract.ts";
import type { MergeInput, MergeOutput } from "../src/agent/subagents/sweep/merge.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import type { SweepDeps } from "../src/agent/subagents/sweep/run-sweep.ts";
import { tinyPdf, type Run } from "./helpers/tiny-pdf.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sweep-run-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { runSweep } = await import("../src/agent/subagents/sweep/run-sweep.ts");
const { testStore } = await import("../src/store/tests.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { enumerateFolder } = await import("../src/agent/subagents/sweep/transcribe.ts");

type Stages = NonNullable<SweepDeps["stages"]>;
type ExtractFn = NonNullable<Stages["extract"]>;
type MergeFn = NonNullable<Stages["merge"]>;

let folder: string;

beforeEach(() => {
	folder = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sweep-materials-"));
});

afterEach(() => {
	headlessOverride.current = undefined;
	fs.rmSync(folder, { recursive: true, force: true });
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function write(name: string, text: string): string {
	const abs = path.join(folder, name);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, text);
	return abs;
}

/** The marker strings in a chunk, in first-appearance order. */
function markersIn(chunk: string): string[] {
	const markers: string[] = [];
	for (const line of chunk.split("\n")) {
		const match = /^<!-- source: (.+?) -->$/.exec(line.trim());
		if (match && !markers.includes(match[1]!)) markers.push(match[1]!);
	}
	return markers;
}

/** A stand-in extractor: returns the fixtures whose source is in the chunk. */
function extractStub(candidates: Candidate[]): ExtractFn {
	return async (chunk) => {
		const markersSeen = markersIn(chunk);
		const present = new Set(markersSeen);
		return { candidates: candidates.filter((candidate) => present.has(candidate.source)), markersSeen };
	};
}

/** A scripted merger that records every input it receives. */
function mergeStub(outputs: MergeOutput[], captured: MergeInput[] = []): MergeFn {
	let index = 0;
	return async (input) => {
		captured.push(input);
		const output = outputs[Math.min(index, outputs.length - 1)];
		index++;
		return output ?? { sections: [], leftOut: [] };
	};
}

function throwingMerge(message: string, calls: { count: number }): MergeFn {
	return async () => {
		calls.count++;
		throw new Error(message);
	};
}

function deps(stages: Stages, overrides: Partial<SweepDeps> = {}): SweepDeps {
	return {
		store: testStore,
		engines: {},
		describe: async () => "unused",
		stages,
		...overrides,
	};
}

function fakeHeadless(): HeadlessApi {
	return {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => {
			throw new Error("unused in this test");
		},
		renderSvg: async () => Buffer.alloc(0),
		renderPdfPages: async (_pdfPath, pages) => pages.map((page) => ({ page, png: Buffer.from("fake-png") })),
	};
}

const LONG_TEXT =
	"Photosynthesis converts light energy into chemical energy stored in glucose and releases oxygen as a byproduct " +
	"of the light dependent reactions that happen inside the chloroplast thylakoid membranes of every plant cell. " +
	"Chlorophyll absorbs red and blue wavelengths while reflecting green light back to the observer.";

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
	return lines.map((run, index) => ({ text: run, x: 40, y: 700 - index * 18 }));
}

const section = (title: string, points: Array<[string, string]>): MergeOutput["sections"][number] => ({
	title,
	points: points.map(([text, source]) => ({ text, source })),
});

// ── tests ───────────────────────────────────────────────────────────────────

describe("runSweep", () => {
	it("initial sweep saves an unconfirmed plan, leftOut and coverage", async () => {
		write("a.md", "# Algebra\nSolve for x by factoring.");
		write("b.txt", "Geometry: the area of a circle is pi r squared.");
		const record = testStore.create("Initial sweep", folder);

		const candidates: Candidate[] = [
			{ kind: "fact", category: "process/steps", text: "Solve for x", source: "a.md", evidence: "Solve for x" },
			{ kind: "fact", category: "formula", text: "Area of a circle", source: "b.txt", evidence: "pi r squared" },
		];
		const stages: Stages = {
			extract: extractStub(candidates),
			merge: mergeStub([
				{
					sections: [section("Math", [["Solve for x", "a.md"], ["Area of a circle", "b.txt"]])],
					leftOut: [{ text: "Chapter heading", source: "a.md", reason: "heading" }],
				},
			]),
		};

		const outcome = await runSweep(record.id, "initial", deps(stages));

		assert.equal(outcome.ok, true);
		assert.equal(outcome.mode, "initial");
		assert.equal(outcome.points, 2);
		assert.equal(outcome.leftOut, 1);

		const saved = testStore.get(record.id)!;
		assert.equal(saved.planConfirmed, false, "the plan is a proposal, not an approved scope");
		assert.equal(saved.sections.length, 1);
		assert.deepEqual(
			saved.sections[0]!.points.map((point) => [point.text, point.status]),
			[
				["Solve for x", "unchecked"],
				["Area of a circle", "unchecked"],
			],
		);
		assert.equal(saved.leftOut!.length, 1);
		assert.match(saved.leftOut![0]!.id, /^test_[0-9a-z]+_[0-9a-f]{8}$/, "the store mints the id");

		assert.equal(saved.sweep!.status, "done");
		assert.ok(saved.sweep!.finishedAt);
		const coverage = saved.sweep!.coverage!;
		assert.equal(coverage.files, 2);
		assert.equal(coverage.pages, 2);
		assert.equal(coverage.visionPages, 0);
		assert.deepEqual(coverage.unsupported, []);
		assert.deepEqual(coverage.unreadable, []);
		assert.deepEqual(coverage.empty, []);
		assert.deepEqual(coverage.removed, []);
		assert.deepEqual(Object.keys(saved.sweep!.fileHashes).sort(), ["a.md", "b.txt"]);
	});

	it("merge failing twice ends in error and saves nothing", async () => {
		write("a.md", "alpha");
		write("b.txt", "beta");
		const record = testStore.create("Merge failure", folder);
		const calls = { count: 0 };

		const stages: Stages = {
			extract: extractStub([
				{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
			]),
			merge: throwingMerge("merger exploded", calls),
		};

		const outcome = await runSweep(record.id, "initial", deps(stages));

		assert.equal(outcome.ok, false);
		assert.equal(calls.count, 2, "the merge is retried exactly once");
		assert.match(outcome.error!, /merger exploded/);
		assert.match(outcome.error!, /Read 2 files · 2 pages\./);

		const saved = testStore.get(record.id)!;
		assert.deepEqual(saved.sections, [], "nothing is saved");
		assert.equal(saved.leftOut, undefined);
		assert.equal(saved.sweep!.status, "error");
		assert.match(saved.sweep!.error!, /merger exploded\. Read 2 files · 2 pages\./);
		assert.equal(
			saved.sweep!.coverage!.files,
			0,
			"a failed initial run keeps the (empty) previous totals — it does not fold this run's counts",
		);
	});

	it("resweep with no changes makes no merger call and records lastResweep.files 0", async () => {
		write("a.md", "alpha");
		write("b.txt", "beta");
		const record = testStore.create("No changes", folder);

		const first = await runSweep(
			record.id,
			"initial",
			deps({
				extract: extractStub([
					{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
				]),
				merge: mergeStub([{ sections: [section("A", [["Alpha", "a.md"]])], leftOut: [] }]),
			}),
		);
		assert.equal(first.ok, true);
		const before = testStore.get(record.id)!;

		let extractCalls = 0;
		let mergeCalls = 0;
		const stages: Stages = {
			extract: async () => {
				extractCalls++;
				return { candidates: [], markersSeen: [] };
			},
			merge: async () => {
				mergeCalls++;
				return { sections: [], leftOut: [] };
			},
		};

		const outcome = await runSweep(record.id, "resweep", deps(stages));

		assert.equal(outcome.ok, true);
		assert.equal(outcome.points, 0);
		assert.equal(outcome.leftOut, 0);
		assert.equal(extractCalls, 0, "no extraction is needed");
		assert.equal(mergeCalls, 0, "no merger call is made");

		const after = testStore.get(record.id)!;
		assert.deepEqual(after.sections, before.sections, "sections untouched");
		assert.equal(after.pendingAdditions, undefined, "nothing is proposed");
		assert.equal(after.sweep!.status, "done");
		assert.equal(after.sweep!.coverage!.lastResweep!.files, 0);
	});

	it("resweep sends only changed files and existing point texts to the merger, writes pendingAdditions, leaves sections untouched", async () => {
		write("a.md", "alpha v1");
		write("b.txt", "beta v1");
		const record = testStore.create("Changed file", folder);

		const first = await runSweep(
			record.id,
			"initial",
			deps({
				extract: extractStub([
					{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
					{ kind: "fact", category: "definition", text: "Beta", source: "b.txt", evidence: "beta" },
				]),
				merge: mergeStub([
					{
						sections: [section("Basics", [["Alpha", "a.md"], ["Beta", "b.txt"]])],
						leftOut: [{ text: "Old noise", source: "a.md", reason: "noise" }],
					},
				]),
			}),
		);
		assert.equal(first.ok, true);
		const before = testStore.get(record.id)!;

		write("b.txt", "beta v2 with new material");
		const captured: MergeInput[] = [];
		const chunks: string[] = [];
		const stages: Stages = {
			extract: async (chunk) => {
				chunks.push(chunk);
				return {
					candidates: [
						{ kind: "fact", category: "definition", text: "Beta two", source: "b.txt", evidence: "v2" },
					],
					markersSeen: markersIn(chunk),
				};
			},
			merge: mergeStub(
				[
					{
						sections: [section("New material", [["Beta two", "b.txt"]])],
						leftOut: [{ text: "New noise", source: "b.txt", reason: "noise" }],
					},
				],
				captured,
			),
		};

		const outcome = await runSweep(record.id, "resweep", deps(stages));

		assert.equal(outcome.ok, true);
		assert.equal(outcome.points, 1);
		assert.ok(chunks.length > 0);
		assert.ok(chunks.every((chunk) => !chunk.includes("a.md")), "unchanged files are not re-read");
		assert.ok(chunks.some((chunk) => chunk.includes("b.txt")));
		assert.equal(captured.length, 1);
		assert.deepEqual(
			captured[0]!.existingPoints,
			before.sections.flatMap((s) => s.points.map((point) => point.text)),
			"the merger receives the existing point texts",
		);
		assert.deepEqual(
			captured[0]!.existingLeftOut,
			before.leftOut!.map((item) => item.text),
		);
		assert.ok(captured[0]!.candidates.every((candidate) => candidate.source === "b.txt"));

		const after = testStore.get(record.id)!;
		assert.deepEqual(after.sections, before.sections, "existing sections and points are untouched");
		assert.deepEqual(after.pendingAdditions!.sections, [section("New material", [["Beta two", "b.txt"]])]);
		assert.equal(after.pendingAdditions!.leftOut.length, 1);
		assert.match(after.pendingAdditions!.leftOut[0]!.id, /^test_/, "the store mints the pending id");
		assert.equal(after.sweep!.coverage!.lastResweep!.files, 1);
		assert.equal(
			after.sweep!.coverage!.files,
			before.sweep!.coverage!.files,
			"a changed file is re-counted in place, never counted twice (I3)",
		);
		assert.equal(after.sweep!.coverage!.pages, before.sweep!.coverage!.pages);
		assert.deepEqual(after.sweep!.fileStats, { "a.md": { pages: 1, visionPages: 0 }, "b.txt": { pages: 1, visionPages: 0 } });
	});

	it("removed file listed in coverage.removed, no points removed", async () => {
		write("a.md", "alpha");
		write("b.txt", "beta");
		const record = testStore.create("Removed file", folder);

		const first = await runSweep(
			record.id,
			"initial",
			deps({
				extract: extractStub([
					{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
					{ kind: "fact", category: "definition", text: "Beta", source: "b.txt", evidence: "beta" },
				]),
				merge: mergeStub([
					{ sections: [section("Both", [["Alpha", "a.md"], ["Beta", "b.txt"]])], leftOut: [] },
				]),
			}),
		);
		assert.equal(first.ok, true);
		const before = testStore.get(record.id)!;

		fs.rmSync(path.join(folder, "a.md"));
		let mergeCalls = 0;
		const stages: Stages = {
			extract: extractStub([]),
			merge: async () => {
				mergeCalls++;
				return { sections: [], leftOut: [] };
			},
		};

		const outcome = await runSweep(record.id, "resweep", deps(stages));

		assert.equal(outcome.ok, true);
		assert.deepEqual(outcome.coverage.removed, ["a.md"]);
		assert.equal(mergeCalls, 0);

		const after = testStore.get(record.id)!;
		assert.deepEqual(after.sections, before.sections, "no points are removed");
		assert.deepEqual(after.sweep!.coverage!.removed, ["a.md"]);
		assert.equal(after.sweep!.coverage!.files, 1, "a removed file's stats leave with it");
		assert.equal(after.sweep!.coverage!.pages, 1);
		assert.deepEqual(after.sweep!.fileStats, { "b.txt": { pages: 1, visionPages: 0 } });
		assert.deepEqual(Object.keys(after.sweep!.fileHashes).sort(), ["b.txt"]);
	});

	it("unreadable file never appears in empty", async () => {
		// Page 1 carries an image (vision target) and enough text to keep its
		// marker in a content chunk; the describe stub fails for it.
		const pdf = tinyPdf([
			{ image: true, runs: wrapRuns("Diagram of a cell") },
			{ runs: wrapRuns(LONG_TEXT) },
		]);
		fs.writeFileSync(path.join(folder, "book.pdf"), pdf);
		headlessOverride.current = fakeHeadless();

		const record = testStore.create("Unreadable page", folder);
		let describeCalls = 0;
		const stages: Stages = {
			extract: extractStub([
				{ kind: "fact", category: "definition", text: "Photosynthesis", source: "book.pdf p. 2", evidence: "ATP" },
			]),
			merge: mergeStub([
				{ sections: [section("Biology", [["Photosynthesis", "book.pdf p. 2"]])], leftOut: [] },
			]),
		};

		const outcome = await runSweep(
			record.id,
			"initial",
			deps(stages, {
				describe: async () => {
					describeCalls++;
					throw new Error("vision down");
				},
			}),
		);

		assert.equal(outcome.ok, true);
		assert.ok(describeCalls >= 1, "the image page went to vision");
		const coverage = testStore.get(record.id)!.sweep!.coverage!;
		assert.equal(coverage.files, 1);
		assert.equal(coverage.pages, 2);
		assert.equal(coverage.visionPages, 0);
		assert.ok(coverage.unreadable.includes("book.pdf p. 1 (vision failed)"));
		assert.deepEqual(coverage.empty, [], "the vision-failed page is not reported as nothing found");
	});

	it("a failed vision read is not cached and is re-read on the next sweep (I4)", async () => {
		const pdf = tinyPdf([
			{ image: true, runs: wrapRuns("Diagram of a cell") },
			{ runs: wrapRuns(LONG_TEXT) },
		]);
		fs.writeFileSync(path.join(folder, "book.pdf"), pdf);
		headlessOverride.current = fakeHeadless();
		const record = testStore.create("Vision retry", folder);

		const stages: Stages = {
			extract: extractStub([
				{ kind: "fact", category: "definition", text: "Photosynthesis", source: "book.pdf p. 2", evidence: "ATP" },
			]),
			merge: mergeStub([
				{ sections: [section("Biology", [["Photosynthesis", "book.pdf p. 2"]])], leftOut: [] },
			]),
		};

		const first = await runSweep(
			record.id,
			"initial",
			deps(stages, {
				describe: async () => {
					throw new Error("vision down");
				},
			}),
		);
		assert.equal(first.ok, true);
		const afterFirst = testStore.get(record.id)!.sweep!;
		assert.ok(afterFirst.coverage!.unreadable.includes("book.pdf p. 1 (vision failed)"));
		assert.equal(afterFirst.coverage!.visionPages, 0);
		const cacheDir = path.join(TMP_DATA, "tests", record.id, "sweep");
		assert.equal(
			fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : 0,
			0,
			"a transcript with an unreadable unit is never cached",
		);

		// The unchanged file is still re-read because it carries an unreadable
		// entry; this time vision succeeds and the failure is cleared.
		let described = 0;
		const second = await runSweep(
			record.id,
			"resweep",
			deps(stages, {
				describe: async () => {
					described++;
					return "A labelled cell diagram.";
				},
			}),
		);
		assert.equal(second.ok, true);
		assert.ok(described >= 1, "the vision page was retried");
		const afterSecond = testStore.get(record.id)!.sweep!;
		assert.deepEqual(afterSecond.coverage!.unreadable, []);
		assert.equal(afterSecond.coverage!.visionPages, 1);
		const cached = fs.readdirSync(cacheDir);
		assert.equal(cached.length, 1, "the successful transcript is cached");
		assert.match(fs.readFileSync(path.join(cacheDir, cached[0]!), "utf8"), /A labelled cell diagram\./);
	});

	it("retries a failed extraction chunk once, then marks it unreadable and continues (I7)", async () => {
		write("a.md", "alpha material that cannot be extracted");
		write("b.txt", "beta material that extracts fine");
		const record = testStore.create("Chunk failure", folder);
		const calls = { a: 0, b: 0 };

		const stages: Stages = {
			extract: async (chunk) => {
				if (chunk.includes("a.md")) {
					calls.a++;
					throw new Error("extractor exploded");
				}
				calls.b++;
				return {
					candidates: [
						{ kind: "fact", category: "definition", text: "Beta", source: "b.txt", evidence: "beta" },
					],
					markersSeen: markersIn(chunk),
				};
			},
			merge: mergeStub([{ sections: [section("B", [["Beta", "b.txt"]])], leftOut: [] }]),
		};

		const outcome = await runSweep(record.id, "initial", deps(stages));

		assert.equal(outcome.ok, true, "one bad chunk does not kill the sweep");
		assert.equal(calls.a, 2, "the failed chunk is retried exactly once");
		assert.equal(outcome.points, 1, "the other chunk still contributes its points");
		const coverage = testStore.get(record.id)!.sweep!.coverage!;
		assert.ok(coverage.unreadable.includes("a.md (extraction failed)"));
		assert.ok(!coverage.empty.includes("a.md"), "an extraction failure is not 'nothing found'");
	});

	it("an enumeration-unreadable file lands in coverage, not fatal (I10)", async () => {
		write("a.md", "alpha");
		const record = testStore.create("Unreadable file", folder);
		const listing = await enumerateFolder(folder);
		const stages: Stages = {
			enumerate: async () => ({
				...listing,
				unreadable: ["ghost.md (could not read file)"],
			}),
			extract: extractStub([
				{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
			]),
			merge: mergeStub([{ sections: [section("A", [["Alpha", "a.md"]])], leftOut: [] }]),
		};

		const outcome = await runSweep(record.id, "initial", deps(stages));

		assert.equal(outcome.ok, true);
		assert.ok(outcome.coverage.unreadable.includes("ghost.md (could not read file)"));
		const coverage = testStore.get(record.id)!.sweep!.coverage!;
		assert.deepEqual(coverage.files, 1, "the unreadable file is not counted as read");
		assert.ok(coverage.unreadable.includes("ghost.md (could not read file)"));
	});

	it("retries enumeration once, then ends in error", async () => {
		write("a.md", "alpha");
		const record = testStore.create("Enumeration failure", folder);
		let calls = 0;
		const stages: Stages = {
			enumerate: async () => {
				calls++;
				throw new Error("file vanished");
			},
			extract: extractStub([]),
			merge: mergeStub([{ sections: [section("A", [["Alpha", "a.md"]])], leftOut: [] }]),
		};

		const outcome = await runSweep(record.id, "initial", deps(stages));

		assert.equal(calls, 2, "enumeration is retried exactly once");
		assert.equal(outcome.ok, false);
		assert.match(outcome.error!, /file vanished/);
		const saved = testStore.get(record.id)!;
		assert.equal(saved.sweep!.status, "error");
		assert.deepEqual(saved.sections, []);
	});

	it("missing models end in error before any model call", async () => {
		write("a.md", "alpha");
		const record = testStore.create("No models", folder);

		const cheap = await runSweep(record.id, "initial", {
			store: testStore,
			engines: {},
			describe: async () => "unused",
		});
		assert.equal(cheap.ok, false);
		assert.equal(cheap.error, "models not configured: cheap");
		assert.equal(testStore.get(record.id)!.sweep!.status, "error");
		assert.equal(testStore.get(record.id)!.sweep!.error, "models not configured: cheap");
		assert.deepEqual(testStore.get(record.id)!.sections, []);

		const strong = await runSweep(record.id, "initial", {
			store: testStore,
			engines: {},
			describe: async () => "unused",
			stages: { extract: extractStub([]) },
		});
		assert.equal(strong.ok, false);
		assert.equal(strong.error, "models not configured: strong");
		assert.equal(testStore.get(record.id)!.sweep!.error, "models not configured: strong");
	});

	it("resweep passes the existing section titles as outline headings", async () => {
		write("a.md", "alpha");
		write("b.txt", "beta");
		const record = testStore.create("Heading reuse", folder);

		const first = await runSweep(
			record.id,
			"initial",
			deps({
				extract: extractStub([
					{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
					{ kind: "fact", category: "definition", text: "Beta", source: "b.txt", evidence: "beta" },
				]),
				merge: mergeStub([
					{
						sections: [section("Algebra", [["Alpha", "a.md"]]), section("Geometry", [["Beta", "b.txt"]])],
						leftOut: [],
					},
				]),
			}),
		);
		assert.equal(first.ok, true);

		write("b.txt", "beta v2");
		const captured: MergeInput[] = [];
		const stages: Stages = {
			extract: extractStub([
				{ kind: "fact", category: "definition", text: "Beta two", source: "b.txt", evidence: "v2" },
			]),
			merge: mergeStub(
				[{ sections: [section("Geometry", [["Beta two", "b.txt"]])], leftOut: [] }],
				captured,
			),
		};

		const outcome = await runSweep(record.id, "resweep", deps(stages));

		assert.equal(outcome.ok, true);
		assert.deepEqual(
			captured[0]!.outlineHeadings,
			["Algebra", "Geometry"],
			"additions land under the sections the learner already has",
		);
	});

	it("a timed-out listing marks no file removed and keeps prior hashes", async () => {
		write("a.md", "alpha");
		write("b.txt", "beta");
		const record = testStore.create("Timed out", folder);

		const first = await runSweep(
			record.id,
			"initial",
			deps({
				extract: extractStub([
					{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
					{ kind: "fact", category: "definition", text: "Beta", source: "b.txt", evidence: "beta" },
				]),
				merge: mergeStub([
					{ sections: [section("Both", [["Alpha", "a.md"], ["Beta", "b.txt"]])], leftOut: [] },
				]),
			}),
		);
		assert.equal(first.ok, true);
		const hashesBefore = testStore.get(record.id)!.sweep!.fileHashes;

		// The partial walk reaches only b.txt; a.md must not be read as deleted.
		fs.rmSync(path.join(folder, "a.md"));
		const listing = await enumerateFolder(folder);
		const stages: Stages = {
			enumerate: async () => ({ ...listing, timedOut: true }),
			extract: extractStub([]),
			merge: async () => ({ sections: [], leftOut: [] }),
		};

		const outcome = await runSweep(record.id, "resweep", deps(stages));

		assert.equal(outcome.ok, true);
		assert.deepEqual(outcome.coverage.removed, [], "unseen is not removed");
		const after = testStore.get(record.id)!;
		assert.deepEqual(after.sweep!.coverage!.removed, []);
		assert.equal(after.sweep!.fileHashes["a.md"], hashesBefore["a.md"], "the unseen file keeps its prior hash");
		assert.deepEqual(Object.keys(after.sweep!.fileHashes).sort(), ["a.md", "b.txt"]);
		assert.ok(after.sweep!.coverage!.unreadable.includes("(folder listing timed out — some files may be missing)"));
	});

	it("starting a run clears a prior error and finishedAt", async () => {
		write("a.md", "alpha");
		const record = testStore.create("Status hygiene", folder);

		// Seed the terminal state a finished prior sweep leaves behind.
		testStore.updateSweep(record.id, {
			status: "done",
			startedAt: "2020-01-01T00:00:00.000Z",
			finishedAt: "2020-01-01T00:05:00.000Z",
			fileHashes: {},
		});

		// A run that errors must not keep the old finish time.
		const failed = await runSweep(record.id, "initial", {
			store: testStore,
			engines: {},
			describe: async () => "unused",
		});
		assert.equal(failed.error, "models not configured: cheap");
		const errored = testStore.get(record.id)!;
		assert.equal(errored.sweep!.error, "models not configured: cheap");
		assert.equal(errored.sweep!.finishedAt, undefined, "the prior finishedAt is cleared at start");

		// A later successful run must not carry the old error.
		const outcome = await runSweep(
			record.id,
			"initial",
			deps({
				extract: extractStub([
					{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
				]),
				merge: mergeStub([{ sections: [section("A", [["Alpha", "a.md"]])], leftOut: [] }]),
			}),
		);
		assert.equal(outcome.ok, true);
		const done = testStore.get(record.id)!;
		assert.equal(done.sweep!.status, "done");
		assert.equal(done.sweep!.error, undefined, "the prior error is cleared at start");
		assert.ok(done.sweep!.finishedAt);
	});

	it("merge failure on a resweep stores cumulative coverage", async () => {
		write("a.md", "alpha");
		write("b.txt", "beta");
		const record = testStore.create("Resweep merge failure", folder);

		const first = await runSweep(
			record.id,
			"initial",
			deps({
				extract: extractStub([
					{ kind: "fact", category: "definition", text: "Alpha", source: "a.md", evidence: "alpha" },
					{ kind: "fact", category: "definition", text: "Beta", source: "b.txt", evidence: "beta" },
				]),
				merge: mergeStub([
					{ sections: [section("Basics", [["Alpha", "a.md"], ["Beta", "b.txt"]])], leftOut: [] },
				]),
			}),
		);
		assert.equal(first.ok, true);
		const initialCoverage = testStore.get(record.id)!.sweep!.coverage!;
		assert.equal(initialCoverage.files, 2);

		write("b.txt", "beta v2");
		const calls = { count: 0 };
		const outcome = await runSweep(
			record.id,
			"resweep",
			deps({
				extract: extractStub([
					{ kind: "fact", category: "definition", text: "Beta two", source: "b.txt", evidence: "v2" },
				]),
				merge: throwingMerge("merger exploded", calls),
			}),
		);

		assert.equal(outcome.ok, false);
		assert.equal(calls.count, 2);
		assert.equal(outcome.coverage.files, 2, "the audit baseline covers the whole folder, without adding re-read files");
		const saved = testStore.get(record.id)!;
		const coverage = saved.sweep!.coverage!;
		assert.equal(saved.sweep!.status, "error");
		assert.match(saved.sweep!.error!, /Read 1 files · 1 pages\./);
		assert.equal(coverage.files, initialCoverage.files, "a failed re-sweep adds no files (I3)");
		assert.equal(coverage.pages, initialCoverage.pages, "a failed re-sweep adds no pages");
	});

	it("initial mode finishes from the record when the plan save landed before a crash", async () => {
		const record = testStore.create("Crash recovery", folder);
		write("a.md", "# Algebra\nSolve for x.");
		testStore.saveSweepPlan(
			record.id,
			[section("Math", [["Solve for x", "a.md"]])],
			[{ text: "Chapter heading", source: "a.md", reason: "heading" }],
		);
		const coverage = { files: 1, pages: 2, visionPages: 0, unsupported: [], unreadable: [], empty: [], removed: [] };
		testStore.updateSweep(record.id, {
			status: "running",
			startedAt: "2026-11-20T00:00:00.000Z",
			fileHashes: { "a.md": "hash" },
			coverage,
		});

		const calls = { enumerate: 0, extract: 0, merge: 0 };
		const outcome = await runSweep(
			record.id,
			"initial",
			deps({
				enumerate: async () => {
					calls.enumerate++;
					return { files: [], unsupported: [], unreadable: [], timedOut: false };
				},
				extract: (async () => {
					calls.extract++;
					return { candidates: [], markersSeen: [] };
				}) as ExtractFn,
				merge: (async () => {
					calls.merge++;
					return { sections: [], leftOut: [] };
				}) as MergeFn,
			}),
		);

		assert.equal(outcome.ok, true);
		assert.equal(outcome.points, 1);
		assert.equal(outcome.leftOut, 1);
		assert.deepEqual(outcome.coverage, coverage, "the stored coverage is reported, not recomputed");
		assert.deepEqual(calls, { enumerate: 0, extract: 0, merge: 0 }, "nothing re-ran");
		const saved = testStore.get(record.id)!;
		assert.equal(saved.sweep!.status, "done", "the interrupted sweep is closed");
		assert.equal(saved.sections.length, 1, "the already-saved plan is untouched");
	});
});