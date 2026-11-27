/**
 * TestStore — the fs JSON adapter for Test prep records (one file per test
 * in data/tests/).
 *
 * A test record holds the plan (sections of points) plus each point's
 * progress across sittings; the pure rules live in core/test-prep.ts. Every
 * mutation is a fresh read-modify-write (a plan edit made while a sitting
 * is open must not be reverted by the next answer) and announces
 * "tests-changed" post-write. Idioms match the chat store: sync fs, tiny
 * records, id-guarded filenames, the shared atomic writer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import {
	applyAdditions,
	applyResult,
	forgetChatInPoint,
	mergePlan,
	readiness,
	removePoint,
} from "../core/test-prep.ts";
import { normalizeCheatSheet } from "../core/cheat-sheet.ts";
import type { CheatSheet, CheatSheetBuild } from "../core/cheat-sheet.ts";
import type {
	AnswerResult,
	LeftOutItem,
	PendingAdditions,
	PlanDraftSection,
	SweepState,
	TestRecord,
} from "../core/test-prep.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const TEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const POINT_STATUSES: ReadonlySet<string> = new Set(["unchecked", "solid", "gap", "fixed-recheck"]);

/** A caller-supplied left-out item; the store mints the id when absent. */
type LeftOutInput = Omit<LeftOutItem, "id"> & { id?: string };

function testFile(id: string): string {
	if (!TEST_ID_PATTERN.test(id)) throw new Error(`Invalid test id: ${id}`);
	return path.join(PATHS.tests, `${id}.json`);
}

/** Ids mirror chat ids: sortable, collision-resistant filename-safe strings. */
function newId(): string {
	return `test_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function writeTest(record: TestRecord): void {
	writeFileAtomicSync(testFile(record.id), JSON.stringify(record, null, "\t"));
}

/** The record shape a file must satisfy before the store trusts it. A
 *  parseable file can still be foreign (a conflict copy, a hand-edited
 *  notes file), and projecting readiness off it would crash or lie. */
function isTestRecord(value: unknown): value is TestRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.title !== "string" ||
		typeof record.createdAt !== "string" ||
		typeof record.updatedAt !== "string" ||
		typeof record.planConfirmed !== "boolean" ||
		!Array.isArray(record.sections)
	) {
		return false;
	}
	return record.sections.every((section) => {
		if (typeof section !== "object" || section === null || Array.isArray(section)) return false;
		const candidate = section as Record<string, unknown>;
		if (typeof candidate.id !== "string" || typeof candidate.title !== "string" || !Array.isArray(candidate.points)) {
			return false;
		}
		return candidate.points.every((point) => {
			if (typeof point !== "object" || point === null || Array.isArray(point)) return false;
			const item = point as Record<string, unknown>;
			return (
				typeof item.id === "string" &&
				typeof item.text === "string" &&
				typeof item.source === "string" &&
				typeof item.status === "string" &&
				POINT_STATUSES.has(item.status) &&
				Array.isArray(item.history)
			);
		});
	});
}

/** Give every left-out item its permanent id; an explicit id wins. */
function mintLeftOut(items: LeftOutInput[]): LeftOutItem[] {
	return items.map((item) => (item.id === undefined ? { ...item, id: newId() } : (item as LeftOutItem)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sweep fields are optional and only trusted at their basic shape: a
 * `leftOut` that is not an array (or a `sweep`/`pendingAdditions` that is not
 * an object) reads as absent. The file is never rewritten on read, so a
 * hand-edit or foreign writer cannot corrupt the next mutation.
 */
function withoutMalformedSweepFields(record: TestRecord): TestRecord {
	const strip: Array<"leftOut" | "sweep" | "pendingAdditions" | "cheatSheet" | "cheatSheetBuild"> = [];
	if (record.leftOut !== undefined && !Array.isArray(record.leftOut)) strip.push("leftOut");
	if (record.sweep !== undefined && !isPlainObject(record.sweep)) strip.push("sweep");
	if (record.pendingAdditions !== undefined && !isPlainObject(record.pendingAdditions)) {
		strip.push("pendingAdditions");
	}
	// A sheet is derived content: only a shape the page can render is kept.
	if (record.cheatSheet !== undefined && normalizeCheatSheet(record.cheatSheet) === null) {
		strip.push("cheatSheet");
	}
	const build = record.cheatSheetBuild;
	if (
		build !== undefined &&
		(!isPlainObject(build) ||
			(build.status !== "running" && build.status !== "error") ||
			typeof build.startedAt !== "string")
	) {
		strip.push("cheatSheetBuild");
	}
	if (strip.length === 0) return record;

	const next: TestRecord = { ...record };
	for (const key of strip) delete next[key];
	return next;
}

function get(id: string): TestRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(testFile(id), "utf-8"));
	} catch {
		// Missing, unreadable, or malformed: an honest absent read. The file
		// is left untouched — a caller must never rewrite what it could not
		// parse.
		return null;
	}
	// Parseable but wrong-shaped reads the same as absent; the file is never
	// rewritten here.
	return isTestRecord(parsed) ? withoutMalformedSweepFields(parsed) : null;
}

function loadOrThrow(id: string): TestRecord {
	const record = get(id);
	if (!record) throw new Error(`Test not found: ${id}`);
	return record;
}

function create(title: string, folder?: string): TestRecord {
	const now = new Date().toISOString();
	const record: TestRecord = {
		id: newId(),
		title: title.trim(),
		...(folder === undefined ? {} : { folder }),
		createdAt: now,
		updatedAt: now,
		planConfirmed: false,
		sections: [],
		version: 1,
	};
	fs.mkdirSync(PATHS.tests, { recursive: true });
	writeTest(record);
	emit("tests-changed", {});
	return record;
}

/** Summaries for the test list: readiness is derived at projection time,
 *  never stored. The solid/total counts ride along so the UI can apply the
 *  one count-based percent rule (a bare ratio cannot be floored safely).
 *  Most recently touched first. */
function list(): Array<
	Pick<TestRecord, "id" | "title" | "updatedAt" | "planConfirmed"> & {
		readiness: number;
		solid: number;
		total: number;
	}
> {
	try {
		fs.mkdirSync(PATHS.tests, { recursive: true });
		return fs
			.readdirSync(PATHS.tests)
			.filter((file) => file.endsWith(".json"))
			.map((file) => file.slice(0, -5))
			.filter((id) => TEST_ID_PATTERN.test(id))
			.map((id) => get(id))
			.filter((record): record is TestRecord => record !== null)
			.map((record) => {
				const ready = readiness(record);
				const counts = ready.sections.reduce(
					(acc, section) => ({ solid: acc.solid + section.solid, total: acc.total + section.total }),
					{ solid: 0, total: 0 },
				);
				return {
					id: record.id,
					title: record.title,
					updatedAt: record.updatedAt,
					planConfirmed: record.planConfirmed,
					readiness: ready.overall,
					solid: counts.solid,
					total: counts.total,
				};
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Merge an edited plan draft (ids minted here for new sections/points) and
 *  set the confirmation to exactly `confirm`. An unconfirmed save CLEARS a
 *  prior confirmation: a revision after confirmation is a new proposal the
 *  learner has not approved, and questions must be refused until they do. */
function savePlan(id: string, draft: PlanDraftSection[], confirm: boolean): TestRecord {
	const record = loadOrThrow(id);
	const next: TestRecord = {
		...record,
		sections: mergePlan(record.sections, draft, newId),
		planConfirmed: confirm,
		updatedAt: new Date().toISOString(),
	};
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/** Apply one answer to a point. The confirmation guard comes first so an
 *  unconfirmed plan refuses with "plan not confirmed" even when the point
 *  id is also unknown. */
function recordResult(id: string, pointId: string, result: AnswerResult, chatId: string): TestRecord {
	const record = loadOrThrow(id);
	if (!record.planConfirmed) throw new Error("plan not confirmed");

	const at = new Date().toISOString();
	let found = false;
	const sections = record.sections.map((section) => ({
		...section,
		points: section.points.map((point) => {
			if (point.id !== pointId) return point;
			found = true;
			return applyResult(point, result, chatId, at);
		}),
	}));
	if (!found) throw new Error("unknown point");

	const next: TestRecord = { ...record, sections, updatedAt: at };
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/** Erase one chat's answers from every point and replay what remains. Writes
 *  only when some point actually carried an attempt from the chat. A missing
 *  test returns false. */
function forgetChat(id: string, chatId: string): boolean {
	const record = get(id);
	if (!record) return false;

	let changed = false;
	const sections = record.sections.map((section) => ({
		...section,
		points: section.points.map((point) => {
			const next = forgetChatInPoint(point, chatId);
			if (next !== point) changed = true;
			return next;
		}),
	}));
	if (!changed) return false;

	const next: TestRecord = { ...record, sections, updatedAt: new Date().toISOString() };
	writeTest(next);
	emit("tests-changed", {});
	return true;
}

function setFolder(id: string, folder: string): TestRecord {
	const record = loadOrThrow(id);
	const next: TestRecord = { ...record, folder, updatedAt: new Date().toISOString() };
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/** Patch the latest sweep's progress. A first write creates the sweep; from
 *  then on `startedAt` belongs to the run, so a patch cannot move it. */
function updateSweep(id: string, patch: Partial<SweepState>): TestRecord {
	const record = loadOrThrow(id);
	let sweep: SweepState;
	if (record.sweep) {
		const merged = { ...record.sweep, ...patch };
		sweep = {
			...merged,
			status: merged.status ?? record.sweep.status,
			startedAt: merged.startedAt ?? record.sweep.startedAt,
			fileHashes: merged.fileHashes ?? record.sweep.fileHashes,
		};
	} else {
		if (patch.startedAt === undefined) throw new Error("sweep not started");
		sweep = {
			status: patch.status ?? "running",
			startedAt: patch.startedAt,
			fileHashes: patch.fileHashes ?? {},
			...(patch.activity === undefined ? {} : { activity: patch.activity }),
			...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
			...(patch.error === undefined ? {} : { error: patch.error }),
			...(patch.coverage === undefined ? {} : { coverage: patch.coverage }),
			...(patch.fileStats === undefined ? {} : { fileStats: patch.fileStats }),
		};
	}

	const next: TestRecord = { ...record, sweep, updatedAt: new Date().toISOString() };
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/** Replace the stored left-out list. The plan-review card prunes promoted
 *  items and PUTs the remainder; like every other mutation this is a fresh
 *  read-modify-write. An explicit item id wins; a missing one is minted. */
function setLeftOut(id: string, items: LeftOutInput[]): TestRecord {
	const record = loadOrThrow(id);
	const next: TestRecord = {
		...record,
		leftOut: mintLeftOut(items),
		updatedAt: new Date().toISOString(),
	};
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/**
 * The sitting's Skip action: erase one point from the plan and keep it
 * recoverable — it lands in leftOut as "skipped by you", promotable from the
 * readiness page like any other left-out item. Only ever removes scope, so
 * it carries no confirmation gate. An unknown point is a no-op (a retried
 * skip after the point already left) and returns the record untouched;
 * emptying the plan is refused.
 */
function skipPoint(id: string, pointId: string): TestRecord {
	const record = loadOrThrow(id);

	let skipped: { text: string; source: string; section: string } | undefined;
	for (const section of record.sections) {
		const point = section.points.find((candidate) => candidate.id === pointId);
		if (point) {
			skipped = { text: point.text, source: point.source, section: section.title };
			break;
		}
	}
	if (!skipped) return record;

	const sections = removePoint(record.sections, pointId);
	if (!sections || sections.length === 0) throw new Error("the plan's last point cannot be skipped");

	const next: TestRecord = {
		...record,
		sections,
		leftOut: [
			...(record.leftOut ?? []),
			{
				id: newId(),
				text: skipped.text,
				source: skipped.source,
				reason: "skipped by you",
				suggestedSection: skipped.section,
			},
		],
		updatedAt: new Date().toISOString(),
	};
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/** First sweep only: a test that already has sections keeps them. The saved
 *  plan stays unconfirmed — it is a proposal, not an approved scope. */
function saveSweepPlan(id: string, draft: PlanDraftSection[], leftOut: LeftOutInput[]): TestRecord {
	const record = loadOrThrow(id);
	if (record.sections.length > 0) throw new Error("plan already exists");

	const next: TestRecord = {
		...record,
		sections: mergePlan([], draft, newId),
		planConfirmed: false,
		leftOut: mintLeftOut(leftOut),
		updatedAt: new Date().toISOString(),
	};
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/** Hold a re-sweep's proposal until the learner reviews it. The proposal's
 *  own leftOut items stay inside pendingAdditions. */
function setPendingAdditions(id: string, additions: PendingAdditions): TestRecord {
	const record = loadOrThrow(id);
	const next: TestRecord = {
		...record,
		pendingAdditions: {
			sections: additions.sections,
			leftOut: mintLeftOut(additions.leftOut),
		},
		updatedAt: new Date().toISOString(),
	};
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/**
 * Apply the learner's review of a re-sweep: accepted points become unchecked
 * additions (existing points and their progress are untouched), every other
 * proposal point lands in leftOut as "dropped by you", the proposal's own
 * leftOut items carry over, and the review is cleared.
 */
function resolveAdditions(id: string, acceptedKeys: string[]): TestRecord {
	const record = loadOrThrow(id);
	const pending = record.pendingAdditions;
	if (!pending) throw new Error("no pending additions");

	const accepted = new Set(acceptedKeys);
	const acceptedDrafts: PlanDraftSection[] = [];
	const dropped: LeftOutItem[] = [];

	pending.sections.forEach((section, sectionIndex) => {
		const points = section.points.filter((point, pointIndex) => {
			if (accepted.has(`${sectionIndex}:${pointIndex}`)) return true;
			dropped.push({
				id: newId(),
				text: point.text,
				source: point.source,
				reason: "dropped by you",
				suggestedSection: section.title,
			});
			return false;
		});
		if (points.length > 0) acceptedDrafts.push({ title: section.title, points });
	});

	const { pendingAdditions: _reviewed, ...rest } = record;
	const next: TestRecord = {
		...rest,
		sections: applyAdditions(record.sections, acceptedDrafts, newId),
		leftOut: [...(record.leftOut ?? []), ...pending.leftOut, ...dropped],
		updatedAt: new Date().toISOString(),
	};
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/**
 * Recover a left-out item after confirmation: it becomes an unchecked point in
 * its suggested section, or in the first section when that section does not
 * exist. Confirmation is unchanged and the item leaves leftOut.
 */
function promoteLeftOut(id: string, itemId: string): TestRecord {
	const record = loadOrThrow(id);
	const leftOut = record.leftOut ?? [];
	const item = leftOut.find((candidate) => candidate.id === itemId);
	if (!item) throw new Error("unknown left-out item");

	const fallback = record.sections[0]?.title;
	if (fallback === undefined) throw new Error("no plan sections");
	const wanted = item.suggestedSection?.trim();
	const target = wanted === undefined
		? undefined
		: record.sections.find((section) => section.title.trim() === wanted);
	const title = target ? target.title : fallback;

	const next: TestRecord = {
		...record,
		sections: applyAdditions(
			record.sections,
			[{ title, points: [{ text: item.text, source: item.source }] }],
			newId,
		),
		leftOut: leftOut.filter((candidate) => candidate.id !== itemId),
		updatedAt: new Date().toISOString(),
	};
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/** Replace the stored revision sheet after a successful build. The build
 *  marker is cleared in the same write, so the page never shows "building"
 *  over a finished sheet. */
function setCheatSheet(id: string, sheet: CheatSheet): TestRecord {
	const record = loadOrThrow(id);
	const { cheatSheetBuild: _finished, ...rest } = record;
	const next: TestRecord = {
		...rest,
		cheatSheet: sheet,
		updatedAt: new Date().toISOString(),
	};
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

/** Patch the sheet build's state. A running build keeps its startedAt (and
 *  drops any earlier error); an error records when it failed. */
function updateCheatSheetBuild(id: string, patch: Partial<CheatSheetBuild>): TestRecord {
	const record = loadOrThrow(id);
	const startedAt = patch.startedAt ?? record.cheatSheetBuild?.startedAt ?? new Date().toISOString();
	const status = patch.status ?? "running";
	const build: CheatSheetBuild =
		status === "running"
			? { status, startedAt }
			: {
					status,
					startedAt,
					...(patch.finishedAt === undefined ? { finishedAt: new Date().toISOString() } : { finishedAt: patch.finishedAt }),
					...(patch.error === undefined ? {} : { error: patch.error }),
				};
	const next: TestRecord = { ...record, cheatSheetBuild: build, updatedAt: new Date().toISOString() };
	writeTest(next);
	emit("tests-changed", {});
	return next;
}

export const testStore = {
	create,
	get,
	list,
	savePlan,
	recordResult,
	skipPoint,
	forgetChat,
	setFolder,
	updateSweep,
	saveSweepPlan,
	setLeftOut,
	setPendingAdditions,
	resolveAdditions,
	promoteLeftOut,
	setCheatSheet,
	updateCheatSheetBuild,
};
