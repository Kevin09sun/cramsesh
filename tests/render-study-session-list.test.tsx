/**
 * Study boxes (2026-11-17): the Sessions block on a test or course page and
 * the "+ New" link in the Tests/AP list headers. Pure renders, so SSR pins
 * the rows, their order, the empty state and the button. Same tsx
 * classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewCourseLink, NewTestLink, StudySessionList } from "../components/study-session-list.tsx";
import { timeAgo } from "../components/sidebar.tsx";

const newSession = { label: "New session", onClick: () => {}, testId: "new-test-session" };

describe("StudySessionList", () => {
	it("renders one row per session, linking to its chat, in the given order", () => {
		const sessions = [
			{ id: "chat_b", title: "Second sitting", updatedAt: "2026-11-17T10:00:00.000Z" },
			{ id: "chat_a", title: "First sitting", updatedAt: "2026-11-16T10:00:00.000Z" },
		];
		const html = renderToStaticMarkup(<StudySessionList sessions={sessions} newSession={newSession} />);

		assert.ok(html.includes('data-testid="study-sessions"'));
		assert.ok(html.includes(">Sessions<"), "the heading reads Sessions");
		const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
		assert.deepEqual(hrefs, ["/chat/chat_b", "/chat/chat_a"]);
		assert.ok(html.includes('data-testid="study-session-chat_b"'));
		assert.ok(html.includes('data-testid="study-session-chat_a"'));
		assert.ok(html.indexOf("Second sitting") < html.indexOf("First sitting"));
		assert.ok(html.includes(timeAgo("2026-11-17T10:00:00.000Z")), "each row shows a relative age");
		assert.ok(!html.includes("No sessions yet."));
	});

	it("shows the empty state when there are no sessions", () => {
		const html = renderToStaticMarkup(<StudySessionList sessions={[]} newSession={newSession} />);
		assert.ok(html.includes("No sessions yet."));
		assert.ok(!html.includes("/chat/"));
	});

	it("renders the New button with the given test id and label", () => {
		const html = renderToStaticMarkup(
			<StudySessionList
				sessions={[]}
				newSession={{ label: "New session", onClick: () => {}, testId: "new-course-session" }}
			/>,
		);
		const button = /<button[^>]*data-testid="new-course-session"[^>]*>([^<]*)<\/button>/.exec(html);
		assert.ok(button, "the button carries the given test id");
		assert.equal(button![1], "New session");
	});

	it("a disabled New button renders disabled", () => {
		const html = renderToStaticMarkup(
			<StudySessionList sessions={[]} newSession={{ ...newSession, disabled: true }} />,
		);
		assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="new-test-session"|<button[^>]*data-testid="new-test-session"[^>]*disabled=""/);
	});
});

describe("list-page New links", () => {
	it("the Tests header link starts a test prep session", () => {
		const html = renderToStaticMarkup(<NewTestLink />);
		assert.match(html, /<a[^>]*href="\/chat\/new\?mode=testprep"[^>]*>\+ New test<\/a>/);
		assert.ok(html.includes('data-testid="new-test"'));
	});

	it("the AP header link starts an AP session", () => {
		const html = renderToStaticMarkup(<NewCourseLink />);
		assert.match(html, /<a[^>]*href="\/chat\/new\?mode=ap"[^>]*>\+ New course<\/a>/);
		assert.ok(html.includes('data-testid="new-course"'));
	});
});
