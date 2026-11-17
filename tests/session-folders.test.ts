/**
 * SIDEBAR SESSION FOLDERS (2026-11-17): the pure grouping core. Tests and AP
 * sessions fold into per-test / per-course folders; everything else stays in
 * the flat list. This module is pure — no React, no I/O — so the tests build
 * ChatListItem fixtures directly and pass chats in the route's newest-first
 * order.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	groupSessions,
	openFolderKeys,
	parseOpenKeys,
	walkOrder,
	type FolderNames,
	type SessionTree,
} from "../src/core/session-folders.ts";
import type { ChatListItem } from "../src/core/contracts.ts";

let seq = 0;
function chat(overrides: Partial<ChatListItem> & { id: string }): ChatListItem {
	const n = seq++;
	return {
		title: overrides.id,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
		kind: "teach",
		messageCount: 0,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

function names(tests: Record<string, string> = {}, ap: Record<string, string> = {}): FolderNames {
	return { tests, ap };
}

function keys(tree: SessionTree): string[] {
	return [...tree.tests, ...tree.ap].map((f) => f.key);
}

describe("groupSessions", () => {
	it("groups testprep by testId and AP (kind ap or any apCourseId) by course; others stay flat", () => {
		const chats = [
			chat({ id: "a2", kind: "ap", apCourseId: "c2" }),
			chat({ id: "t2", kind: "testprep", testId: "tB" }),
			chat({ id: "t1", kind: "testprep", testId: "tA" }),
			chat({ id: "a1", kind: "ap", apCourseId: "c1" }),
			// A teach session carrying a course id (the Learn entry point) joins AP.
			chat({ id: "learn", kind: "teach", apCourseId: "c1" }),
			chat({ id: "p1", kind: "practice" }),
			chat({ id: "teach1" }),
		];
		const tree = groupSessions(chats, names({ tA: "SAT Math", tB: "ACT Math" }, { c1: "AP Biology", c2: "AP Chemistry" }));

		assert.deepEqual(
			tree.tests.map((f) => f.id),
			["tB", "tA"],
		);
		assert.deepEqual(
			tree.ap.map((f) => f.id),
			["c2", "c1"],
		);
		assert.deepEqual(
			tree.ap[1]!.sessions.map((s) => s.id),
			["a1", "learn"],
		);
		assert.deepEqual(
			tree.flat.map((s) => s.id),
			["p1", "teach1"],
		);
	});

	it("puts a missing id in the section's Unfiled folder, last and named Unfiled", () => {
		const chats = [
			chat({ id: "unfiledTest", kind: "testprep" }),
			chat({ id: "t1", kind: "testprep", testId: "tA" }),
			chat({ id: "unfiledAp", kind: "ap" }),
			chat({ id: "a1", kind: "ap", apCourseId: "c1" }),
		];
		const tree = groupSessions(chats, names({ tA: "SAT Math" }, { c1: "AP Biology" }));

		assert.deepEqual(keys(tree), ["tests:tA", "tests:unfiled", "ap:c1", "ap:unfiled"]);
		assert.equal(tree.tests[1]!.name, "Unfiled");
		assert.equal(tree.tests[1]!.id, null);
		assert.deepEqual(tree.tests[1]!.sessions.map((s) => s.id), ["unfiledTest"]);
		assert.equal(tree.ap[1]!.name, "Unfiled");
		assert.equal(tree.ap[1]!.id, null);
		assert.deepEqual(tree.ap[1]!.sessions.map((s) => s.id), ["unfiledAp"]);
	});

	it("names an unknown id Untitled test / Untitled course but keeps its folder", () => {
		const chats = [
			chat({ id: "t1", kind: "testprep", testId: "tUnknown" }),
			chat({ id: "a1", kind: "ap", apCourseId: "cUnknown" }),
		];
		const tree = groupSessions(chats, names());

		assert.equal(tree.tests[0]!.key, "tests:tUnknown");
		assert.equal(tree.tests[0]!.name, "Untitled test");
		assert.equal(tree.ap[0]!.key, "ap:cUnknown");
		assert.equal(tree.ap[0]!.name, "Untitled course");
	});

	it("orders folders by their first (newest) session and keeps sessions in input order", () => {
		const chats = [
			chat({ id: "t2", kind: "testprep", testId: "tB" }),
			chat({ id: "t1", kind: "testprep", testId: "tA" }),
			chat({ id: "t1b", kind: "testprep", testId: "tA" }),
			chat({ id: "t3", kind: "testprep", testId: "tB" }),
		];
		const tree = groupSessions(chats, names({ tA: "A", tB: "B" }));

		assert.deepEqual(
			tree.tests.map((f) => f.key),
			["tests:tB", "tests:tA"],
		);
		assert.deepEqual(tree.tests[0]!.sessions.map((s) => s.id), ["t2", "t3"]);
		assert.deepEqual(tree.tests[1]!.sessions.map((s) => s.id), ["t1", "t1b"]);
	});
});

describe("openFolderKeys", () => {
	it("keeps stored keys and adds the folder holding the current chat", () => {
		const tree = groupSessions(
			[
				chat({ id: "t1", kind: "testprep", testId: "tA" }),
				chat({ id: "a1", kind: "ap", apCourseId: "c1" }),
			],
			names({ tA: "A" }, { c1: "C" }),
		);

		const open = openFolderKeys(tree, new Set(["tests:tA", "collapsed:ap"]), {
			searching: false,
			currentChatId: "a1",
		});

		assert.ok(open.has("tests:tA"), "stored folder key kept");
		assert.ok(open.has("collapsed:ap"), "stored collapse key kept");
		assert.ok(open.has("ap:c1"), "the current chat's folder is open");
		assert.equal(open.has("tests:unfiled"), false);
	});

	it("opens every folder in the tree while searching", () => {
		const tree = groupSessions(
			[
				chat({ id: "t1", kind: "testprep", testId: "tA" }),
				chat({ id: "u", kind: "testprep" }),
				chat({ id: "a1", kind: "ap", apCourseId: "c1" }),
				chat({ id: "au", kind: "ap" }),
			],
			names({ tA: "A" }, { c1: "C" }),
		);

		const open = openFolderKeys(tree, new Set(), { searching: true, currentChatId: null });

		assert.deepEqual([...open].sort(), ["ap:c1", "ap:unfiled", "tests:tA", "tests:unfiled"]);
	});

	it("neutralizes persisted section collapses while searching, so matches are walked", () => {
		const tree = groupSessions([chat({ id: "a1", kind: "ap", apCourseId: "c1" })], names({}, { c1: "C" }));
		const stored = new Set(["collapsed:ap", "ap:c1"]);

		const open = openFolderKeys(tree, stored, { searching: true, currentChatId: null });

		assert.equal(open.has("collapsed:ap"), false);
		assert.deepEqual(
			walkOrder(tree, open).map((c) => c.id),
			["a1"],
		);
		assert.ok(stored.has("collapsed:ap"), "the stored set is untouched");
	});

	it("keeps a persisted section collapse when not searching", () => {
		const tree = groupSessions([chat({ id: "a1", kind: "ap", apCourseId: "c1" })], names({}, { c1: "C" }));
		const open = openFolderKeys(tree, new Set(["collapsed:ap"]), { searching: false, currentChatId: null });
		assert.ok(open.has("collapsed:ap"));
	});

	it("opens the Unfiled folder holding the current chat", () => {
		const tree = groupSessions([chat({ id: "au", kind: "ap" })], names());
		const open = openFolderKeys(tree, new Set(), { searching: false, currentChatId: "au" });
		assert.ok(open.has("ap:unfiled"));
	});
});

describe("walkOrder", () => {
	function tree(): SessionTree {
		return groupSessions(
			[
				chat({ id: "t1", kind: "testprep", testId: "tA" }),
				chat({ id: "t1b", kind: "testprep", testId: "tA" }),
				chat({ id: "t2", kind: "testprep", testId: "tB" }),
				chat({ id: "a1", kind: "ap", apCourseId: "c1" }),
				chat({ id: "p1", kind: "practice" }),
				chat({ id: "teach1" }),
			],
			names({ tA: "A", tB: "B" }, { c1: "C" }),
		);
	}

	it("walks open folders (tests then ap, folder order) before the flat list", () => {
		const order = walkOrder(tree(), new Set(["tests:tA", "ap:c1"]));
		assert.deepEqual(order.map((c) => c.id), ["t1", "t1b", "a1", "p1", "teach1"]);
	});

	it("skips closed folders", () => {
		const order = walkOrder(tree(), new Set(["tests:tA"]));
		assert.deepEqual(order.map((c) => c.id), ["t1", "t1b", "p1", "teach1"]);
	});

	it("skips a whole section when its collapse key is in the open set", () => {
		assert.deepEqual(
			walkOrder(tree(), new Set(["tests:tA", "ap:c1", "collapsed:tests"])).map((c) => c.id),
			["a1", "p1", "teach1"],
		);
		assert.deepEqual(
			walkOrder(tree(), new Set(["tests:tA", "ap:c1", "collapsed:ap"])).map((c) => c.id),
			["t1", "t1b", "p1", "teach1"],
		);
	});
});

describe("parseOpenKeys", () => {
	it("reads a JSON array of strings and treats malformed input as empty", () => {
		for (const raw of [null, "not json", "{}", "[1,2]", '["ok",3]']) {
			assert.deepEqual([...parseOpenKeys(raw)], [], String(raw));
		}
		assert.deepEqual([...parseOpenKeys('["ap:c1"]')], ["ap:c1"]);
	});
});
