/**
 * Study time surfaces (issue #16): the tracker page's body, the session
 * row's time, and the study-box rows. Pure renders — SSR pins what the
 * learner sees, so the totals, the day squares and their intensity steps
 * cannot drift from the pure rules silently. Same tsx classic-JSX shim as
 * render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow } from "../components/sidebar.tsx";
import { StudySessionList } from "../components/study-session-list.tsx";
import { StudyTimeView } from "../components/study-time-view.tsx";
import { formatStudySpan, studyDayKey } from "../src/core/study-time.ts";
import type { ChatListItem, StudyTimeDay } from "../src/core/index.ts";

/** A fixed Friday — the current week opens on Monday the 23rd. */
const TODAY = new Date(2026, 10, 27, 9, 0, 0);
const TODAY_KEY = studyDayKey(TODAY);

function dayKey(offset: number): string {
	return studyDayKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

function chat(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "chat_fixture",
		title: "Session",
		kind: "teach",
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-27T00:00:00.000Z",
		messageCount: 4,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

const DAYS: StudyTimeDay[] = [
	{ day: dayKey(-10), ms: 2 * 60 * 60_000 }, // 2h, an earlier week
	{ day: dayKey(-1), ms: 15 * 60_000 }, // 15m, yesterday
	{ day: TODAY_KEY, ms: 30 * 60_000 }, // 30m today
];

describe("StudyTimeView", () => {
	it("shows today, this week and all-time totals from the same days", () => {
		const html = renderToStaticMarkup(<StudyTimeView days={DAYS} today={TODAY} />);
		const text = (testId: string) =>
			new RegExp(`data-testid="${testId}"[^>]*>([^<]+)<`).exec(html)?.[1];
		assert.equal(text("study-total-today"), "30m");
		assert.equal(text("study-total-week"), formatStudySpan(45 * 60_000), "today + yesterday, Monday-based week");
		assert.equal(text("study-total-all"), formatStudySpan(2 * 60 * 60_000 + 45 * 60_000));
	});

	it("renders one square per elapsed day, shaded by the fixed steps", () => {
		const html = renderToStaticMarkup(<StudyTimeView days={DAYS} today={TODAY} />);
		const cells = [...html.matchAll(/data-testid="study-day" data-day="([^"]+)" data-level="(\d)"/g)];
		assert.equal(cells.length, 16 * 7 - 2, "16 weeks minus the two future days of this week");
		const level = (day: string) => cells.find((cell) => cell[1] === day)?.[2];
		assert.equal(level(TODAY_KEY), "3", "30 minutes is the third step");
		assert.equal(level(dayKey(-1)), "2", "15 minutes is the second step");
		assert.equal(level(dayKey(-10)), "4", "2 hours is the top step");
		assert.equal(level(dayKey(-2)), "0", "a day with no time is the empty square");
		assert.ok(!cells.some((cell) => (cell[1] ?? "") > TODAY_KEY), "days after today are not drawn");
	});

	it("explains the reading rule once there is time counted", () => {
		const html = renderToStaticMarkup(<StudyTimeView days={DAYS} today={TODAY} />);
		assert.ok(html.includes("pauses after two minutes without input"));
		assert.ok(!html.includes("No study time counted yet."));
	});

	it("an empty tracker says how time starts instead of showing a false zero story", () => {
		const html = renderToStaticMarkup(<StudyTimeView days={[]} today={TODAY} />);
		assert.ok(html.includes("No study time counted yet."));
		assert.equal(new RegExp(`data-testid="study-total-all"[^>]*>([^<]+)<`).exec(html)?.[1], "0m");
	});
});

describe("study time in the lists", () => {
	it("a sidebar row shows the session's total beside its age", () => {
		const html = renderToStaticMarkup(
			<SessionRow chat={chat({ timeMs: 65 * 60_000 })} active={false} onOpen={() => {}} />,
		);
		assert.ok(html.includes("1h 05m"), "the session's counted time");
	});

	it("a row with no counted time stays quiet — no 0m noise", () => {
		const html = renderToStaticMarkup(<SessionRow chat={chat({})} active={false} onOpen={() => {}} />);
		assert.ok(!html.includes("0m"));
	});

	it("a study-box row shows its session's time", () => {
		const html = renderToStaticMarkup(
			<StudySessionList
				sessions={[{ id: "chat_b", title: "Second sitting", updatedAt: "2026-11-27T00:00:00.000Z", timeMs: 2 * 60 * 60_000 + 5 * 60_000 }]}
				newSession={{ label: "New session", onClick: () => {}, testId: "new-test-session" }}
			/>,
		);
		assert.ok(html.includes("2h 05m"));
		assert.ok(html.includes('href="/chat/chat_b"'));
	});
});