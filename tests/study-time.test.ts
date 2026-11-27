/**
 * Study time (issue #16, owner-approved 2026-11-27): the pure rules behind
 * the session clock and the Study time tracker.
 *
 * Pinned here so the owner's rule cannot drift silently: the clock pauses
 * after two minutes without input (STUDY_IDLE_PAUSE_MS), the server refuses
 * a chunk above ten minutes, chunks merge into ONE entry per local day, and
 * the tracker's calendar is Monday-first with fixed intensity steps.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	formatStudySpan,
	formatStudyTime,
	MAX_STUDY_CHUNK_MS,
	mergeStudyTime,
	parseStudyChunk,
	parseStudyDay,
	STUDY_IDLE_PAUSE_MS,
	studyCalendar,
	studyDayKey,
	studyLevel,
	studyTimeBetween,
	studyTimeTotal,
	studyWeekStartKey,
} from "../src/core/study-time.ts";

describe("studyDayKey", () => {
	it("is the LOCAL calendar day, zero-padded", () => {
		assert.equal(studyDayKey(new Date(2026, 10, 27, 23, 59)), "2026-11-27");
		assert.equal(studyDayKey(new Date(2026, 0, 5, 0, 1)), "2026-01-05");
	});
});

describe("parseStudyDay", () => {
	it("accepts real days", () => {
		assert.equal(parseStudyDay("2026-11-27"), "2026-11-27");
		assert.equal(parseStudyDay("2024-02-29"), "2024-02-29");
	});

	it("refuses impossible days, loose shapes and non-strings", () => {
		assert.equal(parseStudyDay("2026-02-31"), null, "February 31 is not a day");
		assert.equal(parseStudyDay("2026-1-5"), null);
		assert.equal(parseStudyDay("2026-13-01"), null);
		assert.equal(parseStudyDay("yesterday"), null);
		assert.equal(parseStudyDay(20261127), null);
		assert.equal(parseStudyDay(undefined), null);
	});
});

describe("parseStudyChunk", () => {
	it("accepts a heartbeat chunk", () => {
		assert.deepEqual(parseStudyChunk({ day: "2026-11-27", ms: 15_000 }), { day: "2026-11-27", ms: 15_000 });
		assert.equal(parseStudyChunk({ day: "2026-11-27", ms: MAX_STUDY_CHUNK_MS })?.ms, MAX_STUDY_CHUNK_MS);
	});

	it("refuses zero, negative, fractional, oversized and malformed chunks", () => {
		for (const body of [
			null,
			[],
			{},
			{ day: "2026-11-27" },
			{ ms: 15_000 },
			{ day: "2026-11-27", ms: 0 },
			{ day: "2026-11-27", ms: -5_000 },
			{ day: "2026-11-27", ms: 1_500.5 },
			{ day: "2026-11-27", ms: "15000" },
			{ day: "2026-11-27", ms: MAX_STUDY_CHUNK_MS + 1 },
			{ day: "2026-02-31", ms: 15_000 },
			[["2026-11-27", 15_000]],
		]) {
			assert.equal(parseStudyChunk(body), null, JSON.stringify(body));
		}
	});
});

describe("mergeStudyTime", () => {
	it("creates the first entry", () => {
		assert.deepEqual(mergeStudyTime(undefined, "2026-11-27", 15_000), [{ day: "2026-11-27", ms: 15_000 }]);
	});

	it("adds to the same day instead of appending a second entry", () => {
		const log = mergeStudyTime([{ day: "2026-11-27", ms: 15_000 }], "2026-11-27", 30_000);
		assert.deepEqual(log, [{ day: "2026-11-27", ms: 45_000 }]);
	});

	it("keeps days ascending and other days untouched", () => {
		const log = mergeStudyTime(
			[
				{ day: "2026-11-26", ms: 60_000 },
				{ day: "2026-11-28", ms: 5_000 },
			],
			"2026-11-27",
			10_000,
		);
		assert.deepEqual(
			log.map((entry) => entry.day),
			["2026-11-26", "2026-11-27", "2026-11-28"],
		);
	});
});

describe("totals", () => {
	const days = [
		{ day: "2026-11-25", ms: 60_000 },
		{ day: "2026-11-26", ms: 120_000 },
		{ day: "2026-11-27", ms: 30_000 },
	];

	it("studyTimeTotal folds every day", () => {
		assert.equal(studyTimeTotal(days), 210_000);
		assert.equal(studyTimeTotal(undefined), 0);
	});

	it("studyTimeBetween is inclusive on both ends", () => {
		assert.equal(studyTimeBetween(days, "2026-11-26", "2026-11-27"), 150_000);
		assert.equal(studyTimeBetween(days, "2026-11-27", "2026-11-27"), 30_000);
		assert.equal(studyTimeBetween(days, "2026-11-28", "2026-11-30"), 0);
	});
});

describe("studyWeekStartKey", () => {
	it("is the Monday of the local week", () => {
		const start = studyWeekStartKey(new Date(2026, 10, 27, 12));
		const [y, m, d] = start.split("-").map(Number);
		const date = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
		assert.equal(date.getDay(), 1, "Monday");
		assert.ok(date <= new Date(2026, 10, 27, 12));
		assert.equal(studyWeekStartKey(date), start, "every day of the week maps to the same Monday");
	});
});

describe("studyCalendar", () => {
	it("is 16 Monday-first weeks ending with today's week", () => {
		const today = new Date(2026, 10, 27, 9);
		const weeks = studyCalendar([], today);
		assert.equal(weeks.length, 16);
		assert.ok(weeks.every((week) => week.length === 7));
		const lastDay = weeks[15]?.[6]?.day;
		assert.equal(lastDay, studyDayKey(new Date(2026, 10, 29)), "the last column ends on that week's Sunday");
		assert.ok(weeks.flat().some((cell) => cell.day === studyDayKey(today)), "today is on the grid");
		for (const week of weeks) {
			const [y, m, d] = (week[0]?.day ?? "").split("-").map(Number);
			assert.equal(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getDay(), 1, "each column opens on a Monday");
		}
	});

	it("fills the entry's day and leaves the rest at zero", () => {
		const today = new Date(2026, 10, 27, 9);
		const key = studyDayKey(today);
		const weeks = studyCalendar([{ day: key, ms: 90_000 }], today);
		const cells = weeks.flat();
		assert.equal(cells.find((cell) => cell.day === key)?.ms, 90_000);
		assert.equal(cells.filter((cell) => cell.ms > 0).length, 1);
	});
});

describe("studyLevel", () => {
	it("uses the five fixed steps: none, <15m, <30m, <1h, 1h+", () => {
		assert.equal(studyLevel(0), 0);
		assert.equal(studyLevel(60_000), 1);
		assert.equal(studyLevel(15 * 60_000 - 1), 1);
		assert.equal(studyLevel(15 * 60_000), 2);
		assert.equal(studyLevel(30 * 60_000), 3);
		assert.equal(studyLevel(60 * 60_000), 4);
		assert.equal(studyLevel(5 * 60 * 60_000), 4);
	});
});

describe("presentation", () => {
	it("the live timer ticks: seconds, then minutes+seconds, then hours+minutes", () => {
		assert.equal(formatStudyTime(0), "0s");
		assert.equal(formatStudyTime(45_000), "45s");
		assert.equal(formatStudyTime(63_000), "1m 03s");
		assert.equal(formatStudyTime(65 * 60_000 + 30_000), "1h 05m");
	});

	it("static totals read in whole minutes, never a false 0s", () => {
		assert.equal(formatStudySpan(0), "0m");
		assert.equal(formatStudySpan(59_000), "0m");
		assert.equal(formatStudySpan(60_000), "1m");
		assert.equal(formatStudySpan(65 * 60_000 + 30_000), "1h 05m");
	});
});

describe("the owner's rules, pinned", () => {
	it("pauses after two minutes without input", () => {
		assert.equal(STUDY_IDLE_PAUSE_MS, 2 * 60_000);
	});

	it("refuses chunks above ten minutes", () => {
		assert.equal(MAX_STUDY_CHUNK_MS, 10 * 60_000);
	});
});