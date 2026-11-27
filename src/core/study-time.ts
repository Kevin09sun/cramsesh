/**
 * Study time (issue #16, owner-approved 2026-11-27) — the pure rules behind
 * the session clock and the sidebar's Study time tracker.
 *
 * THE OWNER'S RULE (approved 2026-11-27): time counts while the learner is
 * in a session. The clock starts at the first prompt/upload of a visit,
 * runs while the chat page is open and focused, pauses after two minutes
 * without input, and stops when the page is left. The browser counts it
 * (components/study-clock.ts), posts chunks to the server, and the server
 * merges them into the session record ONE ENTRY PER LOCAL CALENDAR DAY.
 *
 * Everything here is pure: day keys, chunk validation, the merge, the day
 * grid, the intensity steps and the presentation strings. The day is the
 * LEARNER's local calendar day — the client stamps it, because the server
 * may run in another timezone.
 */

import type { StudyTimeDay } from "./contracts/chat.ts";

/** The clock pauses after this long without learner input (keys, pointer,
 *  scrolling) — "pauses after 2 minutes with no activity" (owner, the
 *  approved plan). */
export const STUDY_IDLE_PAUSE_MS = 2 * 60_000;

/** How often the open chat page flushes counted time to the server. */
export const STUDY_FLUSH_MS = 15_000;

/** One chunk's ceiling. A heartbeat is seconds; anything larger is a buggy
 *  or forged client and is refused rather than written into the record. */
export const MAX_STUDY_CHUNK_MS = 10 * 60_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The local calendar day of `date` as YYYY-MM-DD. */
export function studyDayKey(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** A valid YYYY-MM-DD day key, or null — checks the calendar too, so
 *  "2026-02-31" is refused rather than stored as a phantom day. */
export function parseStudyDay(value: unknown): string | null {
	if (typeof value !== "string" || !DAY_PATTERN.test(value)) return null;
	const [y, m, d] = value.split("-").map(Number);
	if (y === undefined || m === undefined || d === undefined) return null;
	const date = new Date(y, m - 1, d);
	if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
	return value;
}

/** Validate one heartbeat body ({day, ms}) — null for anything malformed,
 *  non-positive, fractional or above the single-chunk ceiling. */
export function parseStudyChunk(body: unknown): StudyTimeDay | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
	const { day, ms } = body as { day?: unknown; ms?: unknown };
	const parsedDay = parseStudyDay(day);
	if (parsedDay === null) return null;
	if (typeof ms !== "number" || !Number.isFinite(ms) || !Number.isInteger(ms)) return null;
	if (ms <= 0 || ms > MAX_STUDY_CHUNK_MS) return null;
	return { day: parsedDay, ms };
}

/** Fold one chunk into the log: one entry per day, days ascending. Pure —
 *  the store persists the returned array. */
export function mergeStudyTime(
	log: readonly StudyTimeDay[] | undefined,
	day: string,
	ms: number,
): StudyTimeDay[] {
	const byDay = new Map<string, number>();
	for (const entry of log ?? []) byDay.set(entry.day, (byDay.get(entry.day) ?? 0) + entry.ms);
	byDay.set(day, (byDay.get(day) ?? 0) + ms);
	return [...byDay]
		.map(([key, total]) => ({ day: key, ms: total }))
		.sort((a, b) => a.day.localeCompare(b.day));
}

/** A session's counted total (the summary's timeMs). */
export function studyTimeTotal(log: readonly StudyTimeDay[] | undefined): number {
	let total = 0;
	for (const entry of log ?? []) total += entry.ms;
	return total;
}

/** Sum of the days in [fromDay, toDay], both inclusive day keys. */
export function studyTimeBetween(
	days: readonly StudyTimeDay[],
	fromDay: string,
	toDay: string,
): number {
	let total = 0;
	for (const entry of days) {
		if (entry.day >= fromDay && entry.day <= toDay) total += entry.ms;
	}
	return total;
}

/** The Monday of `today`'s local week, as a day key. */
export function studyWeekStartKey(today: Date): string {
	const mondayOffset = (today.getDay() + 6) % 7;
	return studyDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset));
}

/** The tracker's grid — `weeks` columns of 7 local days, Monday first,
 *  ending with the week that contains `today`. Days with no entry read as
 *  zero. Pure, so the page and its tests share one calendar. */
export function studyCalendar(
	days: readonly StudyTimeDay[],
	today: Date,
	weeks = 16,
): StudyTimeDay[][] {
	const byDay = new Map(days.map((entry) => [entry.day, entry.ms]));
	const mondayOffset = (today.getDay() + 6) % 7;
	const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset);
	const first = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - (weeks - 1) * 7);
	const grid: StudyTimeDay[][] = [];
	for (let w = 0; w < weeks; w += 1) {
		const column: StudyTimeDay[] = [];
		for (let d = 0; d < 7; d += 1) {
			const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + d);
			const key = studyDayKey(date);
			column.push({ day: key, ms: byDay.get(key) ?? 0 });
		}
		grid.push(column);
	}
	return grid;
}

/** Five intensity steps, fixed thresholds so the squares mean the same
 *  thing every day: none, under 15m, under 30m, under 1h, 1h or more. */
export function studyLevel(ms: number): 0 | 1 | 2 | 3 | 4 {
	if (ms <= 0) return 0;
	if (ms < 15 * 60_000) return 1;
	if (ms < 30 * 60_000) return 2;
	if (ms < 60 * 60_000) return 3;
	return 4;
}

/** The live session timer: seconds under a minute, minutes+seconds under an
 *  hour, hours+minutes above. Ticks, so the learner can see it running. */
export function formatStudyTime(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Static totals (tracker cards, session rows, test pages): whole minutes,
 *  hours+minutes above an hour, "0m" for none — never a false "0s". */
export function formatStudySpan(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}