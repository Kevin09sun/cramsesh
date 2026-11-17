/**
 * The AP course UI (AP prep stage 1, 2026-11-13): the course list's data is a
 * server page, but the two client surfaces are tested here —
 *
 *   - CourseView: one row per unit (title, percent, Learn/Practise) and per
 *     topic (text, the four status phrasings, Learn/Practise), the weak-topics
 *     button, the units editor and the documents block with its Download
 *     button; before confirmation the list shows Confirm and no Practise;
 *   - StartSitting: a Practise button opens the kind chooser and creates the
 *     AP sitting;
 *   - Learn: the exported learnPrompt builds the Teach session title/first
 *     message;
 *   - UnitsReviewCard: PlanReviewCard's behaviour against the AP plan route,
 *     in the words "unit" and "topic";
 *   - the renderer registry and the three AP activity labels.
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
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ChatActionsContext } from "../components/chat.tsx";
import { CourseView, learnPrompt } from "../components/ap/course-view.tsx";
import { UnitsReviewCard } from "../components/ap/units-review-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { toolActivityLabel } from "../src/core/pending.ts";
import { sittingLabel } from "../src/core/index.ts";
import { AP_ADDED_TOPIC_SOURCE } from "../src/core/ap.ts";
import type { ApCourseRecord, ApDocument, LhViewMessage } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

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

function buttonByText(text: string): HTMLButtonElement | undefined {
	return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes(text),
	);
}

function apRecord(overrides: Partial<ApCourseRecord> = {}): ApCourseRecord {
	return {
		id: "ap_1",
		title: "AP Calculus BC",
		createdAt: "2026-11-13T12:00:00.000Z",
		updatedAt: "2026-11-13T12:00:00.000Z",
		planConfirmed: true,
		version: 1,
		documents: [
			{
				id: "ced",
				kind: "ced",
				label: "Course and Exam Description (2026)",
				year: 2026,
				url: "https://apcentral.collegeboard.org/ced.pdf",
				file: "ced.pdf",
			},
			{
				id: "frq",
				kind: "frq",
				label: "Free-response questions (2025)",
				year: 2025,
				url: "https://apcentral.collegeboard.org/frq-2025.pdf",
				file: "frq-2025.pdf",
			},
		],
		sections: [
			{
				id: "unit_1",
				title: "Unit 1 Limits",
				points: [
					{ id: "topic_1", text: "1.1 Average rates of change", source: "p. 5", status: "solid", history: [] },
					{ id: "topic_2", text: "1.2 Definition of a limit", source: "p. 7", status: "gap", history: [] },
					{
						id: "topic_3",
						text: "1.3 Estimating limits",
						source: "p. 9",
						status: "fixed-recheck",
						fixedIn: "chat_0",
						history: [],
					},
					{ id: "topic_4", text: "1.4 Continuity", source: "p. 11", status: "unchecked", history: [] },
				],
			},
		],
		...overrides,
	};
}

/** The course record's documents extended with local presence, as the server
 *  page hands them to CourseView. */
function documentStates(presentFrq = false): Array<ApDocument & { present: boolean }> {
	return apRecord().documents.map((document) => ({
		...document,
		present: document.kind === "ced" ? true : presentFrq,
	}));
}

async function mountCourse(options: {
	course?: ApCourseRecord;
	documents?: Array<ApDocument & { present: boolean; questions?: number }>;
	indexedQuestions?: number;
	navigate?: (target: string) => void;
} = {}) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<CourseView
				course={options.course ?? apRecord()}
				documents={options.documents ?? documentStates()}
				indexedQuestions={options.indexedQuestions ?? 0}
				cedPath="/papers/ced.pdf"
				navigate={options.navigate ?? (() => {})}
			/>,
		);
	});
}

// ─── learnPrompt ────────────────────────────────────────────────────────────

test("learnPrompt: unit and topic, with and without the course description", () => {
	const unit = { courseTitle: "AP Calculus BC", unitTitle: "Unit 1 Limits" };
	assert.equal(
		learnPrompt(unit),
		"Teach me Unit 1 Limits from AP Calculus BC, to the AP syllabus. The official course description is not on this computer; teach from your own knowledge of the AP syllabus and say so.",
	);

	assert.equal(
		learnPrompt({ ...unit, cedPath: "/papers/ced.pdf" }),
		"Teach me Unit 1 Limits from AP Calculus BC, to the AP syllabus. The official course description is `/papers/ced.pdf`.",
	);

	assert.equal(
		learnPrompt({ ...unit, cedPath: "/papers/ced.pdf", source: "p. 5" }),
		"Teach me Unit 1 Limits from AP Calculus BC, to the AP syllabus. The official course description is `/papers/ced.pdf`. This part is at p. 5.",
	);

	const topic = {
		courseTitle: "AP Calculus BC",
		unitTitle: "Unit 1 Limits",
		topicText: "1.1 Average rates of change",
	};
	assert.equal(
		learnPrompt(topic),
		"Teach me 1.1 Average rates of change (Unit 1 Limits) from AP Calculus BC, to the AP syllabus. The official course description is not on this computer; teach from your own knowledge of the AP syllabus and say so.",
	);

	assert.equal(
		learnPrompt({ ...topic, cedPath: "/papers/ced.pdf" }),
		"Teach me 1.1 Average rates of change (Unit 1 Limits) from AP Calculus BC, to the AP syllabus. The official course description is `/papers/ced.pdf`.",
	);

	assert.equal(
		learnPrompt({ ...topic, cedPath: "/papers/ced.pdf", source: "p. 5" }),
		"Teach me 1.1 Average rates of change (Unit 1 Limits) from AP Calculus BC, to the AP syllabus. The official course description is `/papers/ced.pdf`. This part is at p. 5.",
	);

	assert.equal(
		learnPrompt({ ...topic, cedPath: "/papers/ced.pdf", source: AP_ADDED_TOPIC_SOURCE }),
		"Teach me 1.1 Average rates of change (Unit 1 Limits) from AP Calculus BC, to the AP syllabus. The official course description is `/papers/ced.pdf`.",
		"a learner-added topic names no page — 'Added by you' is not a location",
	);

	assert.equal(
		learnPrompt({ ...topic, cedPath: "/papers/ced.pdf", source: "  " }),
		"Teach me 1.1 Average rates of change (Unit 1 Limits) from AP Calculus BC, to the AP syllabus. The official course description is `/papers/ced.pdf`.",
		"an empty source adds no page sentence",
	);
});

// ─── CourseView ─────────────────────────────────────────────────────────────

test("a confirmed course shows the units, the four statuses, both button sets and the weak-topics button", async () => {
	await mountCourse();

	const text = document.body.textContent ?? "";
	assert.match(text, /AP Calculus BC/);
	assert.match(text, /Ready: 25%/, "one of four topics solid is 25%");
	assert.match(text, /Unit 1 Limits/);
	assert.match(text, /1\/4/, "the unit carries its solid/total counts");

	const statuses = [...document.querySelectorAll('[data-testid="topic-status"]')].map((node) => node.textContent);
	assert.deepEqual(statuses, ["solid", "gap", "re-check next sitting", "not yet asked"]);

	assert.ok(document.querySelector('[data-testid="learn-unit-unit_1"]'), "the unit offers Learn");
	assert.ok(document.querySelector('[data-testid="practise-unit-unit_1"]'), "the unit offers Practise");
	assert.ok(document.querySelector('[data-testid="learn-topic-topic_1"]'), "each topic offers Learn");
	assert.ok(document.querySelector('[data-testid="practise-topic-topic_1"]'), "each topic offers Practise");
	assert.ok(document.querySelector('[data-testid="practise-weak"]'), "the weak-topics button exists");
	assert.match(document.querySelector('[data-testid="practise-weak"]')?.textContent ?? "", /Practise weak topics/);
});

test("an absent document shows Missing on this computer; Download POSTs to the course's documents route", async () => {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		seen.push({ url, method: init?.method ?? "GET", body: init?.body });
		if (url === "/api/ap/ap_1/documents" && init?.method === "POST") {
			return Response.json({ documents: [{ id: "frq", file: "frq-2025.pdf", present: true }] });
		}
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	await mountCourse();

	assert.match(document.body.textContent ?? "", /Missing on this computer/);
	const download = document.querySelector<HTMLButtonElement>('[data-testid="download-frq"]');
	assert.ok(download, "the absent document offers Download");
	assert.match(download!.textContent ?? "", /Download/);

	await act(async () => download!.click());

	assert.equal(seen.length, 1);
	assert.equal(seen[0]!.url, "/api/ap/ap_1/documents");
	assert.equal(seen[0]!.method, "POST");
	assert.equal(seen[0]!.body, undefined, "the route takes no URL body — the stored manifest decides");
	assert.equal(document.querySelector('[data-testid="download-frq"]'), null, "once present, no Download remains");
	assert.doesNotMatch(document.body.textContent ?? "", /Missing on this computer/);
});

test("an unconfirmed course shows Confirm and no Learn/Practise buttons", async () => {
	await mountCourse({ course: apRecord({ planConfirmed: false }) });

	assert.ok(buttonByText("Confirm"), "the unconfirmed list offers Confirm");
	assert.equal(document.querySelector('[data-testid="learn-unit-unit_1"]'), null, "no Learn before confirmation");
	assert.equal(document.querySelector('[data-testid="practise-unit-unit_1"]'), null, "no Practise before confirmation");
	assert.doesNotMatch(document.body.textContent ?? "", /Practise/, "no Practise affordance anywhere");
});

// ─── StartSitting and Learn ─────────────────────────────────────────────────

test("Practise opens the kind chooser and creates the AP sitting in the chosen kind", async () => {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	const navigated: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		seen.push({ url, method: init?.method ?? "GET", body });
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_new" });
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	await mountCourse({ navigate: (target) => navigated.push(target) });

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="practise-topic-topic_1"]')!.click());

	const chooserText = document.body.textContent ?? "";
	assert.match(chooserText, /Multiple-choice/);
	assert.match(chooserText, /Free-response/);
	assert.match(chooserText, /Mixed/);

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="sitting-mcq"]')!.click());

	const post = seen.find((request) => request.url === "/api/chats");
	assert.ok(post, "a sitting creates a session");
	const sitting = { scope: { type: "topic", topicId: "topic_1" }, kind: "mcq" } as const;
	assert.deepEqual(post!.body, {
		title: sittingLabel(apRecord(), sitting),
		kind: "ap",
		apCourseId: "ap_1",
		apSitting: sitting,
	});
	assert.deepEqual(navigated, ["/chat/chat_new"]);
});

test("with no indexed questions Free-response and Mixed both start a sitting and no note is shown", async () => {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	const navigated: string[] = [];
	let created = "chat_frq";
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		seen.push({ url, method: init?.method ?? "GET", body });
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: created });
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	await mountCourse({ indexedQuestions: 0, navigate: (target) => navigated.push(target) });
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="practise-topic-topic_1"]')!.click());

	assert.doesNotMatch(document.body.textContent ?? "", /needs released papers/, "a free-response sitting needs no released papers");
	assert.equal(document.querySelector<HTMLButtonElement>('[data-testid="sitting-frq"]')?.disabled, false);
	assert.equal(document.querySelector<HTMLButtonElement>('[data-testid="sitting-mixed"]')?.disabled, false);

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="sitting-frq"]')!.click());

	const frqSitting = { scope: { type: "topic", topicId: "topic_1" }, kind: "frq" } as const;
	assert.deepEqual(seen.find((request) => request.url === "/api/chats")!.body, {
		title: sittingLabel(apRecord(), frqSitting),
		kind: "ap",
		apCourseId: "ap_1",
		apSitting: frqSitting,
	});
	assert.deepEqual(navigated, ["/chat/chat_frq"]);

	await unmount();
	seen.length = 0;
	navigated.length = 0;
	created = "chat_mixed";
	await mountCourse({ indexedQuestions: 0, navigate: (target) => navigated.push(target) });
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="practise-topic-topic_1"]')!.click());
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="sitting-mixed"]')!.click());

	const mixedSitting = { scope: { type: "topic", topicId: "topic_1" }, kind: "mixed" } as const;
	assert.deepEqual(seen.find((request) => request.url === "/api/chats")!.body, {
		title: sittingLabel(apRecord(), mixedSitting),
		kind: "ap",
		apCourseId: "ap_1",
		apSitting: mixedSitting,
	});
	assert.deepEqual(navigated, ["/chat/chat_mixed"]);
});

test("Learn creates a Teach session whose title is the learn prompt", async () => {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	const navigated: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		seen.push({ url, method: init?.method ?? "GET", body });
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_teach" });
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	await mountCourse({ navigate: (target) => navigated.push(target) });

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="learn-topic-topic_1"]')!.click());

	const post = seen.find((request) => request.url === "/api/chats");
	assert.ok(post, "Learn creates a session");
	assert.deepEqual(post!.body, {
		title: learnPrompt({
			courseTitle: "AP Calculus BC",
			unitTitle: "Unit 1 Limits",
			topicText: "1.1 Average rates of change",
			source: "p. 5",
			cedPath: "/papers/ced.pdf",
		}),
		apCourseId: "ap_1",
		apLearn: { type: "topic", topicId: "topic_1" },
	});
	assert.deepEqual(navigated, ["/chat/chat_teach"]);
});

test("Learn on a unit creates a Teach session linked to the unit's scope", async () => {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	const navigated: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		seen.push({ url, method: init?.method ?? "GET", body });
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_unit" });
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	await mountCourse({ navigate: (target) => navigated.push(target) });

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="learn-unit-unit_1"]')!.click());

	const post = seen.find((request) => request.url === "/api/chats");
	assert.ok(post, "unit Learn creates a session");
	assert.deepEqual(post!.body, {
		title: learnPrompt({
			courseTitle: "AP Calculus BC",
			unitTitle: "Unit 1 Limits",
			cedPath: "/papers/ced.pdf",
		}),
		apCourseId: "ap_1",
		apLearn: { type: "unit", unitId: "unit_1" },
	});
	assert.deepEqual(navigated, ["/chat/chat_unit"]);
});

test("with indexed questions Free-response starts a frq sitting and Mixed a mixed sitting", async () => {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	const navigated: string[] = [];
	let created = "chat_frq";
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		seen.push({ url, method: init?.method ?? "GET", body });
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: created });
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	await mountCourse({ indexedQuestions: 3, navigate: (target) => navigated.push(target) });
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="practise-topic-topic_1"]')!.click());

	const chooserText = document.body.textContent ?? "";
	assert.doesNotMatch(chooserText, /needs released papers/, "indexed papers remove the notes");
	assert.equal(document.querySelector<HTMLButtonElement>('[data-testid="sitting-frq"]')?.disabled, false);
	assert.equal(document.querySelector<HTMLButtonElement>('[data-testid="sitting-mixed"]')?.disabled, false);

	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="sitting-frq"]')!.click());

	const frqSitting = { scope: { type: "topic", topicId: "topic_1" }, kind: "frq" } as const;
	assert.deepEqual(seen.find((request) => request.url === "/api/chats")!.body, {
		title: sittingLabel(apRecord(), frqSitting),
		kind: "ap",
		apCourseId: "ap_1",
		apSitting: frqSitting,
	});
	assert.deepEqual(navigated, ["/chat/chat_frq"]);

	await unmount();
	seen.length = 0;
	navigated.length = 0;
	created = "chat_mixed";
	await mountCourse({ indexedQuestions: 3, navigate: (target) => navigated.push(target) });
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="practise-topic-topic_1"]')!.click());
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="sitting-mixed"]')!.click());

	const mixedSitting = { scope: { type: "topic", topicId: "topic_1" }, kind: "mixed" } as const;
	assert.deepEqual(seen.find((request) => request.url === "/api/chats")!.body, {
		title: sittingLabel(apRecord(), mixedSitting),
		kind: "ap",
		apCourseId: "ap_1",
		apSitting: mixedSitting,
	});
	assert.deepEqual(navigated, ["/chat/chat_mixed"]);
});

test("the documents block orders papers by year and says how many questions each one indexed", async () => {
	const documents: Array<ApDocument & { present: boolean; questions?: number }> = [
		{ id: "scoring-2024", kind: "scoring", label: "Scoring guidelines (2024)", year: 2024, url: "", file: "scoring-2024.pdf", present: false },
		{ id: "frq-2023", kind: "frq", label: "Free-response questions (2023)", year: 2023, url: "", file: "frq-2023.pdf", present: false, questions: 0 },
		{ id: "ced", kind: "ced", label: "Course and Exam Description (2026)", year: 2026, url: "", file: "ced.pdf", present: true },
		{ id: "scoring-2023-set2", kind: "scoring", label: "Scoring guidelines (2023, Set 2)", year: 2023, url: "", file: "scoring-2023-set2.pdf", present: false },
		{ id: "frq-2023-set2", kind: "frq", label: "Free-response questions (2023, Set 2)", year: 2023, url: "", file: "frq-2023-set2.pdf", present: false, questions: 1 },
		{ id: "frq-2024", kind: "frq", label: "Free-response questions (2024)", year: 2024, url: "", file: "frq-2024.pdf", present: false, questions: 4 },
	];
	await mountCourse({ documents, indexedQuestions: 5 });

	const order = [...document.querySelectorAll('[data-testid^="document-"]')].map((node) =>
		node.getAttribute("data-testid"),
	);
	assert.deepEqual(
		order,
		["document-ced", "document-frq-2024", "document-scoring-2024", "document-frq-2023", "document-frq-2023-set2", "document-scoring-2023-set2"],
		"description first, then papers by year desc and set, each paper before its scoring guideline",
	);

	const row = (id: string) => document.querySelector(`[data-testid="document-${id}"]`)?.textContent ?? "";
	assert.match(row("frq-2024"), /4 questions indexed/);
	assert.match(row("frq-2023-set2"), /1 question indexed/, "one is singular");
	assert.match(row("frq-2023"), /not indexed yet/);
	assert.doesNotMatch(row("ced"), /questions indexed|not indexed yet/);
	assert.doesNotMatch(row("scoring-2024"), /questions indexed|not indexed yet/);

	assert.match(document.body.textContent ?? "", /Released questions indexed: 5/);
});

test("Find released papers creates a session whose title and first message are the find prompt", async () => {
	const seen: Array<{ url: string; method: string; body: unknown }> = [];
	const navigated: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		seen.push({ url, method: init?.method ?? "GET", body });
		if (url === "/api/chats" && init?.method === "POST") return Response.json({ id: "chat_find" });
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	await mountCourse({ navigate: (target) => navigated.push(target) });

	const find = document.querySelector<HTMLButtonElement>('[data-testid="find-released-papers"]');
	assert.ok(find, "a confirmed course offers Find released papers");
	assert.match(find!.textContent ?? "", /Find released papers/);

	await act(async () => find!.click());

	const prompt = "Find the released free-response papers for AP Calculus BC.";
	assert.deepEqual(seen.find((request) => request.url === "/api/chats")!.body, {
		title: prompt,
		kind: "ap",
		apCourseId: "ap_1",
	});
	assert.equal(
		JSON.parse(stored.get("lh.openingPrompt.chat_find")!).text,
		prompt,
		"the session's first message is the same text as its title",
	);
	assert.deepEqual(navigated, ["/chat/chat_find"]);
});

test("Find released papers is absent before the list is confirmed", async () => {
	await mountCourse({ course: apRecord({ planConfirmed: false }) });
	assert.equal(document.querySelector('[data-testid="find-released-papers"]'), null);
});

// ─── UnitsReviewCard ────────────────────────────────────────────────────────

function reviewRecord(): ApCourseRecord {
	return apRecord({ planConfirmed: false });
}

async function mountUnitsCard() {
	const puts: Array<{ url: string; body: unknown }> = [];
	const sent: string[] = [];
	let current = reviewRecord();
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === "/api/chats/chat_1") return Response.json({ id: "chat_1", apCourseId: "ap_1" });
		if (url === "/api/ap/ap_1/plan" && (init?.method ?? "GET") === "GET") return Response.json(current);
		if (url === "/api/ap/ap_1/plan" && init?.method === "PUT") {
			const body = JSON.parse(String(init.body)) as { sections: ApCourseRecord["sections"]; confirm: boolean };
			puts.push({ url, body });
			current = { ...current, planConfirmed: true, sections: body.sections };
			return Response.json(current);
		}
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<ChatActionsContext.Provider
				value={{
					chatId: "chat_1",
					messages: [
						{
							id: "message_1",
							role: "assistant",
							parts: [{ type: "tool-propose_units", toolCallId: "call_1", state: "output-available" }],
						},
					] as LhViewMessage[],
					syncFromServer: async () => {},
					sendText: (text: string) => {
						sent.push(text);
					},
					openSetup: () => {},
				}}
			>
				<UnitsReviewCard part={{ type: "tool-propose_units", state: "output-available", toolCallId: "call_1" }} />
			</ChatActionsContext.Provider>,
		);
	});
	return { puts, sent };
}

test("UnitsReviewCard renders units and topics and targets the AP plan route", async () => {
	const { puts, sent } = await mountUnitsCard();

	assert.equal(
		document.querySelector<HTMLInputElement>('input[aria-label="Unit 1 title"]')?.value,
		"Unit 1 Limits",
		"the surface speaks of units",
	);
	assert.equal(
		document.querySelector<HTMLInputElement>('input[aria-label="Unit 1, topic 1"]')?.value,
		"1.1 Average rates of change",
		"the surface speaks of topics",
	);
	const confirm = buttonByText("Confirm units and topics");
	assert.ok(confirm, "the AP card confirms units and topics");

	await act(async () => confirm!.click());

	assert.equal(puts.length, 1, "exactly one PUT");
	assert.equal(puts[0]!.url, "/api/ap/ap_1/plan");
	const body = puts[0]!.body as { confirm: boolean; sections: Array<{ id?: string; points: Array<{ id?: string }> }> };
	assert.equal(body.confirm, true);
	assert.equal(body.sections[0]?.id, "unit_1");
	assert.deepEqual(
		body.sections[0]?.points.map((point) => point.id),
		["topic_1", "topic_2", "topic_3", "topic_4"],
	);
	assert.deepEqual(sent, ["I've confirmed the units and topics."]);
});

// ─── registry, headlines and activity labels ───────────────────────────────

test("the renderer registry maps propose_units to the units card and the six AP trace tools to ToolCallCard", () => {
	assert.equal(artifactRenderers.propose_units, UnitsReviewCard);
	for (const tool of [
		"ap_progress",
		"ap_record_result",
		"ap_save_document",
		"pdf_info",
		"pdf_extract",
		"pdf_search",
	]) {
		assert.equal(artifactRenderers[tool], ToolCallCard, `${tool} renders the tool-call card`);
	}
	assert.equal(artifactRenderers.ap_mcq, undefined, "ap_mcq is the dock's question, never a raw-tool card");
});

test("the tool-call card headlines the AP tools' subject argument", () => {
	function headline(part: Record<string, unknown>): string {
		const html = renderPart(part);
		return html.split("<summary")[1]?.split("</summary>")[0] ?? "";
	}

	assert.match(
		headline({
			type: "tool-ap_save_document",
			state: "output-available",
			toolCallId: "c1",
			input: { kind: "ced", label: "CED", url: "https://apcentral.collegeboard.org/ced.pdf" },
			output: "Saved.",
		}),
		/apcentral\.collegeboard\.org\/ced\.pdf/,
		"the saved URL headlines",
	);
	assert.match(
		headline({
			type: "tool-ap_save_document",
			state: "output-available",
			toolCallId: "c2",
			input: { kind: "ced", label: "CED", path: "/Users/x/ced.pdf" },
			output: "Saved.",
		}),
		/\/Users\/x\/ced\.pdf/,
		"an imported local path headlines when there is no URL",
	);
	for (const tool of ["pdf_info", "pdf_extract", "pdf_search"]) {
		assert.match(
			headline({
				type: `tool-${tool}`,
				state: "output-available",
				toolCallId: "c3",
				input: { path: "/papers/ced.pdf", query: "limits", pages: "1-3" },
				output: "text",
			}),
			/\/papers\/ced\.pdf/,
			`${tool} headlines the path`,
		);
	}
	assert.match(
		headline({
			type: "tool-ap_record_result",
			state: "output-available",
			toolCallId: "c4",
			input: { topicId: "topic_7", result: "correct" },
			output: "recorded",
		}),
		/topic_7/,
		"the recorded topic headlines",
	);
});

function renderPart(part: Record<string, unknown>): string {
	// Static markup keeps the headline assertions free of an act() cycle.
	return renderToStaticMarkup(<ToolCallCard part={part as never} />);
}

test("the three AP tools name their live activity", () => {
	assert.equal(toolActivityLabel("ap_save_document"), "Saving the document…");
	assert.equal(toolActivityLabel("propose_units"), "Proposing units and topics…");
	assert.equal(toolActivityLabel("ap_progress"), "Checking progress…");
});