/**
 * AP INDEXING JOB (AP prep stage 2, Task 5): the background job that reads
 * each saved released paper with its scoring guideline once and writes the
 * synced question index.
 *
 * Hermetic: an injected fake port stands in for the course record, the index
 * store and the paper folder; a scripted faux engine stands in for the
 * indexing model. No network, no real stores, no data/ writes.
 *
 * Review Focus 3 is the spine: one bad model answer must reject only that
 * pair — never write half an index, never discard another pair's result.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import type { JobRecord, SteerMessage } from "../src/core/contracts.ts";
import type { ApCourseRecord, ApDocument } from "../src/core/ap.ts";
import { isApQuestionIndex, type ApQuestionIndex, type ApRealQuestion } from "../src/core/ap-frq.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { JobRunnerDeps } from "../src/agent/subagents/runner.ts";
import type { ApIndexResult } from "../src/core/contracts.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-indexer-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { createJobRunner, apIndexModelOverride } = await import("../src/agent/subagents/runner.ts");
const { submissionProblem } = await import("../src/agent/subagents/ap-indexer.ts");

const PAPERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-indexer-papers-"));

after(() => {
	apIndexModelOverride.current = undefined;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
	fs.rmSync(PAPERS_DIR, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Two pages of real extractable text, comfortably over the 200-character
 *  readable-text floor. */
const PAGE_TEXT =
	"A released free-response question about evaluating a definite integral using substitution and the Fundamental Theorem of Calculus. " +
	"Show the substitution, change the limits of integration, and evaluate the resulting integral exactly. " +
	"Justify each step with the relevant theorem or definition from the course framework.";

function writePaper(file: string, pages = 2): void {
	const pdf = tinyPdf(
		Array.from({ length: pages }, () => ({ runs: [{ text: PAGE_TEXT, x: 36, y: 720 }] })),
	);
	fs.writeFileSync(path.join(PAPERS_DIR, file), pdf);
}

function frqDoc(year: number, set?: number): ApDocument {
	const file = `frq-${year}${set === undefined ? "" : `-set${set}`}.pdf`;
	return {
		id: file.slice(0, -".pdf".length),
		kind: "frq",
		label: `${year}${set === undefined ? "" : ` Set ${set}`} FRQ`,
		year,
		url: "",
		file,
		pages: 2,
	};
}

function scoringDoc(year: number, set?: number): ApDocument {
	const file = `scoring-${year}${set === undefined ? "" : `-set${set}`}.pdf`;
	return {
		id: file.slice(0, -".pdf".length),
		kind: "scoring",
		label: `${year}${set === undefined ? "" : ` Set ${set}`} Scoring`,
		year,
		url: "",
		file,
		pages: 2,
	};
}

const TOPICS = [
	{ id: "t_limits", unit: "Unit 1 Limits", text: "1.1 Introducing Calculus" },
	{ id: "t_deriv", unit: "Unit 2 Derivatives", text: "2.1 Definition of the Derivative" },
];

function courseOf(documents: ApDocument[]): ApCourseRecord {
	return {
		id: "ap_course_1",
		title: "AP Calculus BC",
		createdAt: "2026-11-14T00:00:00.000Z",
		updatedAt: "2026-11-14T00:00:00.000Z",
		planConfirmed: true,
		documents,
		sections: [
			{
				id: "unit_limits",
				title: "Unit 1 Limits",
				points: [
					{ id: "t_limits", text: "1.1 Introducing Calculus", source: "p. 12", status: "unchecked", history: [] },
				],
			},
			{
				id: "unit_deriv",
				title: "Unit 2 Derivatives",
				points: [
					{ id: "t_deriv", text: "2.1 Definition of the Derivative", source: "p. 30", status: "unchecked", history: [] },
				],
			},
		],
		version: 1,
	};
}

function question(paperId: string, overrides: Partial<ApRealQuestion> = {}): ApRealQuestion {
	return {
		id: `${paperId.replace(/^frq-/, "")}-1`,
		paperId,
		scoringId: paperId.replace(/^frq-/, "scoring-"),
		year: 2023,
		number: 1,
		pages: [1],
		scoringPages: [1],
		parts: [{ label: "a", topicId: "t_limits", points: [{ id: "a1", text: "A point" }] }],
		...overrides,
	};
}

interface FakeApIndex {
	port: NonNullable<JobRunnerDeps["apIndex"]>;
	puts: { paperId: string; questions: ApRealQuestion[] }[];
	index(): ApQuestionIndex | null;
}

function fakeIndex(
	course: ApCourseRecord,
	seed?: ApQuestionIndex,
	failPuts: ReadonlySet<string> = new Set(),
): FakeApIndex {
	let index: ApQuestionIndex | null = seed ?? null;
	const puts: FakeApIndex["puts"] = [];
	return {
		puts,
		index: () => index,
		port: {
			course: (courseId) => (courseId === course.id ? course : null),
			index: (courseId) => (courseId === course.id ? index : null),
			putPaper: (courseId, paperId, questions) => {
				// The real store refuses a malformed index; a failed save must
				// not reach storage or drop the pairs already written.
				if (failPuts.has(paperId)) throw new Error("invalid question index");
				puts.push({ paperId, questions });
				const kept = (index?.questions ?? []).filter((candidate) => candidate.paperId !== paperId);
				index = {
					courseId,
					version: 1,
					updatedAt: "2026-11-14T00:00:00.000Z",
					questions: [...kept, ...questions],
				};
			},
			paperPath: (_courseId, file) => {
				const full = path.join(PAPERS_DIR, file);
				return fs.existsSync(full) ? full : null;
			},
		},
	};
}

interface FakeJobs {
	jobStore: JobStore;
	activities: string[];
	create(): JobRecord;
}

function fakeJobs(): FakeJobs {
	const records = new Map<string, JobRecord>();
	const activities: string[] = [];
	let n = 0;
	const jobStore = {
		createJob(init: {
			kind: JobRecord["kind"];
			chatId: string;
			toolCallId: string;
			activity?: string;
			input?: unknown;
		}) {
			const now = "2026-11-14T00:00:00.000Z";
			const job: JobRecord = {
				id: `job_${++n}`,
				kind: init.kind,
				chatId: init.chatId,
				toolCallId: init.toolCallId,
				input: init.input,
				status: "running",
				activity: init.activity ?? "starting",
				createdAt: now,
				updatedAt: now,
			};
			records.set(job.id, job);
			return job;
		},
		getJob(id: string) {
			return records.get(id) ?? null;
		},
		updateJob(id: string, patch: Partial<JobRecord>) {
			const current = records.get(id);
			if (!current) return null;
			const next = { ...current, ...patch } as JobRecord;
			if (typeof patch.activity === "string") activities.push(patch.activity);
			records.set(id, next);
			return next;
		},
		findJobByToolCallId() {
			return null;
		},
	} as unknown as JobStore;
	return {
		jobStore,
		activities,
		create: () => jobStore.createJob({ kind: "ap_index", chatId: "chat_now", toolCallId: `call_${n + 1}` }),
	};
}

/** A chat store with one live chat (the runner's jobContext only reads it). */
function fakeChats(): ChatStore {
	return {
		getChat: (id: string) => ({ id, messages: [] }),
	} as unknown as ChatStore;
}

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** One assistant turn that submits an index (the tool name the indexer
 *  offers). */
function submit(value: ToolCall["arguments"], id: string): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall("submit_index", value, { id })], { stopReason: "toolUse" });
}

const GOOD_INDEX = {
	questions: [
		{
			number: 1,
			pages: [1],
			scoringPages: [1],
			parts: [
				{ label: "a", topicId: "t_limits", points: ["Correctly states the limit", "Justifies with the definition"] },
				{ label: "b", topicId: "", points: ["Correct derivative"] },
			],
		},
	],
};

async function run(
	apIndex: JobRunnerDeps["apIndex"],
	engine: PiEngine,
	courseId = "ap_course_1",
): Promise<{ result: ApIndexResult; job: JobRecord; steers: SteerMessage[]; activities: string[] }> {
	const jobs = fakeJobs();
	const job = jobs.create();
	const steers: SteerMessage[] = [];
	const runner = createJobRunner({
		chatStore: fakeChats(),
		jobStore: jobs.jobStore,
		deliver: async (steer) => {
			steers.push(steer);
		},
		apIndex,
	});
	apIndexModelOverride.current = engine;
	try {
		await runner.runJob(job.id, { courseId });
	} finally {
		apIndexModelOverride.current = undefined;
	}
	return {
		result: jobs.jobStore.getJob(job.id)!.result as ApIndexResult,
		job: jobs.jobStore.getJob(job.id)!,
		steers,
		activities: jobs.activities,
	};
}

// ── the job ─────────────────────────────────────────────────────────────────

describe("ap_index job", () => {
	it("stores a good pair with server-assigned point ids and reports untagged parts", async () => {
		writePaper("frq-2023.pdf");
		writePaper("scoring-2023.pdf");
		const course = courseOf([frqDoc(2023), scoringDoc(2023)]);
		const fake = fakeIndex(course);

		const { result, job, steers, activities } = await run(
			fake.port,
			fauxEngine([submit(GOOD_INDEX, "s1")]),
		);

		assert.equal(fake.puts.length, 1, "one successful pair is written once");
		const put = fake.puts[0]!;
		assert.equal(put.paperId, "frq-2023");
		assert.equal(put.questions.length, 1);
		const q = put.questions[0]!;
		assert.equal(q.id, "2023-1");
		assert.equal(q.paperId, "frq-2023");
		assert.equal(q.scoringId, "scoring-2023");
		assert.equal(q.year, 2023);
		assert.equal(q.set, undefined);
		assert.equal(q.number, 1);
		assert.deepEqual(q.pages, [1]);
		assert.deepEqual(q.scoringPages, [1]);
		assert.deepEqual(q.parts, [
			{
				label: "a",
				topicId: "t_limits",
				points: [
					{ id: "a1", text: "Correctly states the limit" },
					{ id: "a2", text: "Justifies with the definition" },
				],
			},
			{ label: "b", points: [{ id: "b1", text: "Correct derivative" }] },
		]);
		assert.equal(Object.hasOwn(q.parts[1]!, "topicId"), false, "an empty topicId is an absent tag");

		assert.deepEqual(result.indexed, [{ paperId: "frq-2023", questions: 1 }]);
		assert.deepEqual(result.failed, []);
		assert.equal(result.untagged, 1);
		assert.equal(result.brief, "Indexed 1 questions from 1 papers. 1 parts have no topic tag.");
		assert.equal(job.status, "done");
		assert.equal(job.activity, "finished");
		assert.ok(activities.includes("indexed 2023 FRQ"), "the activity line names the paper");
		assert.equal(steers.length, 1);
		assert.ok(steers[0]!.content.includes(result.brief), "the steer carries the brief");
		assert.equal(isApQuestionIndex(fake.index()!), true, "everything written validates as a question index");
	});

	it("rejects every structural hole and still stores a good pair in the same job", async () => {
		// Years this suite's other cases do not touch (the paper folder is shared).
		const years = [2030, 2031, 2032, 2033, 2034, 2035];
		const docs: ApDocument[] = [];
		for (const year of years) {
			writePaper(`frq-${year}.pdf`);
			writePaper(`scoring-${year}.pdf`);
			docs.push(frqDoc(year), scoringDoc(year));
		}
		const course = courseOf(docs);
		const fake = fakeIndex(course);

		const part = (overrides: ToolCall["arguments"] = {}): ToolCall["arguments"] => ({
			label: "a",
			topicId: "t_limits",
			points: ["A point"],
			...overrides,
		});
		const one = (
			overrides: ToolCall["arguments"],
			parts: ToolCall["arguments"][] = [part()],
		): ToolCall["arguments"] => ({
			questions: [{ number: 1, pages: [1], scoringPages: [1], parts, ...overrides }],
		});
		const holes = [
			one({ pages: [] }),
			one({ number: 0 }),
			one({}, [part({ label: "A1" })]),
			one({}, [part({ points: ["   "] })]),
			one({}, [part({ label: "A" }), part({ label: "a", points: ["Another point"] })]),
		];

		// Each invalid answer is retried to the turn limit, so each pair fails;
		// the last pair's answer is good and must still be stored.
		const steps: FauxResponseStep[] = [];
		for (const [index, value] of holes.entries()) {
			for (let retry = 0; retry < 4; retry++) steps.push(submit(value, `hole-${index}-${retry}`));
		}
		steps.push(submit(GOOD_INDEX, "good-after-holes"));

		const { result } = await run(fake.port, fauxEngine(steps));

		assert.deepEqual(fake.puts.map((put) => put.paperId), ["frq-2035"], "nothing malformed is written");
		assert.deepEqual(result.indexed, [{ paperId: "frq-2035", questions: 1 }]);
		assert.deepEqual(
			result.failed.map((failure) => failure.paperId),
			["frq-2030", "frq-2031", "frq-2032", "frq-2033", "frq-2034"],
			"every rejected hole fails only its own pair",
		);
		for (const failure of result.failed) {
			assert.equal(failure.reason, "the indexer never submitted a question index");
		}
		assert.equal(isApQuestionIndex(fake.index()!), true, "the surviving index is well-formed");
	});

	it("pairs a set paper with its set scoring guideline", async () => {
		writePaper("frq-2023-set2.pdf");
		writePaper("scoring-2023-set2.pdf");
		const course = courseOf([frqDoc(2023, 2), scoringDoc(2023, 2)]);
		const fake = fakeIndex(course);

		const { result } = await run(fake.port, fauxEngine([submit(GOOD_INDEX, "set-good")]));

		assert.deepEqual(fake.puts.map((put) => put.paperId), ["frq-2023-set2"]);
		const q = fake.puts[0]!.questions[0]!;
		assert.equal(q.id, "2023-s2-1");
		assert.equal(q.set, 2);
		assert.equal(q.scoringId, "scoring-2023-set2");
		assert.equal(result.indexed[0]!.paperId, "frq-2023-set2");
		assert.equal(isApQuestionIndex(fake.index()!), true);
	});

	it("reports a refused save as that pair failing and still indexes another pair", async () => {
		for (const year of [2023, 2024]) {
			writePaper(`frq-${year}.pdf`);
			writePaper(`scoring-${year}.pdf`);
		}
		const course = courseOf([frqDoc(2023), scoringDoc(2023), frqDoc(2024), scoringDoc(2024)]);
		const fake = fakeIndex(course, undefined, new Set(["frq-2023"]));

		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		let outcome: Awaited<ReturnType<typeof run>>;
		try {
			outcome = await run(
				fake.port,
				fauxEngine([submit(GOOD_INDEX, "save-refused"), submit(GOOD_INDEX, "save-good")]),
			);
		} finally {
			console.error = original;
		}
		const { result } = outcome;

		assert.equal(logged.length, 1, "the real save error is logged");
		assert.match(String(logged[0]![0]), /saving frq-2023:/);
		assert.match(String(logged[0]![1]), /invalid question index/);
		assert.deepEqual(fake.puts.map((put) => put.paperId), ["frq-2024"]);
		assert.deepEqual(result.indexed, [{ paperId: "frq-2024", questions: 1 }]);
		assert.deepEqual(result.failed, [{ paperId: "frq-2023", reason: "could not be saved" }]);
		assert.match(result.brief, /Failed: 2023 FRQ \(could not be saved\)/);
		assert.equal(isApQuestionIndex(fake.index()!), true);
	});

	it("rejects each bad model answer without losing a good pair (Review Focus 3)", async () => {
		const years = [2020, 2021, 2022, 2024, 2023];
		const docs: ApDocument[] = [];
		for (const year of years) {
			writePaper(`frq-${year}.pdf`);
			writePaper(`scoring-${year}.pdf`);
			docs.push(frqDoc(year), scoringDoc(year));
		}
		const course = courseOf(docs);
		const fake = fakeIndex(course);

		const good = GOOD_INDEX;
		const outOfRange = {
			questions: [{ number: 1, pages: [9], scoringPages: [1], parts: [{ label: "a", topicId: "t_limits", points: ["P"] }] }],
		};
		const unknownTopic = {
			questions: [{ number: 1, pages: [1], scoringPages: [1], parts: [{ label: "a", topicId: "t_ghost", points: ["P"] }] }],
		};
		const noPoints = {
			questions: [{ number: 1, pages: [1], scoringPages: [1], parts: [{ label: "a", topicId: "t_limits", points: [] }] }],
		};
		const duplicateNumbers = {
			questions: [
				{ number: 1, pages: [1], scoringPages: [1], parts: [{ label: "a", topicId: "t_limits", points: ["P"] }] },
				{ number: 1, pages: [2], scoringPages: [1], parts: [{ label: "a", topicId: "t_limits", points: ["P"] }] },
			],
		};

		// Each invalid answer is retried to the turn limit, so the pair fails;
		// the last pair's answer is good and must still be stored.
		const steps: FauxResponseStep[] = [];
		const bad = [outOfRange, unknownTopic, noPoints, duplicateNumbers];
		for (const [index, value] of bad.entries()) {
			for (let retry = 0; retry < 4; retry++) steps.push(submit(value, `bad-${index}-${retry}`));
		}
		steps.push(submit(good, "good"));

		const { result } = await run(fake.port, fauxEngine(steps));

		assert.deepEqual(fake.puts.map((put) => put.paperId), ["frq-2023"], "only the valid pair is written");
		assert.deepEqual(result.indexed, [{ paperId: "frq-2023", questions: 1 }]);
		assert.deepEqual(
			result.failed.map((failure) => failure.paperId),
			["frq-2020", "frq-2021", "frq-2022", "frq-2024"],
			"every bad answer fails its own pair, in document order",
		);
		for (const failure of result.failed) {
			assert.equal(failure.reason, "the indexer never submitted a question index");
		}
		assert.match(result.brief, /^Indexed 1 questions from 1 papers\./);
		assert.match(result.brief, /Failed: 2020 FRQ \(/);
		assert.match(result.brief, /; 2021 FRQ \(/);
		assert.match(result.brief, /; 2022 FRQ \(/);
		assert.match(result.brief, /; 2024 FRQ \(/);
	});

	it("skips a paper the index already holds and never calls the model", async () => {
		writePaper("frq-2023.pdf");
		writePaper("scoring-2023.pdf");
		const course = courseOf([frqDoc(2023), scoringDoc(2023)]);
		const seeded: ApQuestionIndex = {
			courseId: course.id,
			version: 1,
			updatedAt: "2026-11-13T00:00:00.000Z",
			questions: [question("frq-2023")],
		};
		const fake = fakeIndex(course, seeded);

		const { result, job } = await run(fake.port, fauxEngine([]));

		assert.equal(fake.puts.length, 0);
		assert.deepEqual(result.indexed, []);
		assert.deepEqual(result.failed, []);
		assert.equal(result.untagged, 0);
		assert.equal(result.brief, "Indexed 0 questions from 0 papers.");
		assert.equal(job.status, "done", "a skipped paper is not a failure");
	});

	it("reports a paper without its scoring guideline and writes nothing", async () => {
		writePaper("frq-2024.pdf");
		const course = courseOf([frqDoc(2024)]);
		const fake = fakeIndex(course);

		const { result, job, steers } = await run(fake.port, fauxEngine([]));

		assert.equal(fake.puts.length, 0);
		assert.deepEqual(result.indexed, []);
		assert.deepEqual(result.failed, [
			{ paperId: "frq-2024", reason: "no scoring guideline saved for this paper" },
		]);
		assert.match(result.brief, /^Indexing failed:/);
		assert.match(result.brief, /no scoring guideline saved for this paper/);
		assert.equal(job.status, "error", "an all-failed job is a subagent failure");
		assert.ok(steers[0]!.content.includes("flag the gap"), "the teacher learns to flag the gap");
	});

	it("reports a recorded paper whose file is not on this computer", async () => {
		// Both documents are recorded, but neither PDF exists on disk.
		const course = courseOf([frqDoc(2025), scoringDoc(2025)]);
		const fake = fakeIndex(course);

		const { result, job } = await run(fake.port, fauxEngine([]));

		assert.equal(fake.puts.length, 0);
		assert.deepEqual(result.failed, [{ paperId: "frq-2025", reason: "not on this computer" }]);
		assert.match(result.brief, /^Indexing failed:/);
		assert.match(result.brief, /not on this computer/);
		assert.equal(job.status, "error");
	});

	it("reports a scanned pair with no readable text", async () => {
		// Real PDFs whose pages carry no text at all.
		fs.writeFileSync(path.join(PAPERS_DIR, "frq-2026.pdf"), tinyPdf([{}, {}]));
		fs.writeFileSync(path.join(PAPERS_DIR, "scoring-2026.pdf"), tinyPdf([{}, {}]));
		const course = courseOf([frqDoc(2026), scoringDoc(2026)]);
		const fake = fakeIndex(course);

		const { result } = await run(fake.port, fauxEngine([]));

		assert.equal(fake.puts.length, 0);
		assert.deepEqual(result.failed, [
			{ paperId: "frq-2026", reason: "no readable text (scanned document)" },
		]);
	});

	it("rejects a fractional question number at the validation seam", () => {
		// Direct guard test: pi's wire layer runs Value.Convert before the submit
		// seam and turns 1.5 into 1, so a model submission can never deliver a
		// fractional number here — the integer law is exercised where it lives.
		const problem = submissionProblem(
			{
				questions: [
					{
						number: 1.5,
						pages: [1],
						scoringPages: [1],
						parts: [{ label: "a", topicId: "t_limits", points: ["A point"] }],
					},
				],
			},
			2,
			2,
			new Set(["t_limits"]),
		);

		assert.equal(problem, "question number 1.5 is not a positive integer");
	});

	it("normalises a padded part label and trims a padded rubric point", async () => {
		writePaper("frq-2040.pdf");
		writePaper("scoring-2040.pdf");
		const course = courseOf([frqDoc(2040), scoringDoc(2040)]);
		const fake = fakeIndex(course);

		const padded = {
			questions: [
				{
					number: 1,
					pages: [1],
					scoringPages: [1],
					parts: [{ label: " A ", topicId: "t_limits", points: ["  point  "] }],
				},
			],
		};

		const { result } = await run(fake.port, fauxEngine([submit(padded, "padded")]));

		assert.deepEqual(fake.puts.map((put) => put.paperId), ["frq-2040"]);
		const part = fake.puts[0]!.questions[0]!.parts[0]!;
		assert.equal(part.label, "a");
		assert.deepEqual(part.points, [{ id: "a1", text: "point" }]);
		assert.deepEqual(result.indexed, [{ paperId: "frq-2040", questions: 1 }]);
	});

	it("accepts hyphenated sub-part labels and gives each its own point ids", async () => {
		writePaper("frq-2042.pdf");
		writePaper("scoring-2042.pdf");
		const course = courseOf([frqDoc(2042), scoringDoc(2042)]);
		const fake = fakeIndex(course);

		const subParts = {
			questions: [
				{
					number: 1,
					pages: [1],
					scoringPages: [1],
					parts: [
						{ label: "a-i", topicId: "t_limits", points: ["First sub-part point"] },
						{ label: "a-ii", topicId: "", points: ["Second sub-part point"] },
					],
				},
			],
		};

		const { result } = await run(fake.port, fauxEngine([submit(subParts, "sub-parts")]));

		assert.deepEqual(result.indexed, [{ paperId: "frq-2042", questions: 1 }]);
		const parts = fake.puts[0]!.questions[0]!.parts;
		assert.deepEqual(
			parts.map((part) => part.points.map((point) => point.id)),
			[["a-i1"], ["a-ii1"]],
		);
	});

	it("reports an unexpected model failure as could not be read and logs the real error", async () => {
		writePaper("frq-2041.pdf");
		writePaper("scoring-2041.pdf");
		const course = courseOf([frqDoc(2041), scoringDoc(2041)]);
		const fake = fakeIndex(course);

		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		const exploding: PiEngine = {
			model: faux.getModel(),
			streamFn: () => {
				throw new Error("provider blew up");
			},
		};

		const logged: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		let outcome: Awaited<ReturnType<typeof run>>;
		try {
			outcome = await run(fake.port, exploding);
		} finally {
			console.error = original;
		}

		assert.deepEqual(outcome.result.failed, [{ paperId: "frq-2041", reason: "could not be read" }]);
		assert.equal(outcome.result.brief, "Indexing failed: could not be read");
		assert.equal(fake.puts.length, 0, "nothing is written from a failed read");
		assert.equal(outcome.job.status, "error");
		assert.equal(outcome.job.error, "could not be read");
		assert.ok(logged.length >= 1, "the real error is logged");
		assert.match(String(logged[0]![0]), /indexing frq-2041:/);
	});

	it("fails terminally when the indexing port is absent", async () => {
		const { job } = await run(undefined, fauxEngine([]));

		assert.equal(job.status, "error");
		assert.equal(job.error, "paper indexing is not available.");
		assert.match((job.result as ApIndexResult).brief, /^Indexing failed: paper indexing is not available\./);
	});

	it("fails terminally when the course was not found", async () => {
		const fake = fakeIndex(courseOf([]));
		const { job } = await run(fake.port, fauxEngine([]), "ap_missing");

		assert.equal(job.status, "error");
		assert.equal(job.error, 'course "ap_missing" was not found');
		assert.match((job.result as ApIndexResult).brief, /^Indexing failed: course "ap_missing" was not found/);
	});
});