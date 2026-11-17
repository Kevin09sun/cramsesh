/**
 * Sidebar session folders (2026-11-17): the pure grouping core for the
 * session list. Test prep sessions fold under their test record, AP sessions
 * (kind "ap", plus any session carrying an apCourseId — the Learn entry
 * point) under their course record; every other session stays in the flat
 * list. No React, no I/O — the route supplies names, the shell supplies the
 * stored open set.
 */

import type { ChatListItem } from "./contracts.ts";

export type FolderSection = "tests" | "ap";

/** id → record title, as the GET /api/chats response carries it. */
export interface FolderNames {
	tests: Record<string, string>;
	ap: Record<string, string>;
}

export interface SessionFolder {
	/** "tests:<id>" | "ap:<id>" | "tests:unfiled" | "ap:unfiled" */
	key: string;
	section: FolderSection;
	/** null = Unfiled */
	id: string | null;
	/** record title | "Untitled test" | "Untitled course" | "Unfiled" */
	name: string;
	sessions: ChatListItem[];
}

export interface SessionTree {
	tests: SessionFolder[];
	ap: SessionFolder[];
	/** Sessions that belong to no folder, in input order. */
	flat: ChatListItem[];
}

const COLLAPSED_TESTS = "collapsed:tests";
const COLLAPSED_AP = "collapsed:ap";

/** Group the newest-first chat list into folders. Folder order is first
 *  (newest) encounter; sessions keep input order; each section's Unfiled
 *  folder goes last. */
export function groupSessions(chats: ChatListItem[], names: FolderNames): SessionTree {
	const tests: SessionFolder[] = [];
	const ap: SessionFolder[] = [];
	const flat: ChatListItem[] = [];
	const testByKey = new Map<string, SessionFolder>();
	const apByKey = new Map<string, SessionFolder>();

	for (const chat of chats) {
		if (chat.kind === "testprep") {
			const id = chat.testId ?? null;
			const key = id === null ? "tests:unfiled" : `tests:${id}`;
			let folder = testByKey.get(key);
			if (!folder) {
				folder = {
					key,
					section: "tests",
					id,
					name: id === null ? "Unfiled" : (names.tests[id] ?? "Untitled test"),
					sessions: [],
				};
				testByKey.set(key, folder);
				tests.push(folder);
			}
			folder.sessions.push(chat);
		} else if (chat.kind === "ap" || chat.apCourseId !== undefined) {
			const id = chat.apCourseId ?? null;
			const key = id === null ? "ap:unfiled" : `ap:${id}`;
			let folder = apByKey.get(key);
			if (!folder) {
				folder = {
					key,
					section: "ap",
					id,
					name: id === null ? "Unfiled" : (names.ap[id] ?? "Untitled course"),
					sessions: [],
				};
				apByKey.set(key, folder);
				ap.push(folder);
			}
			folder.sessions.push(chat);
		} else {
			flat.push(chat);
		}
	}

	return { tests: unfiledLast(tests), ap: unfiledLast(ap), flat };
}

/** Unfiled sorts last in its section, wherever its first session appeared. */
function unfiledLast(folders: SessionFolder[]): SessionFolder[] {
	const unfiled = folders.find((f) => f.id === null);
	return unfiled ? [...folders.filter((f) => f !== unfiled), unfiled] : folders;
}

/** The folders to render open: the stored set (folders and section-collapse
 *  keys) plus the current chat's folder; a search opens every folder AND
 *  neutralizes the persisted section collapses — a match in a collapsed
 *  section must be shown and walked. The stored set is untouched, so the
 *  user's collapse returns when search clears. */
export function openFolderKeys(
	tree: SessionTree,
	stored: ReadonlySet<string>,
	opts: { searching: boolean; currentChatId: string | null },
): Set<string> {
	const open = new Set(stored);
	if (opts.searching) {
		open.delete(COLLAPSED_TESTS);
		open.delete(COLLAPSED_AP);
		for (const folder of [...tree.tests, ...tree.ap]) open.add(folder.key);
	} else if (opts.currentChatId !== null) {
		const id = opts.currentChatId;
		const current = [...tree.tests, ...tree.ap].find((f) => f.sessions.some((s) => s.id === id));
		if (current) open.add(current.key);
	}
	return open;
}

/** The rendered order: sessions of open folders (tests section, then ap;
 *  folder order), then the flat list. A section's collapse key skips the
 *  whole section. */
export function walkOrder(tree: SessionTree, open: ReadonlySet<string>): ChatListItem[] {
	const order: ChatListItem[] = [];
	if (!open.has(COLLAPSED_TESTS)) {
		for (const folder of tree.tests) if (open.has(folder.key)) order.push(...folder.sessions);
	}
	if (!open.has(COLLAPSED_AP)) {
		for (const folder of tree.ap) if (open.has(folder.key)) order.push(...folder.sessions);
	}
	order.push(...tree.flat);
	return order;
}

/** Persisted open-set JSON → keys. Anything but an array of strings is empty. */
export function parseOpenKeys(raw: string | null): Set<string> {
	if (raw === null) return new Set();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return new Set();
	}
	if (!Array.isArray(parsed) || !parsed.every((key): key is string => typeof key === "string")) return new Set();
	return new Set(parsed);
}
