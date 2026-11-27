/**
 * The cheat sheet page (issue #15): the paper document render, the build and
 * rebuild actions, and the readiness page's entry button.
 *
 * tsx uses the CLASSIC JSX transform: React must be a resolvable global
 * before this module's JSX runs (the render-cards shim), and linkedom gives
 * createRoot a document (the chatgpt-ui shim).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CheatSheetArticle, CheatSheetView, sheetDate } from "../components/test-prep/cheat-sheet-view.tsx";
import { ReadinessView } from "../components/test-prep/readiness-view.tsx";
import type { CheatSheet, TestRecord } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function unmount() {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
}

afterEach(async () => {
	await unmount();
	globalThis.fetch = originalFetch;
});

const SHEET: CheatSheet = {
	generatedAt: "2026-11-27T10:00:00.000Z",
	intro: "The one page for the midterm.",
	sections: [
		{
			id: "section_1",
			title: "Membranes & transport",
			idea: "The membrane decides what crosses and how fast.",
			facts: [
				{ label: "Diffusion", body: "Net movement down a concentration gradient." },
				{ label: "", body: "Osmosis is water across a semipermeable membrane." },
			],
			formulas: ["water potential = Ψs + Ψp"],
			trap: "Do not call facilitated diffusion active transport.",
			source: "notes.pdf p. 3 · slides.pptx slide 2",
		},
		{
			id: "section_2",
			title: "Enzymes",
			idea: "Enzymes lower the barrier, never the energy change.",
			facts: [{ label: "Catalyst", body: "Lowers activation energy without being consumed." }],
			formulas: [],
			source: "slides.pptx slide 4",
		},
	],
};

function record(overrides: Partial<TestRecord> = {}): TestRecord {
	return {
		id: "test_1",
		title: "Bio midterm",
		createdAt: "2026-11-27T09:00:00.000Z",
		updatedAt: "2026-11-27T09:00:00.000Z",
		planConfirmed: true,
		version: 1,
		sections: [
			{
				id: "section_1",
				title: "Membranes & transport",
				points: [
					{
						id: "point_1",
						text: "Passive vs active transport",
						source: "notes.pdf p. 3",
						status: "solid",
						history: [],
					},
				],
			},
			{
				id: "section_2",
				title: "Enzymes",
				points: [
					{
						id: "point_2",
						text: "Activation energy",
						source: "slides.pptx slide 4",
						status: "unchecked",
						history: [],
					},
				],
			},
		],
		...overrides,
	};
}

interface Reply {
	cheatSheet?: CheatSheet | null;
	build?: { status: string; startedAt: string; error?: string } | null;
	status?: number;
	error?: string;
}

/** Mounts the view against a scripted API. `post` answers the build launch;
 *  GET answers from `state`, which a POST may update. */
async function mountView(
	options: { test?: TestRecord; state?: Reply; post?: Reply; navigate?: (target: string) => void } = {},
) {
	const seen: Array<{ url: string; method: string }> = [];
	const navigated: string[] = [];
	const navigate = options.navigate ?? ((target: string) => navigated.push(target));
	let state: Reply = options.state ?? { cheatSheet: null, build: null };

	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		seen.push({ url, method });
		if (url === "/api/tests/test_1/cheat-sheet" && method === "GET") {
			return Response.json({ cheatSheet: state.cheatSheet ?? null, build: state.build ?? null });
		}
		if (url === "/api/tests/test_1/cheat-sheet" && method === "POST") {
			const reply = options.post ?? { status: 202 };
			if ((reply.status ?? 200) >= 400) {
				return Response.json({ error: reply.error ?? "failed" }, { status: reply.status });
			}
			state = { cheatSheet: state.cheatSheet ?? null, build: { status: "running", startedAt: new Date().toISOString() } };
			return Response.json({ started: true }, { status: 202 });
		}
		throw new Error(`unexpected request ${method} ${url}`);
	}) as typeof fetch;

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<CheatSheetView test={options.test ?? record()} navigate={navigate} />);
	});
	return { seen, navigated };
}

async function mountArticle() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<CheatSheetArticle sheet={SHEET} title="Bio midterm" />);
	});
}

test("the article renders every section with its idea, facts, formulas and trap", async () => {
	await mountArticle();

	const article = document.querySelector('[data-testid="cheat-sheet"]');
	assert.ok(article, "the sheet renders");
	const text = article!.textContent ?? "";
	assert.match(text, /Bio midterm/);
	assert.match(text, /Cheat sheet/);
	assert.match(text, /2 sections/);
	assert.match(text, /Membranes & transport/);
	assert.match(text, /The membrane decides what crosses and how fast\./);
	assert.match(text, /Diffusion/);
	assert.match(text, /Net movement down a concentration gradient\./);
	assert.match(text, /Osmosis is water across a semipermeable membrane\./);
	assert.match(text, /water potential = Ψs \+ Ψp/);
	assert.match(text, /Do not call facilitated diffusion active transport\./);
	assert.match(text, /notes\.pdf p\. 3/);
	assert.equal(document.querySelectorAll('[data-testid="cheat-sheet-section"]').length, 2);
});

test("the masthead date is locale-independent", () => {
	assert.equal(sheetDate("2026-11-27T10:00:00.000Z"), "27 Nov 2026");
	assert.equal(sheetDate("not a date"), "");
});

test("an unconfirmed plan explains the gate and offers no build", async () => {
	await mountView({ test: record({ planConfirmed: false }) });

	const text = document.body.textContent ?? "";
	assert.match(text, /Confirm the plan first/);
	assert.equal(document.querySelector('[data-testid="build-cheat-sheet"]'), null);
});

test("no sheet yet offers the build action and explains what it makes", async () => {
	await mountView();

	assert.ok(document.querySelector('[data-testid="build-cheat-sheet"]'));
	assert.match(document.body.textContent ?? "", /Make a cheat sheet/);
	assert.match(document.body.textContent ?? "", /already read for this test/);
	assert.equal(document.querySelector('[data-testid="cheat-sheet"]'), null);
});

test("building posts once and shows the build in progress", async () => {
	const { seen } = await mountView();

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="build-cheat-sheet"]')!.click());

	const posts = seen.filter((request) => request.method === "POST");
	assert.equal(posts.length, 1);
	assert.equal(posts[0]!.url, "/api/tests/test_1/cheat-sheet");
	assert.match(document.body.textContent ?? "", /Building your sheet…/);
});

test("a failed launch shows the route's message", async () => {
	await mountView({ post: { status: 409, error: "Confirm the plan before building a cheat sheet." } });

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="build-cheat-sheet"]')!.click());

	assert.match(document.body.textContent ?? "", /Confirm the plan before building a cheat sheet\./);
});

test("a stored sheet renders with print and rebuild actions", async () => {
	await mountView({ state: { cheatSheet: SHEET, build: null } });

	assert.ok(document.querySelector('[data-testid="cheat-sheet"]'), "the stored sheet renders");
	assert.ok(document.querySelector('[data-testid="print-cheat-sheet"]'));
	assert.ok(document.querySelector('[data-testid="rebuild-cheat-sheet"]'));
	assert.equal(document.querySelector('[data-testid="build-cheat-sheet"]'), null);
	assert.equal(document.querySelector('[data-testid="sheet-stale"]'), null, "a matching plan is not stale");
});

test("a plan edited after the build marks the sheet stale", async () => {
	const changed = record();
	changed.sections[1]!.title = "Enzymes and inhibitors";
	await mountView({ test: changed, state: { cheatSheet: SHEET, build: null } });

	assert.ok(document.querySelector('[data-testid="sheet-stale"]'), "the page says the plan changed");
	assert.match(document.body.textContent ?? "", /Your plan changed after this sheet was built\./);
});

test("rebuilding posts from the sheet view and keeps the sheet visible", async () => {
	const { seen } = await mountView({ state: { cheatSheet: SHEET, build: null } });

	await act(async () =>
		document.querySelector<HTMLButtonElement>('[data-testid="rebuild-cheat-sheet"]')!.click(),
	);

	assert.equal(seen.filter((request) => request.method === "POST").length, 1);
	assert.ok(document.querySelector('[data-testid="cheat-sheet"]'), "the last good sheet stays up");
});

test("a build error from the record shows under the build action", async () => {
	await mountView({
		state: {
			cheatSheet: null,
			build: { status: "error", startedAt: "2026-11-27T10:00:00.000Z", error: "No read material found." },
		},
	});

	assert.match(document.body.textContent ?? "", /No read material found\./);
	assert.ok(document.querySelector('[data-testid="build-cheat-sheet"]'), "the action stays available");
});

test("the readiness page offers the cheat sheet once the plan is confirmed", async () => {
	const navigated: string[] = [];
	globalThis.fetch = (async () => {
		throw new Error("readiness should not fetch on mount");
	}) as unknown as typeof fetch;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<ReadinessView test={record()} sessions={[]} navigate={(target) => navigated.push(target)} />,
		);
	});

	const button = document.querySelector<HTMLButtonElement>('[data-testid="open-cheat-sheet"]');
	assert.ok(button, "the entry button appears on a confirmed plan");
	assert.match(button!.textContent ?? "", /Cheat sheet/);

	await act(async () => button!.click());
	assert.deepEqual(navigated, ["/tests/test_1/cheat-sheet"]);
});

test("an unconfirmed plan has no cheat sheet entry", async () => {
	globalThis.fetch = (async () => {
		throw new Error("readiness should not fetch on mount");
	}) as unknown as typeof fetch;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<ReadinessView test={record({ planConfirmed: false })} sessions={[]} />);
	});

	assert.equal(document.querySelector('[data-testid="open-cheat-sheet"]'), null);
});