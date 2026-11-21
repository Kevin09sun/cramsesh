/**
 * Test-material sweep, orchestrator (Task 6).
 *
 * Runs one sweep of a test's materials folder end to end:
 *   enumerate → (cache | transcribe) → chunk → extract → merge → save.
 *
 * The first sweep saves an unconfirmed plan; a re-sweep reads only files
 * whose content hash changed, proposes the genuinely new material into
 * `pendingAdditions`, and never touches existing points. Coverage describes
 * the whole folder cumulatively; "couldn't read" (unreadable) stays distinct
 * from "read but found nothing" (empty).
 *
 * Model seams: the reader (vision descriptions), extractor and merger are
 * injected as PiEngines. `deps.describe` overrides the reader entirely, and
 * `deps.stages` overrides a stage (enumerate/extract/merge) for tests.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, TextContent, UserMessage, Usage } from "@earendil-works/pi-ai";
import { PATHS, type ModelRole } from "../../../../config.ts";
import {
	emptyCoverage,
	mergeCoverage,
	type LeftOutItem,
	type PlanDraftSection,
	type SweepCoverage,
	type SweepState,
	type TestRecord,
} from "../../../core/test-prep.ts";
import type { PiEngine } from "../../models.ts";
import { processImage } from "../../image-processing/index.ts";
import { runSubagent } from "../pi-run.ts";
import { chunkTranscripts, extractCandidates, type Candidate } from "./extract.ts";
import { mergeCandidates, type MergeInput, type MergeOutput } from "./merge.ts";
import {
	enumerateFolder,
	transcribeFile,
	type Describe,
	type SweepFile,
	type Transcript,
} from "./transcribe.ts";

// ─── ports and inputs ───────────────────────────────────────────────────────

/** The store mints left-out ids, so a sweep may hand it id-less items. */
export type SweepLeftOutInput = Omit<LeftOutItem, "id"> & { id?: string };

/** The slice of the test store a sweep needs (structurally satisfied by testStore). */
export interface SweepStore {
	get(id: string): TestRecord | null;
	updateSweep(id: string, patch: Partial<SweepState>): TestRecord;
	saveSweepPlan(id: string, draft: PlanDraftSection[], leftOut: SweepLeftOutInput[]): TestRecord;
	setPendingAdditions(
		id: string,
		additions: { sections: PlanDraftSection[]; leftOut: SweepLeftOutInput[] },
	): TestRecord;
}

/** Test seam: replace a filesystem or model-backed stage wholesale. */
export interface SweepStageOverrides {
	enumerate?: typeof enumerateFolder;
	extract?: typeof extractCandidates;
	merge?: typeof mergeCandidates;
}

export interface SweepDeps {
	store: SweepStore;
	engines: { reader?: PiEngine; extractor?: PiEngine; merger?: PiEngine };
	/** Default: the reader engine via runSubagent with image content parts. */
	describe?: Describe;
	signal?: AbortSignal;
	onUsage?: (role: ModelRole, usage: Usage) => void;
	/** Tests replace the model-backed extractor/merger (and enumerate) here. */
	stages?: SweepStageOverrides;
}

export interface SweepOutcome {
	ok: boolean;
	mode: "initial" | "resweep";
	points: number;
	leftOut: number;
	coverage: SweepCoverage;
	error?: string;
}

// ─── constants ──────────────────────────────────────────────────────────────

/** Extractor chunk budget in tokens (chars/4, the app-wide chunkNotes unit). */
const CHUNK_BUDGET = 4096;
/** Bounded extractor concurrency across chunks. */
const EXTRACT_CONCURRENCY = 4;
const FOLDER_TIMEOUT_ENTRY = "(folder listing timed out — some files may be missing)";
const OUTLINE_FILE = /outline|syllabus|study guide|review/i;
const CACHE_META = /^<!-- sweep-cache: (\{.*\}) -->\n/;

const READER_SYSTEM = `You are a vision reader for a test-prep study app. Describe the supplied image(s) faithfully so a
teacher can build a test plan from them: transcribe visible text, name every figure, diagram, table, axis, caption and
value, and keep the reading order. For a scanned page, transcribe the text rather than summarizing it. Reply with only
the description.`;

// ─── small helpers ──────────────────────────────────────────────────────────

function nowIso(): string {
	return new Date().toISOString();
}

function reasonOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const flat = message.replace(/\s+/g, " ").trim();
	return flat || "unknown error";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (error instanceof Error) {
		return error.name === "AbortError" || error.message === "aborted" || error.message === "Aborted";
	}
	return false;
}

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

function hashMap(files: SweepFile[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const file of files) map[file.rel] = file.hash;
	return map;
}

type FileStats = NonNullable<SweepState["fileStats"]>;

/** Coverage counts as sums over the per-file stats of files currently present
 *  (I3): a re-read file replaces its own counts, a removed file's counts leave
 *  with it, and a failed run adds nothing. */
function coverageTotals(stats: FileStats): Pick<SweepCoverage, "files" | "pages" | "visionPages"> {
	let pages = 0;
	let visionPages = 0;
	for (const stat of Object.values(stats)) {
		pages += stat.pages;
		visionPages += stat.visionPages;
	}
	return { files: Object.keys(stats).length, pages, visionPages };
}

/** Does an unreadable entry name this marker's file+unit (e.g. "a.pdf p. 1 (vision failed)")? */
function unreadableCovers(marker: string, unreadable: string[]): boolean {
	return unreadable.some((entry) => {
		if (entry === marker) return true;
		if (!entry.startsWith(marker)) return false;
		const boundary = entry.charAt(marker.length);
		return (
			boundary === " " ||
			boundary === ":" ||
			boundary === "(" ||
			boundary === "·" ||
			boundary === "-" ||
			boundary === "–" ||
			boundary === "—"
		);
	});
}

/** The detected outline file's heading lines, without the `#` marks. */
function headingsFromOutline(transcripts: Transcript[]): string[] {
	const outline = transcripts.find((transcript) => OUTLINE_FILE.test(path.basename(transcript.rel)));
	if (!outline) return [];
	const headings: string[] = [];
	for (const line of outline.markdown.split("\n")) {
		const match = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
		if (match) headings.push(match[1]!);
	}
	return headings;
}

/** Marker lines survive an interrupted (or retried) transcription; derive a page count from them. */
function pagesFromMarkdown(markdown: string): number {
	return (markdown.match(/^<!-- source: .* -->$/gm) ?? []).length;
}

// ─── transcript cache ───────────────────────────────────────────────────────

function cacheDirFor(testId: string): string {
	return path.join(PATHS.tests, testId, "sweep");
}

function toCache(file: SweepFile, transcript: Transcript): string {
	const meta = JSON.stringify({
		rel: file.rel,
		pages: transcript.pages,
		visionPages: transcript.visionPages,
		unreadable: transcript.unreadable,
	});
	return `<!-- sweep-cache: ${meta} -->\n${transcript.markdown}`;
}

/** The cached transcript, or null when the cache is absent/foreign/unparseable. */
function fromCache(file: SweepFile, raw: string): Transcript | null {
	const match = CACHE_META.exec(raw);
	if (!match) {
		const markdown = raw;
		return { rel: file.rel, markdown, pages: pagesFromMarkdown(markdown), visionPages: 0, unreadable: [] };
	}
	let meta: { rel?: unknown; pages?: unknown; visionPages?: unknown; unreadable?: unknown };
	try {
		meta = JSON.parse(match[1]!);
	} catch {
		return null;
	}
	// The cache is keyed by content hash only; two same-content files with
	// different names must not swap each other's source markers.
	if (meta.rel !== file.rel) return null;
	return {
		rel: file.rel,
		markdown: raw.slice(match[0].length),
		pages: typeof meta.pages === "number" ? meta.pages : 0,
		visionPages: typeof meta.visionPages === "number" ? meta.visionPages : 0,
		unreadable: Array.isArray(meta.unreadable)
			? meta.unreadable.filter((entry): entry is string => typeof entry === "string")
			: [],
	};
}

async function transcribeOne(
	file: SweepFile,
	describe: Describe,
	signal: AbortSignal | undefined,
	activity: (line: string) => void,
	cacheDir: string,
): Promise<Transcript> {
	throwIfAborted(signal);
	const cacheFile = path.join(cacheDir, `${file.hash}.md`);
	try {
		const cached = fromCache(file, await fsp.readFile(cacheFile, "utf8"));
		if (cached) return cached;
	} catch {
		// No cache entry: transcribe from the source.
	}

	activity(`Reading ${file.rel}`);
	const transcript = await transcribeFile(file, { describe, signal, onActivity: activity });
	try {
		await fsp.mkdir(cacheDir, { recursive: true });
		await fsp.writeFile(cacheFile, toCache(file, transcript), "utf8");
	} catch {
		// A cache write failure is not worth failing the sweep over.
	}
	return transcript;
}

// ─── default reader (describe) ──────────────────────────────────────────────

function readerDescribe(deps: SweepDeps): Describe {
	return async (images, hint) => {
		const engine = deps.engines.reader;
		// Missing reader is an ordinary vision failure: transcribeFile records
		// "(vision failed)" and keeps the page's text.
		if (!engine) throw new Error("no reader model configured");

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: hint }];
		for (const image of images) {
			const processed = await processImage(image.png, image.mime, {
				resizeOptions: engine.model.inputLimits?.images?.resize,
			});
			if (processed.ok) {
				content.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			} else {
				content.push({ type: "text", text: processed.message });
			}
		}
		const message: UserMessage = { role: "user", content, timestamp: Date.now() };
		const result = await runSubagent([], {
			role: "sweepReader",
			engine,
			systemPrompt: READER_SYSTEM,
			messages: [message],
			maxTurns: 1,
			abortSignal: deps.signal,
			onUsage: (usage) => deps.onUsage?.("sweepReader", usage),
		});
		return result.text;
	};
}

// ─── enumeration and extraction ─────────────────────────────────────────────

async function enumerateWithRetry(
	folder: string,
	enumerate: typeof enumerateFolder,
	signal?: AbortSignal,
): Promise<{ files: SweepFile[]; unsupported: string[]; timedOut: boolean }> {
	try {
		return await enumerate(folder);
	} catch (first) {
		if (isAbort(first, signal)) throw first;
		try {
			return await enumerate(folder);
		} catch (second) {
			if (isAbort(second, signal)) throw second;
			throw new Error(`could not list the folder: ${reasonOf(second)}`);
		}
	}
}

async function extractAll(
	chunks: string[],
	deps: SweepDeps,
	extract: typeof extractCandidates,
	activity: (line: string) => void,
	signal: AbortSignal | undefined,
): Promise<{ candidates: Candidate[]; markers: string[] }> {
	if (chunks.length === 0) return { candidates: [], markers: [] };

	const results = await mapLimit(chunks, EXTRACT_CONCURRENCY, async (chunk, index) => {
		throwIfAborted(signal);
		activity(`Finding testable items — chunk ${index + 1}/${chunks.length}`);
		return extract(chunk, {
			engine: deps.engines.extractor,
			signal,
			onUsage: (usage) => deps.onUsage?.("sweepExtractor", usage),
		});
	});

	const candidates = results.flatMap((result) => result.candidates);
	const markers: string[] = [];
	for (const result of results) {
		for (const marker of result.markersSeen) {
			if (!markers.includes(marker)) markers.push(marker);
		}
	}
	return { candidates, markers };
}

// ─── the sweep ──────────────────────────────────────────────────────────────

export async function runSweep(
	testId: string,
	mode: "initial" | "resweep",
	deps: SweepDeps,
): Promise<SweepOutcome> {
	const record = deps.store.get(testId);
	if (!record) {
		return {
			ok: false,
			mode,
			points: 0,
			leftOut: 0,
			coverage: emptyCoverage(),
			error: `test not found: ${testId}`,
		};
	}
	if (!record.folder) {
		return {
			ok: false,
			mode,
			points: 0,
			leftOut: 0,
			coverage: emptyCoverage(),
			error: "no folder stored for this test",
		};
	}

	// Crash recovery (initial mode, 2026-11-20): the plan save landed and the
	// process died before the sweep closed. The record is the truth — report
	// what it holds instead of re-reading the folder and re-proposing a plan
	// over one that already exists.
	if (mode === "initial" && record.sections.length > 0 && Object.keys(record.sweep?.fileHashes ?? {}).length > 0) {
		const coverage = record.sweep?.coverage ?? emptyCoverage();
		if (record.sweep?.status === "running") {
			deps.store.updateSweep(testId, { status: "done", finishedAt: nowIso(), coverage });
		}
		return {
			ok: true,
			mode,
			points: record.sections.reduce((total, section) => total + section.points.length, 0),
			leftOut: (record.leftOut ?? []).length,
			coverage,
		};
	}

	const startedAt = nowIso();
	const previousHashes = record.sweep?.fileHashes ?? {};
	const previousCoverage = record.sweep?.coverage;
	const previousStats: FileStats = record.sweep?.fileStats ?? {};

	let lastActivity = "";
	const activity = (line: string): void => {
		if (line === lastActivity) return;
		lastActivity = line;
		deps.store.updateSweep(testId, { activity: line });
	};

	const fail = (message: string, coverage?: SweepCoverage): SweepOutcome => {
		deps.store.updateSweep(testId, {
			status: "error",
			error: message,
			...(coverage === undefined ? {} : { coverage }),
		});
		return { ok: false, mode, points: 0, leftOut: 0, coverage: coverage ?? emptyCoverage(), error: message };
	};

	const aborted = (): SweepOutcome => {
		deps.store.updateSweep(testId, { status: "error", error: "Aborted" });
		return { ok: false, mode, points: 0, leftOut: 0, coverage: emptyCoverage(), error: "Aborted" };
	};

	deps.store.updateSweep(testId, {
		status: "running",
		startedAt,
		activity: "Reading your materials",
		// Explicit undefined clears a previous run's terminal fields (JSON
		// omits them on write), so a restarted sweep never carries the old
		// error or finish time into its "running" state.
		error: undefined,
		finishedAt: undefined,
	});

	try {
		const enumeration = await enumerateWithRetry(record.folder, deps.stages?.enumerate ?? enumerateFolder, deps.signal);
		throwIfAborted(deps.signal);

		const files = enumeration.files;
		const present = new Set(files.map((file) => file.rel));
		// A timed-out walk is not evidence of deletion: files it did not reach
		// are neither "removed" nor dropped from the hash baseline.
		const removed =
			mode === "resweep" && !enumeration.timedOut
				? Object.keys(previousHashes)
						.filter((rel) => !present.has(rel))
						.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
				: [];
		const changed =
			mode === "resweep" ? files.filter((file) => previousHashes[file.rel] !== file.hash) : files;
		const currentHashes = hashMap(files);
		const fileHashes =
			mode === "resweep" && enumeration.timedOut
				? { ...previousHashes, ...currentHashes }
				: currentHashes;

		// Nothing new on disk: finish without any model call and record the
		// zero-file re-sweep for the "last re-sweep: +0 files" note.
		if (mode === "resweep" && changed.length === 0) {
			const runCoverage: SweepCoverage = {
				files: 0,
				pages: 0,
				visionPages: 0,
				unsupported: [...enumeration.unsupported],
				unreadable: enumeration.timedOut ? [FOLDER_TIMEOUT_ENTRY] : [],
				empty: [],
				removed,
			};
			const finishedAt = nowIso();
			const fileStats: FileStats = { ...previousStats };
			for (const rel of removed) delete fileStats[rel];
			// Nothing was read this run: the totals are the whole folder's
			// per-file stats, minus anything removed from disk.
			const coverage: SweepCoverage = {
				...mergeCoverage(previousCoverage, { ...runCoverage, readFiles: [] }, finishedAt),
				...coverageTotals(fileStats),
			};
			deps.store.updateSweep(testId, { status: "done", finishedAt, coverage, fileHashes, fileStats });
			return { ok: true, mode, points: 0, leftOut: 0, coverage };
		}

		const extract = deps.stages?.extract ?? extractCandidates;
		const merge = deps.stages?.merge ?? mergeCandidates;
		if (!deps.stages?.extract && !deps.engines.extractor) return fail("models not configured: cheap");
		if (!deps.stages?.merge && !deps.engines.merger) return fail("models not configured: strong");

		const describe = deps.describe ?? readerDescribe(deps);
		const cacheDir = cacheDirFor(testId);
		const transcripts: Transcript[] = [];
		for (const file of changed) {
			throwIfAborted(deps.signal);
			transcripts.push(await transcribeOne(file, describe, deps.signal, activity, cacheDir));
		}

		const chunks = chunkTranscripts(transcripts, CHUNK_BUDGET);
		const extracted = await extractAll(chunks, deps, extract, activity, deps.signal);
		throwIfAborted(deps.signal);

		const unreadable = [
			...transcripts.flatMap((transcript) => transcript.unreadable),
			...(enumeration.timedOut ? [FOLDER_TIMEOUT_ENTRY] : []),
		];
		const cited = new Set(extracted.candidates.map((candidate) => candidate.source));
		const runCoverage: SweepCoverage = {
			files: changed.length,
			pages: transcripts.reduce((total, transcript) => total + transcript.pages, 0),
			visionPages: transcripts.reduce((total, transcript) => total + transcript.visionPages, 0),
			unsupported: [...enumeration.unsupported],
			unreadable,
			// Read but yielded nothing — never a unit that couldn't be read.
			empty: extracted.markers.filter(
				(marker) => !cited.has(marker) && !unreadableCovers(marker, unreadable),
			),
			removed,
		};

		const input: MergeInput = {
			candidates: extracted.candidates,
			// A re-sweep must slot additions into the plan the learner already
			// has; only a first sweep derives headings from an outline file.
			outlineHeadings:
				mode === "resweep"
					? record.sections.map((section) => section.title)
					: headingsFromOutline(transcripts),
			existingPoints: record.sections.flatMap((section) => section.points.map((point) => point.text)),
			existingLeftOut: (record.leftOut ?? []).map((item) => item.text),
		};

		const runMerge = (): Promise<MergeOutput> =>
			merge(input, {
				engine: deps.engines.merger,
				signal: deps.signal,
				onUsage: (usage) => deps.onUsage?.("sweepMerger", usage),
			});

		activity("Building the plan");
		let merged: MergeOutput;
		try {
			merged = await runMerge();
		} catch (first) {
			if (isAbort(first, deps.signal)) throw first;
			activity("Building the plan — retrying");
			try {
				merged = await runMerge();
			} catch (second) {
				if (isAbort(second, deps.signal)) throw second;
				const message = `${reasonOf(second)}. Read ${runCoverage.files} files · ${runCoverage.pages} pages.`;
				// Keep the cumulative audit baseline: a failed run must neither
				// shrink the report nor fold this run's counts (I3) — the totals
				// stay the previous run's while the lists may still describe
				// what was re-read.
				const failureCoverage: SweepCoverage = {
					...mergeCoverage(previousCoverage, {
						...runCoverage,
						readFiles: changed.map((file) => file.rel),
					}),
					...coverageTotals(previousStats),
				};
				return fail(message, failureCoverage);
			}
		}

		throwIfAborted(deps.signal);
		if (mode === "initial") {
			deps.store.saveSweepPlan(testId, merged.sections, merged.leftOut);
		} else {
			deps.store.setPendingAdditions(testId, { sections: merged.sections, leftOut: merged.leftOut });
		}

		const finishedAt = nowIso();
		const fileStats: FileStats = { ...previousStats };
		for (const transcript of transcripts) {
			fileStats[transcript.rel] = { pages: transcript.pages, visionPages: transcript.visionPages };
		}
		for (const rel of removed) delete fileStats[rel];
		const coverage: SweepCoverage = {
			...mergeCoverage(
				previousCoverage,
				{ ...runCoverage, readFiles: changed.map((file) => file.rel) },
				mode === "resweep" ? finishedAt : undefined,
			),
			...coverageTotals(fileStats),
		};
		deps.store.updateSweep(testId, { status: "done", finishedAt, coverage, fileHashes, fileStats });

		return {
			ok: true,
			mode,
			points: merged.sections.reduce((total, section) => total + section.points.length, 0),
			leftOut: merged.leftOut.length,
			coverage,
		};
	} catch (error) {
		if (isAbort(error, deps.signal)) return aborted();
		return fail(reasonOf(error));
	}
}