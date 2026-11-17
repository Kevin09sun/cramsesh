/**
 * SIDEBAR SESSION FOLDERS (2026-11-17): the folder tree's render seam. The
 * tree is a pure function of the grouped sessions and the effective open
 * set, so SSR pins every visible state: the /tests and /ap section
 * headings, closed and open folders, and each folder's + affordance.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionFolderTree, withCurrentFolderOpen } from "../components/session-folders.tsx";
import { groupSessions, type SessionTree } from "../src/core/session-folders.ts";
import type { ChatListItem } from "../src/core/contracts.ts";

function chat(overrides: Partial<ChatListItem> & { id: string }): ChatListItem {
	return {
		title: `Session ${overrides.id}`,
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 2,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

const TREE: SessionTree = groupSessions(
	[
		chat({ id: "s1", kind: "testprep", testId: "t1" }),
		chat({ id: "s2", kind: "testprep", testId: "t1" }),
		chat({ id: "s3", kind: "testprep" }),
		chat({ id: "s4", kind: "ap", apCourseId: "c1" }),
		chat({ id: "s5", kind: "ap" }),
		chat({ id: "s6" }),
	],
	{ tests: { t1: "Chem midterm" }, ap: { c1: "AP Biology" } },
);

function render(tree: SessionTree, open: ReadonlySet<string> = new Set()) {
	return renderToStaticMarkup(
		<SessionFolderTree
			tree={tree}
			open={open}
			onToggle={() => {}}
			activeId={null}
			kbdId={null}
			onNewTestSession={() => {}}
		/>,
	);
}

function tagFor(html: string, testid: string): string {
	return html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? "";
}

describe("SessionFolderTree", () => {
	it("both section headings link to /tests and /ap", () => {
		const html = render(TREE);
		const tests = tagFor(html, "folder-section-tests");
		const ap = tagFor(html, "folder-section-ap");
		assert.match(tests, /^<a /);
		assert.match(tests, /href="\/tests"/);
		assert.match(ap, /^<a /);
		assert.match(ap, /href="\/ap"/);
	});

	it("a closed folder shows its name and count, with no session rows", () => {
		const html = render(TREE);
		const folder = tagFor(html, "folder-tests:t1");
		assert.match(folder, /^<button /, "the folder row is a toggle button");
		assert.match(html, /Chem midterm/);
		assert.match(html, /data-testid="folder-tests:t1"[^]*?>2</, "the session count");
		assert.doesNotMatch(html, /data-testid="session-row"/, "closed folders hide their sessions");
		assert.doesNotMatch(html, /Session s1/);
	});

	it("an open folder shows its session rows", () => {
		const html = render(TREE, new Set(["tests:t1"]));
		assert.equal((html.match(/data-testid="session-row"/g) ?? []).length, 2);
		assert.match(html, /Session s1/);
		assert.match(html, /Session s2/);
		assert.doesNotMatch(html, /Session s4/, "other folders stay closed");
	});

	it("a Tests folder's + is a button", () => {
		const html = render(TREE);
		assert.match(tagFor(html, "folder-new-tests:t1"), /^<button /);
	});

	it("an AP folder's + links to /ap/c1", () => {
		const html = render(TREE);
		const plus = tagFor(html, "folder-new-ap:c1");
		assert.match(plus, /^<a /);
		assert.match(plus, /href="\/ap\/c1"/);
	});

	it("an Unfiled folder has no +", () => {
		const html = render(TREE);
		assert.ok(html.includes('data-testid="folder-tests:unfiled"'));
		assert.ok(html.includes('data-testid="folder-ap:unfiled"'));
		assert.doesNotMatch(html, /folder-new-tests:unfiled/);
		assert.doesNotMatch(html, /folder-new-ap:unfiled/);
	});

	it("an empty section, with no folders, still renders its heading", () => {
		const html = render(groupSessions([chat({ id: "x" })], { tests: {}, ap: {} }));
		assert.match(tagFor(html, "folder-section-tests"), /href="\/tests"/);
		assert.match(tagFor(html, "folder-section-ap"), /href="\/ap"/);
		assert.doesNotMatch(html, /data-testid="folder-(tests|ap):/);
	});

	it("a collapsed section hides its folders but keeps its heading", () => {
		const html = render(TREE, new Set(["collapsed:tests", "tests:t1"]));
		assert.ok(html.includes('data-testid="folder-section-tests"'));
		assert.doesNotMatch(html, /data-testid="folder-tests:/);
		assert.doesNotMatch(html, /Session s1/);
		assert.ok(html.includes('data-testid="folder-ap:c1"'), "the other section is unaffected");
	});
});

describe("SessionFolderTree while searching (toggleDisabled)", () => {
	it("folder toggles and section chevrons render disabled", () => {
		const html = renderToStaticMarkup(
			<SessionFolderTree
				tree={TREE}
				open={new Set(["tests:t1", "tests:unfiled", "ap:c1", "ap:unfiled"])}
				onToggle={() => {}}
				activeId={null}
				kbdId={null}
				onNewTestSession={() => {}}
				toggleDisabled
			/>,
		);
		for (const id of ["folder-collapse-tests", "folder-collapse-ap", "folder-tests:t1", "folder-tests:unfiled", "folder-ap:c1", "folder-ap:unfiled"]) {
			const tag = tagFor(html, id);
			assert.match(tag, /^<button /, id);
			assert.match(tag, / disabled=""/, `${id} is disabled`);
			assert.match(tag, /aria-disabled="true"/, `${id} is aria-disabled`);
		}
		assert.doesNotMatch(tagFor(html, "folder-new-tests:t1"), / disabled=""|aria-disabled="true"/, "the + stays usable");
	});

	it("outside a search the toggles are enabled", () => {
		const html = render(TREE);
		for (const id of ["folder-collapse-tests", "folder-tests:t1"]) {
			assert.doesNotMatch(tagFor(html, id), / disabled=""|aria-disabled="true"/, id);
		}
	});
});

describe("withCurrentFolderOpen — the one-time auto-open", () => {
	it("adds the current chat's folder key to the stored set", () => {
		const stored = new Set(["collapsed:ap"]);
		const next = withCurrentFolderOpen(stored, TREE, "s2");
		assert.deepEqual([...next].sort(), ["collapsed:ap", "tests:t1"]);
		assert.deepEqual([...stored], ["collapsed:ap"], "the input is not mutated");
		assert.deepEqual([...withCurrentFolderOpen(new Set(), TREE, "s5")], ["ap:unfiled"]);
	});

	it("returns the same contents when the key is already present", () => {
		const next = withCurrentFolderOpen(new Set(["tests:t1"]), TREE, "s1");
		assert.deepEqual([...next], ["tests:t1"]);
	});

	it("returns the same contents for a flat-list chat, an unknown chat, or no chat", () => {
		for (const id of ["s6", "nope", null]) {
			assert.deepEqual([...withCurrentFolderOpen(new Set(["ap:c1"]), TREE, id)], ["ap:c1"], String(id));
		}
	});
});
