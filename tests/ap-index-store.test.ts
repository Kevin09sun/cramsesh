/**
 * AP QUESTION INDEX STORE PINS (AP prep stage 2, 2026-11-14): one JSON file
 * per course under data/ap-index/ holds the released free-response questions
 * — their pages, parts, topic tags and rubric points. The index is learning
 * data (it syncs with the course record), so every write is atomic and
 * announces "ap-changed", and the degraded read is honest: a file that does
 * not parse — or is not a question index — reads as absent and is never
 * rewritten. Runs under an isolated LH_DATA_DIR set before any
 * config-loading import (the chat-birth-stamp discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ap-index-store-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { apIndexStore } = await import("../src/store/ap-index.ts");
const { subscribe } = await import("../src/core/events.ts");

type ApRealQuestion = import("../src/core/ap-frq.ts").ApRealQuestion;

function question(overrides: Partial<ApRealQuestion> = {}): ApRealQuestion {
	return {
		id: "2023-2",
		paperId: "frq-2023",
		scoringId: "scoring-2023",
		year: 2023,
		number: 2,
		pages: [3, 4],
		scoringPages: [5],
		parts: [
			{ label: "a", topicId: "t11", points: [{ id: "a1", text: "first point" }] },
			{ label: "b", points: [{ id: "b1", text: "second point" }] },
		],
		...overrides,
	};
}

function indexFile(courseId: string): string {
	return path.join(TMP_DATA, "ap-index", `${courseId}.json`);
}

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("AP question index store (AP prep stage 2, 2026-11-14)", () => {
	it("putPaper replaces only its own paper's questions and keeps the rest", () => {
		const courseId = "ap_put_paper";
		apIndexStore.putPaper(courseId, "frq-2022", [
			question({ id: "2022-1", paperId: "frq-2022", scoringId: "scoring-2022", year: 2022, number: 1 }),
		]);

		const with2023 = apIndexStore.putPaper(courseId, "frq-2023", [
			question({ id: "2023-2", number: 2 }),
			question({ id: "2023-1", number: 1 }),
		]);
		assert.equal(with2023.courseId, courseId);
		assert.equal(with2023.version, 1);
		assert.ok(with2023.updatedAt.length > 0, "a write stamps updatedAt");
		assert.deepEqual(
			with2023.questions.map((item) => item.id),
			["2023-1", "2023-2", "2022-1"],
			"the new paper's questions are added in order",
		);

		const replaced = apIndexStore.putPaper(courseId, "frq-2023", [question({ id: "2023-3", number: 3 })]);
		assert.deepEqual(
			replaced.questions.map((item) => item.id),
			["2023-3", "2022-1"],
			"the paper's old questions are gone; the other paper's question stays",
		);
		assert.deepEqual(apIndexStore.get(courseId), replaced, "the write is what a later read sees");
		assert.equal(fs.existsSync(indexFile(courseId)), true, "the index lives under data/ap-index/");
	});

	it("putPaper sorts by year desc, then set, then number", () => {
		const courseId = "ap_index_sort";
		apIndexStore.putPaper(courseId, "frq-2023-set2", [
			question({ id: "2023-s2-2", paperId: "frq-2023-set2", year: 2023, set: 2, number: 2 }),
			question({ id: "2023-s2-1", paperId: "frq-2023-set2", year: 2023, set: 2, number: 1 }),
		]);
		const withSingleSet = apIndexStore.putPaper(courseId, "frq-2023", [
			question({ id: "2023-1", paperId: "frq-2023", year: 2023, number: 1 }),
		]);
		assert.deepEqual(
			withSingleSet.questions.map((item) => item.id),
			["2023-1", "2023-s2-1", "2023-s2-2"],
			"within a year, set then number",
		);

		const newer = apIndexStore.putPaper(courseId, "frq-2024", [
			question({ id: "2024-2", paperId: "frq-2024", year: 2024, number: 2 }),
			question({ id: "2024-1", paperId: "frq-2024", year: 2024, number: 1 }),
		]);
		assert.deepEqual(
			newer.questions.map((item) => item.id),
			["2024-1", "2024-2", "2023-1", "2023-s2-1", "2023-s2-2"],
			"newer years come first",
		);
	});

	it("putPaper refuses a malformed question and leaves the file untouched", () => {
		const courseId = "ap_put_invalid";
		apIndexStore.putPaper(courseId, "frq-2022", [
			question({ id: "2022-1", paperId: "frq-2022", scoringId: "scoring-2022", year: 2022, number: 1 }),
		]);
		const before = fs.readFileSync(indexFile(courseId), "utf-8");

		assert.throws(
			() => apIndexStore.putPaper(courseId, "frq-2023", [question({ pages: [] })]),
			{ message: "invalid question index" },
		);
		assert.equal(fs.readFileSync(indexFile(courseId), "utf-8"), before, "a refused write leaves the bytes alone");
		assert.deepEqual(
			apIndexStore.get(courseId)!.questions.map((item) => item.id),
			["2022-1"],
			"the earlier paper's questions stay readable",
		);
	});

	it("retagPart refuses an invalid result and leaves the file untouched", () => {
		const courseId = "ap_retag_invalid";
		apIndexStore.putPaper(courseId, "frq-2023", [question()]);
		const before = fs.readFileSync(indexFile(courseId), "utf-8");

		assert.throws(
			() => apIndexStore.retagPart(courseId, "2023-2", "a", ""),
			{ message: "invalid question index" },
		);
		assert.equal(fs.readFileSync(indexFile(courseId), "utf-8"), before, "a refused retag leaves the bytes alone");
	});

	it("get returns null for missing, malformed, wrong-shaped and invalid-id reads, never rewriting", () => {
		assert.equal(apIndexStore.get("ap_never_existed"), null);

		const dir = path.join(TMP_DATA, "ap-index");
		fs.mkdirSync(dir, { recursive: true });
		const broken = path.join(dir, "ap_broken.json");
		const brokenBytes = "{ not json";
		fs.writeFileSync(broken, brokenBytes);
		assert.equal(apIndexStore.get("ap_broken"), null);
		assert.equal(fs.readFileSync(broken, "utf-8"), brokenBytes, "the unreadable index is left untouched");

		const wrong = path.join(dir, "ap_wrong_shape.json");
		const wrongBytes = JSON.stringify({
			courseId: "ap_wrong_shape",
			version: 1,
			updatedAt: "2026-11-14T00:00:00.000Z",
			questions: [{ id: "2023-2" }],
		});
		fs.writeFileSync(wrong, wrongBytes);
		assert.equal(apIndexStore.get("ap_wrong_shape"), null, "a wrong-shaped file reads as absent");
		assert.equal(fs.readFileSync(wrong, "utf-8"), wrongBytes, "the wrong-shaped index is left untouched");

		assert.equal(apIndexStore.get("../escape"), null, "an invalid id reads as absent, never throws");
	});

	it("retagPart sets and clears a part's topic tag", () => {
		const courseId = "ap_retag";
		apIndexStore.putPaper(courseId, "frq-2023", [question()]);

		const tagged = apIndexStore.retagPart(courseId, "2023-2", "b", "t12");
		const taggedPart = tagged.questions[0]!.parts.find((part) => part.label === "b")!;
		assert.equal(taggedPart.topicId, "t12");
		assert.equal(
			apIndexStore.get(courseId)!.questions[0]!.parts.find((part) => part.label === "b")!.topicId,
			"t12",
			"the tag is persisted",
		);

		const cleared = apIndexStore.retagPart(courseId, "2023-2", "b", undefined);
		const clearedPart = cleared.questions[0]!.parts.find((part) => part.label === "b")!;
		assert.equal(Object.hasOwn(clearedPart, "topicId"), false, "an untagged part carries no topicId");
		assert.equal(
			Object.hasOwn(apIndexStore.get(courseId)!.questions[0]!.parts.find((part) => part.label === "b")!, "topicId"),
			false,
			"the cleared tag is persisted",
		);
	});

	it("retagPart throws 'unknown question' and 'unknown part'", () => {
		const courseId = "ap_retag_errors";
		apIndexStore.putPaper(courseId, "frq-2023", [question()]);

		assert.throws(
			() => apIndexStore.retagPart(courseId, "1999-1", "a", "t11"),
			{ message: "unknown question" },
		);
		assert.throws(
			() => apIndexStore.retagPart(courseId, "2023-2", "z", "t11"),
			{ message: "unknown part" },
		);
		assert.throws(
			() => apIndexStore.retagPart("ap_never_existed", "2023-2", "a", "t11"),
			{ message: "unknown question" },
			"a missing index has no questions",
		);
	});

	it("putPaper and retagPart announce ap-changed", () => {
		let announces = 0;
		const off = subscribe((event) => {
			if (event.type === "ap-changed") announces++;
		});

		apIndexStore.putPaper("ap_index_events", "frq-2023", [question()]);
		assert.equal(announces, 1, "putPaper announces");

		apIndexStore.retagPart("ap_index_events", "2023-2", "a", "t11");
		assert.equal(announces, 2, "retagPart announces");

		off();
	});
});