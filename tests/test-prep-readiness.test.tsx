/**
 * ReadinessView (test prep, 2026-11-10): option B of the approved mockup —
 * the test name, one overall "Ready: N%" (the count-based rule), a bar per
 * section with its solid/total, and each section's points behind a click,
 * with their status badges. The page also owns the two actions: an
 * "Edit plan" toggle reusing PlanEditor (saving with confirm:true) and
 * "Continue where I left off", which creates the next testprep sitting with
 * that test's id and sends "Continue." as its first message.
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
import { ReadinessView } from "../components/test-prep/readiness-view.tsx";
import type { ChatSummary, PendingAdditions, TestRecord } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	// next/link's idle-callback fallback reads `self` (the Sessions rows are Links).
	self: globalThis,
	// Radix's Collapsible content (the Left out lists) asks the browser for
	// computed styles and animation frames; linkedom has neither.
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

// linkedom does not implement native checkbox activation. Preserve click
// semantics so React's onChange reads the toggled `checked`.
const nativeInputClick = dom.window.HTMLInputElement.prototype.click;
dom.window.HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
	if (this.type === "checkbox") this.checked = !this.checked;
	nativeInputClick.call(this);
};

// SessionStarter stashes the opening message before navigating; the same-tab
// handover needs sessionStorage (the render-new-session stub).
const stored = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
	configurable: true,
	value: {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => {
			stored.set(key, value);
		},
		removeItem: (key: string) => {
			stored.delete(key);
		},
	},
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
	stored.clear();
});

/** Two solid points of four: overall 50%, with a re-check due and a gap. */
function record(overrides: Partial<TestRecord> = {}): TestRecord {
	return {
		id: "test_1",
		title: "Bio midterm",
		createdAt: "2026-11-10T12:00:00.000Z",
		updatedAt: "2026-11-10T12:00:00.000Z",
		planConfirmed: true,
		version: 1,
		sections: [
			{
				id: "section_1",
				title: "Membranes & transport",
				points: [
					{ id: "point_1", text: "Cell membrane structure", source: "outline 1", status: "solid", history: [] },
					{ id: "point_2", text: "Passive vs active transport", source: "outline 2", status: "solid", history: [] },
					{
						id: "point_3",
						text: "Osmosis in hypertonic solutions",
						source: "outline 3",
						status: "fixed-recheck",
						fixedIn: "chat_0",
						history: [],
					},
					{ id: "point_4", text: "Enzymes and activation energy", source: "outline 4", status: "gap", history: [] },
				],
			},
		],
		...overrides,
	};
}

interface SeenRequest {
	url: string;
	method: string;
	body: unknown;
}

/** Mounts against a mock API, returning every request and the navigation.
 *  `picker` stubs POST /api/path-picker (absent = an unexpected request);
 *  `sweepLaunch` stubs the sweep POST's answer (default: the 202 launch). */
async function mount(
	options: {
		navigate?: (target: string) => void;
		test?: TestRecord;
		sessions?: ChatSummary[];
		picker?: { status: number; paths?: string[] };
		sweepLaunch?: { status: number; body?: unknown };
	} = {},
) {
	const seen: SeenRequest[] = [];
	const navigated: string[] = [];
	const navigate = options.navigate ?? ((target: string) => navigated.push(target));
	let current = options.test ?? record();
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		seen.push({ url, method, body });
		if (url === "/api/path-picker" && method === "POST") {
			const reply = options.picker;
			if (!reply) throw new Error(`unexpected request ${method} ${url}`);
			if (reply.status !== 200) return new Response(null, { status: reply.status });
			return Response.json({ paths: reply.paths ?? [] });
		}
		if (url === "/api/chats" && method === "POST") return Response.json({ id: "chat_new", testId: "test_1" });
		if (url === "/api/tests/test_1/plan" && method === "PUT") {
			const draft = (body as { sections: TestRecord["sections"]; confirm: boolean });
			current = { ...current, sections: draft.sections, planConfirmed: draft.confirm ? true : current.planConfirmed };
			return Response.json(current);
		}
		if (url === "/api/tests/test_1/sweep" && method === "GET") {
			return Response.json({
				sweep: current.sweep ?? null,
				pendingAdditions: current.pendingAdditions ?? null,
			});
		}
		if (url === "/api/tests/test_1/sweep" && method === "POST") {
			const reply = options.sweepLaunch ?? { status: 202, body: { started: true } };
			if (reply.status >= 400) return Response.json(reply.body ?? {}, { status: reply.status });
			current = {
				...current,
				folder: current.folder ?? (body as { folder?: string } | undefined)?.folder,
				sweep: {
					status: "running",
					activity: "Reading your materials",
					startedAt: "2026-11-21T12:00:00.000Z",
					fileHashes: {},
				},
			};
			return Response.json(reply.body ?? { started: true }, { status: reply.status });
		}
		if (url === "/api/tests/test_1/additions" && method === "POST") {
			current = { ...current, pendingAdditions: undefined };
			return Response.json(current);
		}
		if (url === "/api/tests/test_1/left-out" && method === "POST") {
			const itemId = (body as { itemId: string }).itemId;
			current = { ...current, leftOut: (current.leftOut ?? []).filter((item) => item.id !== itemId) };
			return Response.json(current);
		}
		throw new Error(`unexpected request ${method} ${url}`);
	}) as typeof fetch;

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<ReadinessView test={current} sessions={options.sessions ?? []} navigate={navigate} />);
	});
	return { seen, navigated };
}

function buttonByText(text: string): HTMLButtonElement | undefined {
	return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes(text),
	);
}

test("renders the overall count-based readiness and each section's solid/total", async () => {
	await mount();

	const text = document.body.textContent ?? "";
	assert.match(text, /Ready: 50%/, "two of four solid is 50%");
	assert.match(text, /Membranes & transport/);
	assert.match(text, /2\/4/, "the section bar carries its counts");
});

test("an unconfirmed plan hides Continue and shows the review cue", async () => {
	await mount({ test: record({ planConfirmed: false }) });

	assert.equal(
		!!document.querySelector('[data-testid="continue-test"]'),
		false,
		"no Continue before confirmation",
	);
	assert.match(document.body.textContent ?? "", /Plan awaiting review — confirm it in the chat\./);
	assert.ok(document.querySelector('[data-testid="edit-plan"]'), "Edit plan stays available");
});

test("a confirmed plan still shows Continue", async () => {
	await mount();

	assert.ok(document.querySelector('[data-testid="continue-test"]'));
	assert.ok(!(document.body.textContent ?? "").includes("Plan awaiting review"));
});

test("clicking a section expands its points with status badges", async () => {
	await mount();

	const section = document.querySelector<HTMLButtonElement>('[data-testid="readiness-section-section_1"]');
	assert.ok(section, "the section row is a toggle");
	assert.equal(section!.getAttribute("aria-expanded"), "false");

	await act(async () => section!.click());

	const text = document.body.textContent ?? "";
	assert.match(text, /Re-check next time/, "a fixed point is due for a later-sitting re-check");
	assert.match(text, /Not checked yet|Gap|Solid/);
	const labels = [...document.querySelectorAll('[data-testid="point-status"]')].map((node) => node.textContent);
	assert.deepEqual(labels, ["Solid", "Solid", "Re-check next time", "Gap"]);
	assert.equal(
		document.querySelector<HTMLButtonElement>('[data-testid="readiness-section-section_1"]')?.getAttribute("aria-expanded"),
		"true",
	);
});

test("Edit plan reuses the editor and saves with confirm:true", async () => {
	const { seen } = await mount();

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="edit-plan"]')!.click());
	assert.ok(document.querySelector('[data-testid="plan-editor"]'), "the plan editor opens");

	const save = buttonByText("Save plan");
	assert.ok(save, "the readiness editor's action reads Save plan");

	await act(async () => save!.click());

	const put = seen.find((request) => request.method === "PUT");
	assert.ok(put, "one PUT");
	assert.equal(put!.url, "/api/tests/test_1/plan");
	const body = put!.body as { confirm: boolean; sections: Array<{ id?: string; points: Array<{ id?: string }> }> };
	assert.equal(body.confirm, true, "a readiness edit stays confirmed");
	assert.equal(body.sections[0]?.id, "section_1");
	assert.deepEqual(
		body.sections[0]?.points.map((point) => point.id),
		["point_1", "point_2", "point_3", "point_4"],
		"the ids ride through so mergePlan keeps their statuses",
	);
	assert.equal(document.querySelector('[data-testid="plan-editor"]'), null, "the editor closes after saving");
});

test("Continue creates the next testprep sitting with 'Continue.' as its first message", async () => {
	const { seen, navigated } = await mount();

	await act(async () =>
		document.querySelector<HTMLButtonElement>('[data-testid="continue-test"]')!.click(),
	);

	const post = seen.find((request) => request.method === "POST" && request.url === "/api/chats");
	assert.ok(post, "the continue action creates a session");
	assert.deepEqual(post!.body, { title: "Continue.", kind: "testprep", testId: "test_1" });
	assert.deepEqual(navigated, ["/chat/chat_new"], "it lands on the new sitting");
});

// ─── Sessions block (study boxes, 2026-11-17) ───────────────────────────────

function session(id: string, title: string): ChatSummary {
	return {
		id,
		title,
		createdAt: "2026-11-16T12:00:00.000Z",
		updatedAt: "2026-11-16T12:00:00.000Z",
		kind: "testprep",
		testId: "test_1",
		messageCount: 2,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
	};
}

test("the readiness page lists the test's sessions below the sections and offers New session", async () => {
	await mount({ sessions: [session("chat_2", "Second sitting"), session("chat_1", "First sitting")] });

	const block = document.querySelector('[data-testid="study-sessions"]');
	assert.ok(block, "the Sessions block renders");
	const rows = [...block!.querySelectorAll("a")].map((row) => row.getAttribute("href"));
	assert.deepEqual(rows, ["/chat/chat_2", "/chat/chat_1"]);
	const button = document.querySelector('[data-testid="new-test-session"]');
	assert.ok(button, "the New session button renders");
	assert.match(button!.textContent ?? "", /New session/);
	assert.ok(document.querySelector('[data-testid="continue-test"]'), "Continue where I left off stays");

	const sections = document.querySelector('[data-testid="readiness-sections"]')!;
	assert.ok(
		sections.compareDocumentPosition(block!) & 4,
		"the Sessions block sits below the readiness sections",
	);
});

test("New session starts the next testprep sitting through the Continue path", async () => {
	const { seen, navigated } = await mount();

	await act(async () =>
		document.querySelector<HTMLButtonElement>('[data-testid="new-test-session"]')!.click(),
	);

	const post = seen.find((request) => request.method === "POST" && request.url === "/api/chats");
	assert.ok(post, "New session creates a session");
	assert.deepEqual(post!.body, { title: "Continue.", kind: "testprep", testId: "test_1" });
	assert.deepEqual(navigated, ["/chat/chat_new"]);
});

// ─── Material sweep: re-sweep, additions, left out (2026-11-21) ─────────────

const ADDITIONS: PendingAdditions = {
	sections: [
		{
			title: "Membranes & transport",
			points: [
				{ text: "Signal transduction", source: "ch4.pdf p. 2" },
				{ text: "Cotransport", source: "ch4.pdf p. 3" },
			],
		},
		{
			title: "Cell cycle",
			points: [{ text: "Checkpoints", source: "ch5.pdf p. 9" }],
		},
	],
	leftOut: [
		{ id: "lo_add", text: "Chapter summary", source: "ch4.pdf p. 1", reason: "summary, not tested" },
	],
};

async function openFirstLeftOut(): Promise<void> {
	const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes("Left out ("),
	);
	assert.ok(trigger, "the Left out header is a button");
	await act(async () => trigger!.click());
}

test("a test with no stored folder offers Choose folder… instead of Re-sweep", async () => {
	await mount();

	const choose = document.querySelector<HTMLButtonElement>('[data-testid="choose-folder"]');
	assert.ok(choose, "the header offers Choose folder…");
	assert.match(choose!.textContent ?? "", /Choose folder…/);
	assert.equal(
		document.querySelector('[data-testid="resweep-folder"]'),
		null,
		"Re-sweep folder needs a stored folder",
	);
});

test("a test with a stored folder offers Re-sweep folder, not Choose folder…", async () => {
	await mount({ test: record({ folder: "materials" }) });

	assert.ok(document.querySelector('[data-testid="resweep-folder"]'));
	assert.equal(document.querySelector('[data-testid="choose-folder"]'), null);
});

test("choosing a folder launches the sweep with that folder", async () => {
	const { seen } = await mount({ picker: { status: 200, paths: ["C:\\notes\\sbi4u"] } });

	await act(async () =>
		document.querySelector<HTMLButtonElement>('[data-testid="choose-folder"]')!.click(),
	);

	const post = seen.find((request) => request.method === "POST" && request.url === "/api/tests/test_1/sweep");
	assert.ok(post, "the chosen folder starts a sweep");
	assert.deepEqual(post!.body, { folder: "C:\\notes\\sbi4u" });
	assert.equal(document.querySelector('[data-testid="choose-folder"]'), null, "the test now has a folder");
	assert.ok(document.querySelector('[data-testid="resweep-folder"]'), "the normal re-sweep button takes over");
});

test("cancelling the folder picker launches nothing", async () => {
	const { seen } = await mount({ picker: { status: 200, paths: [] } });

	await act(async () =>
		document.querySelector<HTMLButtonElement>('[data-testid="choose-folder"]')!.click(),
	);

	assert.equal(
		seen.filter((request) => request.method === "POST" && request.url === "/api/tests/test_1/sweep").length,
		0,
		"an empty pick is a cancellation",
	);
	assert.ok(document.querySelector('[data-testid="choose-folder"]'), "the picker stays on offer");
});

test("a system without a folder picker says so and launches nothing", async () => {
	const { seen } = await mount({ picker: { status: 501 } });

	await act(async () =>
		document.querySelector<HTMLButtonElement>('[data-testid="choose-folder"]')!.click(),
	);

	assert.equal(
		seen.filter((request) => request.method === "POST" && request.url === "/api/tests/test_1/sweep").length,
		0,
	);
	assert.match(document.body.textContent ?? "", /The folder picker is not available on this system\./);
	assert.ok(document.querySelector('[data-testid="choose-folder"]'), "the picker stays on offer");
});

test("a rejected folder shows the server's reason and keeps Choose folder…", async () => {
	const message = "folder not found or not a readable directory: x (y)";
	const { seen } = await mount({
		picker: { status: 200, paths: ["C:\\nope"] },
		sweepLaunch: { status: 400, body: { error: message } },
	});

	await act(async () =>
		document.querySelector<HTMLButtonElement>('[data-testid="choose-folder"]')!.click(),
	);

	const post = seen.find((request) => request.method === "POST" && request.url === "/api/tests/test_1/sweep");
	assert.ok(post, "the chosen folder is still offered to the route");
	assert.deepEqual(post!.body, { folder: "C:\\nope" });
	assert.ok((document.body.textContent ?? "").includes(message), "the server's reason is shown");
	assert.ok(document.querySelector('[data-testid="choose-folder"]'), "the folder was not recorded");
});

test("Re-sweep folder is disabled while additions await review", async () => {
	await mount({ test: record({ folder: "materials", pendingAdditions: ADDITIONS }) });

	const button = document.querySelector<HTMLButtonElement>('[data-testid="resweep-folder"]');
	assert.ok(button);
	assert.equal(button!.disabled, true);
	assert.equal(button!.getAttribute("title"), "Review the new items first");
	assert.ok(document.querySelector('[data-testid="resweep-additions"]'), "the review card renders");
});

test("the additions card posts only the checked keys", async () => {
	const { seen } = await mount({ test: record({ folder: "materials", pendingAdditions: ADDITIONS }) });

	const keeper = document.querySelector<HTMLInputElement>('[data-testid="addition-0:0"]');
	const dropper = document.querySelector<HTMLInputElement>('[data-testid="addition-0:1"]');
	const otherSection = document.querySelector<HTMLInputElement>('[data-testid="addition-1:0"]');
	assert.ok(keeper && dropper && otherSection, "every proposed point has a checkbox");
	assert.equal(keeper!.checked, true, "new items are accepted by default");
	assert.equal(dropper!.checked, true);
	assert.equal(otherSection!.checked, true);

	await act(async () => dropper!.click());
	assert.equal(dropper!.checked, false, "the learner can drop one");

	const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes("Add accepted"),
	);
	assert.ok(add, "the card offers Add accepted");
	await act(async () => add!.click());

	const post = seen.find((request) => request.method === "POST" && request.url === "/api/tests/test_1/additions");
	assert.ok(post, "accepting posts the review");
	assert.deepEqual(post!.body, { accepted: ["0:0", "1:0"] }, "only the checked keys, in section order");
});

test("promoting a left-out item posts its id", async () => {
	const item = { id: "lo_1", text: "Glossary of terms", source: "ch1.pdf", reason: "reference, not tested" };
	const { seen } = await mount({ test: record({ folder: "materials", leftOut: [item] }) });

	await openFirstLeftOut();
	const promote = document.querySelector<HTMLButtonElement>('[data-testid="promote-left-out"]');
	assert.ok(promote, "the persistent list offers Promote");
	assert.equal(promote!.getAttribute("aria-label"), "Promote Glossary of terms");
	await act(async () => promote!.click());

	const post = seen.find((request) => request.method === "POST" && request.url === "/api/tests/test_1/left-out");
	assert.ok(post, "promoting posts to left-out");
	assert.deepEqual(post!.body, { itemId: "lo_1" });
});

test("the coverage line carries the last re-sweep's file count", async () => {
	await mount({
		test: record({
			folder: "materials",
			sweep: {
				status: "done",
				startedAt: "2026-11-21T12:00:00.000Z",
				finishedAt: "2026-11-21T12:05:00.000Z",
				fileHashes: {},
				coverage: {
					files: 3,
					pages: 120,
					visionPages: 4,
					unsupported: [],
					unreadable: [],
					empty: [],
					removed: [],
					lastResweep: { at: "2026-11-21T12:05:00.000Z", files: 4 },
				},
			},
		}),
	});

	const line = document.querySelector('[data-testid="coverage-line"]');
	assert.ok(line, "the whole-folder coverage line renders");
	assert.match(line!.textContent ?? "", /Read 3 files · 120 pages \(4 looked at by vision\)/);
	assert.match(document.body.textContent ?? "", /Last re-sweep: \+4 files/);
});
