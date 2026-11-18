/**
 * The shared session context menu (study boxes, 2026-11-17): the sidebar's
 * right-click menu — Rename / Export as Markdown / Delete, then the coverage
 * block — now also rides the session rows on a test or course page. Pins:
 *   - the pure pieces: item order + test ids, the export href, renameSession
 *     (trim, empty = discard, PUT body, lh:chat-renamed, failure throws);
 *   - StudySessionList wiring (linkedom): right-clicking a row opens the
 *     menu; Rename swaps the row to an input whose commit PUTs the title and
 *     calls onSessionsChanged; Delete opens the dialog whose confirm DELETEs,
 *     announces the graph revision and calls onSessionsChanged — without
 *     navigating.
 *
 * tsx uses the CLASSIC JSX transform: React must be a resolvable global
 * before this module's JSX runs (the render-cards shim), and linkedom gives
 * createRoot a document (the chatgpt-ui shim).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
	SESSION_MENU_ITEM_IDS,
	SessionMenuItems,
	renameSession,
	sessionMarkdownHref,
} from "../components/session-context-menu.tsx";
import { StudySessionList } from "../components/study-session-list.tsx";

const dom = parseHTML("<html><body></body></html>");
dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
	({ x: 100, y: 100, left: 100, right: 300, top: 100, bottom: 130, width: 200, height: 30, toJSON() {} }) as DOMRect;
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	innerWidth: 1000,
	innerHeight: 800,
	// next/link's idle-callback fallback reads `self` (the Sessions rows are Links).
	self: globalThis,
});
Object.assign(dom.window, { innerWidth: 1000, innerHeight: 800 });
// linkedom lacks rAF (MenuShell's placement) and input.select() (the rename
// input's select-all on entry).
Object.assign(globalThis, {
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom.window.HTMLInputElement.prototype as { select?: () => void }).select ??= () => {};
// React feature-detects the input event via `"oninput" in document`.
Object.assign(dom.document, { oninput: null });
// linkedom reports a type-less <input> as type null; browsers say "text"
// (React only treats text-like inputs as change-event inputs).
const inputType = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "type")!;
Object.defineProperty(dom.window.HTMLInputElement.prototype, "type", {
	...inputType,
	get(this: HTMLInputElement) {
		return inputType.get!.call(this) ?? "text";
	},
});

const originalFetch = globalThis.fetch;

describe("session menu — pure pieces", () => {
	it("lists Rename, Export as Markdown, Delete — the destructive action last", () => {
		const html = renderToStaticMarkup(<SessionMenuItems onRename={() => {}} onExport={() => {}} onDelete={() => {}} />);
		const ids = [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(ids, [...SESSION_MENU_ITEM_IDS]);
		assert.deepEqual(SESSION_MENU_ITEM_IDS, ["ctx-rename", "ctx-export-md", "ctx-delete"]);
		assert.ok(html.indexOf("Rename") < html.indexOf("Export as Markdown") && html.indexOf("Export as Markdown") < html.indexOf("Delete"));
	});

	it("exports through the session-markdown route", () => {
		assert.equal(sessionMarkdownHref("chat_a"), "/api/chats/chat_a/markdown");
	});

	it("renameSession: an empty (trimmed) title is discarded without a request", async () => {
		let calls = 0;
		const t = await renameSession("chat_a", "   ", (async () => {
			calls++;
			return Response.json({});
		}) as typeof fetch);
		assert.equal(t, null);
		assert.equal(calls, 0);
	});

	it("renameSession: PUTs the trimmed title and announces lh:chat-renamed", async () => {
		const seen: { url: string; init?: RequestInit }[] = [];
		const heard: unknown[] = [];
		const listener = (e: Event) => heard.push((e as CustomEvent).detail);
		window.addEventListener("lh:chat-renamed", listener);
		try {
			const t = await renameSession("chat_a", "  New name ", (async (url: string, init?: RequestInit) => {
				seen.push({ url, init });
				return Response.json({ ok: true });
			}) as typeof fetch);
			assert.equal(t, "New name");
		} finally {
			window.removeEventListener("lh:chat-renamed", listener);
		}
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.url, "/api/chats/chat_a");
		assert.equal(seen[0]!.init?.method, "PUT");
		assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)), { title: "New name" });
		assert.deepEqual(heard, [{ id: "chat_a", title: "New name" }]);
	});

	it("renameSession: a failed write throws and announces nothing", async () => {
		const heard: unknown[] = [];
		const listener = (e: Event) => heard.push((e as CustomEvent).detail);
		window.addEventListener("lh:chat-renamed", listener);
		try {
			await assert.rejects(renameSession("chat_a", "x", (async () => new Response("no", { status: 500 })) as typeof fetch));
		} finally {
			window.removeEventListener("lh:chat-renamed", listener);
		}
		assert.deepEqual(heard, []);
	});
});

describe("StudySessionList — the row menu", () => {
	let root: Root | undefined;
	let host: HTMLDivElement | undefined;

	afterEach(async () => {
		await act(async () => root?.unmount());
		host?.remove();
		root = undefined;
		globalThis.fetch = originalFetch;
	});

	const sessions = [
		{ id: "chat_b", title: "Second sitting", updatedAt: "2026-11-17T10:00:00.000Z" },
		{ id: "chat_a", title: "First sitting", updatedAt: "2026-11-16T10:00:00.000Z" },
	];

	async function mount() {
		const seen: { url: string; method: string; body?: unknown }[] = [];
		let changed = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			seen.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
			if (method === "GET") return new Response("not found", { status: 404 }); // coverage: the block renders nothing
			if (method === "PUT") return Response.json({ ok: true });
			if (method === "DELETE") return Response.json({ ok: true, graphRevision: 7 });
			throw new Error(`unexpected ${method} ${url}`);
		}) as typeof fetch;
		host = document.createElement("div");
		document.body.append(host);
		// Loaded after the DOM globals: react-dom/client feature-detects the
		// input event once, at module load.
		const { createRoot } = await import("react-dom/client");
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<StudySessionList
					sessions={sessions}
					newSession={{ label: "New session", onClick: () => {}, testId: "new-test-session" }}
					onSessionsChanged={() => changed++}
				/>,
			);
		});
		return { seen, changes: () => changed };
	}

	const q = (testid: string) => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

	async function rightClick(el: HTMLElement) {
		const ev = new dom.window.Event("contextmenu", { bubbles: true, cancelable: true });
		await act(async () => {
			el.dispatchEvent(ev);
		});
		return ev;
	}

	async function click(el: HTMLElement) {
		await act(async () => {
			el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});
	}

	it("right-clicking a row opens the sidebar's session menu (native menu suppressed)", async () => {
		await mount();
		assert.equal(q("session-context-menu"), null);
		const ev = await rightClick(q("study-session-chat_a")!);
		assert.equal(ev.defaultPrevented, true, "the native menu is suppressed");
		const menu = q("session-context-menu");
		assert.ok(menu, "the menu opens");
		const ids = [...menu!.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"));
		assert.deepEqual(ids, [...SESSION_MENU_ITEM_IDS]);
	});

	it("Rename swaps the row to an input; the commit PUTs the title and refreshes the box", async () => {
		const { seen, changes } = await mount();
		await rightClick(q("study-session-chat_a")!);
		await click(q("ctx-rename")!);
		assert.equal(q("session-context-menu"), null, "the menu closes");
		const input = q("session-rename-input") as HTMLInputElement | null;
		assert.ok(input, "the row becomes a rename input");
		assert.equal(input!.value, "First sitting");
		assert.equal(q("study-session-chat_a"), null, "the link row is swapped out");

		await act(async () => {
			Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed sitting");
			input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		await act(async () => {
			input!.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
		});

		const put = seen.find((r) => r.method === "PUT");
		assert.deepEqual(put, { url: "/api/chats/chat_a", method: "PUT", body: { title: "Renamed sitting" } });
		assert.equal(changes(), 1, "onSessionsChanged refetches the server-rendered box");
		assert.ok(q("study-session-chat_a"), "the link row is back");
	});

	it("Delete opens the dialog; confirming DELETEs, announces the graph revision and refreshes the box", async () => {
		const { seen, changes } = await mount();
		const revisions: unknown[] = [];
		const onRevision = (e: Event) => revisions.push((e as CustomEvent).detail);
		window.addEventListener("lh:graph-revision", onRevision);
		try {
			await rightClick(q("study-session-chat_b")!);
			await click(q("ctx-delete")!);
			assert.equal(q("session-context-menu"), null, "the menu closes");
			assert.ok(q("delete-session-dialog"), "the delete dialog opens");
			assert.match(q("session-name-code")!.textContent ?? "", /Second sitting/);
			await click(q("delete-confirm")!);
		} finally {
			window.removeEventListener("lh:graph-revision", onRevision);
		}
		const del = seen.find((r) => r.method === "DELETE");
		assert.equal(del?.url, "/api/chats/chat_b?mode=preserve-graph");
		assert.deepEqual(revisions, [{ revision: 7 }]);
		assert.equal(changes(), 1, "onSessionsChanged refetches the server-rendered box");
		assert.equal(q("delete-session-dialog"), null, "the dialog closes");
	});

	it("Esc closes the menu", async () => {
		await mount();
		await rightClick(q("study-session-chat_a")!);
		assert.ok(q("session-context-menu"));
		await act(async () => {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(ev, { key: "Escape" });
			document.dispatchEvent(ev);
		});
		assert.equal(q("session-context-menu"), null);
	});
});
