/**
 * PlanReviewCard (test prep, 2026-11-10): the propose_plan artifact. It
 * renders the LATEST saved record (not the tool call's arguments), shows each
 * point's source so coverage is auditable, and confirming does exactly two
 * things: one PUT with the edited sections + confirm:true, then one learner
 * message "I've confirmed the plan." through the session's normal send path
 * (ChatActionsContext — the demo card's seam).
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
import { ChatActionsContext } from "../components/chat.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { PlanReviewCard } from "../components/test-prep/plan-review-card.tsx";
import { SweepMaterialsJobCard } from "../components/artifacts/dispatch-card.tsx";
import type { JobRecord, JobStatus, LhViewMessage, TestRecord } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	// Radix's Collapsible content (the Left out list) asks the browser for
	// computed styles and animation frames; linkedom has neither.
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	IS_REACT_ACT_ENVIRONMENT: true,
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

/** The view messages a mounted proposal card sees (the chat context). */
function proposalMessages(
	toolCallIds: string[],
	state: string = "output-available",
): LhViewMessage[] {
	return toolCallIds.map((toolCallId, index) => ({
		id: `message_${index + 1}`,
		role: "assistant",
		parts: [{ type: "tool-propose_plan", toolCallId, state }],
	}));
}

function record(overrides: Partial<TestRecord> = {}): TestRecord {
	return {
		id: "test_1",
		title: "Algebra",
		createdAt: "2026-11-10T12:00:00.000Z",
		updatedAt: "2026-11-10T12:00:00.000Z",
		planConfirmed: false,
		version: 1,
		sections: [
			{
				id: "section_1",
				title: "Section A",
				points: [
					{ id: "point_1", text: "Point one", source: "outline.md", status: "unchecked", history: [] },
					{ id: "point_2", text: "Point two", source: "slides 4-6", status: "unchecked", history: [] },
				],
			},
		],
		...overrides,
	};
}

/** Mounts the card against a mock API, returning the requests it saw. */
async function mount(
	initial: TestRecord,
	options: { toolCallId?: string; messages?: LhViewMessage[] } = {},
) {
	const toolCallId = options.toolCallId ?? "call_1";
	const messages = options.messages ?? proposalMessages([toolCallId]);
	const puts: Array<{ method: string; body: unknown }> = [];
	const sent: string[] = [];
	let planGets = 0;
	let current = initial;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === "/api/chats/chat_1") return Response.json({ id: "chat_1", testId: initial.id });
		if (url === `/api/tests/${initial.id}/plan` && (init?.method ?? "GET") === "GET") {
			planGets++;
			return Response.json(current);
		}
		if (url === `/api/tests/${initial.id}/plan` && init?.method === "PUT") {
			const body = JSON.parse(String(init.body)) as {
				sections: TestRecord["sections"];
				confirm: boolean;
				leftOut?: TestRecord["leftOut"];
			};
			puts.push({ method: init.method, body });
			current = {
				...current,
				planConfirmed: body.confirm ? true : current.planConfirmed,
				sections: body.sections,
				...(body.leftOut === undefined ? {} : { leftOut: body.leftOut }),
			};
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
					messages,
					syncFromServer: async () => {},
					sendText: (text: string) => {
						sent.push(text);
					},
					openSetup: () => {},
				}}
			>
				<PlanReviewCard
					part={{
						type: "tool-propose_plan",
						state: "output-available",
						toolCallId,
						// Deliberately different from the record: the card must
						// render the saved plan, never the call arguments.
						input: {
							sections: [{ title: "From the call", points: [{ text: "Call text", source: "call.md" }] }],
						},
					}}
				/>
			</ChatActionsContext.Provider>,
		);
	});
	return { puts, sent, planGets: () => planGets };
}

test("renders each saved point with its source, not the call arguments", async () => {
	await mount(record());

	const pointOne = document.querySelector<HTMLInputElement>('input[aria-label="Section 1, point 1"]');
	const pointTwo = document.querySelector<HTMLInputElement>('input[aria-label="Section 1, point 2"]');
	assert.equal(pointOne?.value, "Point one");
	assert.equal(pointTwo?.value, "Point two");
	const sources = [...document.querySelectorAll('[data-testid="plan-source"]')].map((node) => node.textContent);
	assert.deepEqual(sources, ["outline.md", "slides 4-6"], "every point's source is shown");
	assert.ok(
		document.querySelector('[data-testid="plan-source"]')?.classList.contains("text-muted-foreground"),
		"the source is provenance, in the muted register",
	);
	assert.doesNotMatch(document.body.textContent ?? "", /Call text/, "the tool call's stale draft never wins over the saved record");
	assert.notEqual(pointOne?.value, "Call text");
});

test("Confirm sends one PUT with confirm:true carrying the ids, then one learner message", async () => {
	const { puts, sent } = await mount(record());

	const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes("Confirm plan"),
	);
	assert.ok(confirm, "the card offers Confirm plan");

	await act(async () => confirm!.click());

	assert.equal(puts.length, 1, "exactly one PUT");
	assert.equal(puts[0]!.method, "PUT");
	const body = puts[0]!.body as {
		confirm: boolean;
		sections: Array<{ id?: string; points: Array<{ id?: string }> }>;
	};
	assert.equal(body.confirm, true);
	assert.equal(body.sections[0]?.id, "section_1", "the editor carries the section id through");
	assert.deepEqual(
		body.sections[0]?.points.map((point) => point.id),
		["point_1", "point_2"],
		"the editor carries every point id through, so mergePlan keeps statuses",
	);
	assert.deepEqual(sent, ["I've confirmed the plan."], "exactly one learner message, after the PUT");
});

test("a confirmed plan collapses to a summary linking to the readiness page", async () => {
	await mount(record({ planConfirmed: true }));

	assert.ok(document.querySelector('[data-testid="plan-confirmed"]'), "confirmed summary renders");
	const link = document.querySelector<HTMLAnchorElement>('a[href="/tests/test_1"]');
	assert.ok(link, "the summary links to the readiness page");
	assert.match(document.body.textContent ?? "", /Plan confirmed/);
});

test("only the latest propose_plan card offers the editor; an earlier proposal collapses", async () => {
	const messages = proposalMessages(["call_old", "call_new"]);

	await mount(record(), { toolCallId: "call_old", messages });
	assert.ok(document.querySelector('[data-testid="plan-superseded"]'), "the superseded part collapses");
	assert.equal(document.querySelector('[data-testid="plan-editor"]'), null, "no stale editor");
	assert.ok(
		![...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Confirm plan")),
		"a superseded proposal offers no Confirm",
	);

	await unmount();

	await mount(record(), { toolCallId: "call_new", messages });
	assert.ok(document.querySelector('[data-testid="plan-editor"]'), "the latest part owns the editor");
	assert.equal(document.querySelector('[data-testid="plan-superseded"]'), null);
});

async function openLeftOut(): Promise<void> {
	const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes("Left out ("),
	);
	assert.ok(trigger, "the Left out header is a button");
	await act(async () => trigger!.click());
}

const LEFT_OUT: NonNullable<TestRecord["leftOut"]> = [
	{
		id: "lo_1",
		text: "Glossary of terms",
		reason: "reference, not tested",
		source: "ch1.pdf",
		suggestedSection: "Section A",
	},
	{
		id: "lo_2",
		text: "Extra practice",
		reason: "duplicate",
		source: "ch2.pdf",
	},
];

test("shows the sweep's coverage line above the editor", async () => {
	await mount(
		record({
			sweep: {
				status: "done",
				startedAt: "2026-11-10T12:00:00.000Z",
				fileHashes: {},
				coverage: {
					files: 3,
					pages: 120,
					visionPages: 4,
					unsupported: [],
					unreadable: [],
					empty: [],
					removed: [],
				},
			},
		}),
	);

	const line = document.querySelector('[data-testid="coverage-line"]');
	assert.ok(line, "the coverage line renders");
	assert.match(
		line!.textContent ?? "",
		/Read 3 files · 120 pages \(4 looked at by vision\)/,
		"it uses the shared coverageLine wording",
	);
});

test("Left out is collapsed with its count", async () => {
	await mount(record({ leftOut: LEFT_OUT }));

	assert.match(document.body.textContent ?? "", /Left out \(2\)/, "the header carries the count");
	assert.equal(
		document.querySelector('[data-testid="promote-left-out"]'),
		null,
		"collapsed by default — no rows yet",
	);
	assert.doesNotMatch(document.body.textContent ?? "", /Glossary of terms/);

	await openLeftOut();

	const text = document.body.textContent ?? "";
	assert.match(text, /Glossary of terms/);
	assert.match(text, /reference, not tested/, "each row shows its reason");
	assert.match(text, /ch1\.pdf/, "each row shows its source");
	assert.equal(
		document.querySelectorAll('[data-testid="promote-left-out"]').length,
		2,
		"every row offers Promote",
	);
});

test("promote moves the item into its suggested section in the editor", async () => {
	await mount(record({ leftOut: LEFT_OUT }));
	await openLeftOut();

	const promote = document.querySelector<HTMLButtonElement>('[data-testid="promote-left-out"]');
	assert.ok(promote);
	await act(async () => promote!.click());

	const values = [...document.querySelectorAll<HTMLInputElement>("input")].map((input) => input.value);
	assert.ok(values.includes("Glossary of terms"), "the item became a point in the editor");
	const sources = [...document.querySelectorAll('[data-testid="plan-source"]')].map((node) => node.textContent);
	assert.ok(sources.includes("ch1.pdf"), "its source came along");
	assert.match(document.body.textContent ?? "", /Left out \(1\)/, "the promoted item leaves the list");
});

test("confirm sends leftOut without promoted items", async () => {
	const { puts } = await mount(record({ leftOut: LEFT_OUT }));
	await openLeftOut();

	const promote = document.querySelector<HTMLButtonElement>('[data-testid="promote-left-out"]');
	assert.ok(promote);
	await act(async () => promote!.click());

	const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes("Confirm plan"),
	);
	assert.ok(confirm);
	await act(async () => confirm!.click());

	assert.equal(puts.length, 1);
	const body = puts[0]!.body as { leftOut?: Array<{ id: string }> };
	assert.deepEqual(
		body.leftOut?.map((item) => item.id),
		["lo_2"],
		"the promoted item is no longer left out",
	);
});

test("a promoted item deleted before save stays in leftOut (T10)", async () => {
	const { puts } = await mount(record({ leftOut: LEFT_OUT }));
	await openLeftOut();

	const promote = document.querySelector<HTMLButtonElement>('[data-testid="promote-left-out"]');
	assert.ok(promote);
	await act(async () => promote!.click());

	// The promoted item became point 3 of Section A; delete it again.
	const remove = document.querySelector<HTMLButtonElement>('[aria-label="Remove section 1, point 3"]');
	assert.ok(remove, "the promoted point can be removed");
	await act(async () => remove!.click());

	const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes("Confirm plan"),
	);
	assert.ok(confirm);
	await act(async () => confirm!.click());

	assert.equal(puts.length, 1);
	const body = puts[0]!.body as { leftOut?: Array<{ id: string }> };
	assert.deepEqual(
		body.leftOut?.map((item) => item.id),
		["lo_1", "lo_2"],
		"the item stays recoverable because its point never reached the saved draft",
	);
});

test("a running sweep with no sections shows its activity", async () => {
	await mount(
		record({
			sections: [],
			sweep: {
				status: "running",
				activity: "Reading ch4.pdf — page 88/312",
				startedAt: "2026-11-10T12:00:00.000Z",
				fileHashes: {},
			},
		}),
	);

	assert.match(document.body.textContent ?? "", /Reading ch4\.pdf — page 88\/312/);
	assert.equal(document.querySelector('[data-testid="plan-editor"]'), null, "no editor while sweeping");
});

test("a failed later proposal does not supersede the saved plan", async () => {
	// The failed call never saved a revision, so the record still belongs to
	// the settled call — rendering "revised below" there would hide the only
	// editable card.
	const messages: LhViewMessage[] = [
		...proposalMessages(["call_ok"]),
		...proposalMessages(["call_failed"], "output-error"),
	];

	await mount(record(), { toolCallId: "call_ok", messages });
	assert.ok(document.querySelector('[data-testid="plan-editor"]'), "the settled proposal keeps the editor");
	assert.equal(document.querySelector('[data-testid="plan-superseded"]'), null);
});

test("a running re-sweep over an existing plan does not poll over in-progress edits (T10)", async () => {
	const { planGets } = await mount(
		record({
			sweep: {
				status: "running",
				startedAt: "2026-11-10T12:00:00.000Z",
				fileHashes: {},
			},
		}),
	);

	assert.ok(document.querySelector('[data-testid="plan-editor"]'), "an existing plan stays editable while re-sweeping");
	assert.ok(!document.querySelector('[data-testid="plan-superseded"]'));
	// The poll is 2s; with sections present it must never be armed.
	await new Promise((resolve) => setTimeout(resolve, 2200));
	await act(async () => {});
	assert.equal(planGets(), 1, "only the initial load — no poll wiped the draft");
});

// ─── C1 — the swept plan is reviewable in the chat ──────────────────────────

const SWEEP_COVERAGE = {
	files: 3,
	pages: 120,
	visionPages: 4,
	unsupported: [],
	unreadable: [],
	empty: [],
	removed: [],
};

/** Mounts the sweep artifact registered for `tool-sweep_materials` against a
 *  mock plan API and a jobs feed carrying the sweep job. */
async function mountSweep(
	initial: TestRecord,
	options: { jobStatus?: JobStatus } = {},
) {
	const toolCallId = "call_sweep";
	const messages: LhViewMessage[] = [
		{
			id: "message_sweep",
			role: "assistant",
			parts: [{ type: "tool-sweep_materials", toolCallId, state: "output-available" }],
		},
	];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === "/api/chats/chat_1") return Response.json({ id: "chat_1", testId: initial.id });
		if (url === `/api/tests/${initial.id}/plan` && (init?.method ?? "GET") === "GET") {
			return Response.json(initial);
		}
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;

	const job: JobRecord = {
		id: "job_sweep",
		kind: "sweep",
		chatId: "chat_1",
		toolCallId,
		status: options.jobStatus ?? "done",
		activity: "Reading a.pdf",
		createdAt: "2026-11-10T12:00:00.000Z",
		updatedAt: "2026-11-10T12:00:00.000Z",
	};

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<JobsContext.Provider value={[job]}>
				<ChatActionsContext.Provider
					value={{
						chatId: "chat_1",
						messages,
						syncFromServer: async () => {},
						sendText: () => {},
						openSetup: () => {},
					}}
				>
					<SweepMaterialsJobCard
						part={{ type: "tool-sweep_materials", state: "output-available", toolCallId }}
					/>
				</ChatActionsContext.Provider>
			</JobsContext.Provider>,
		);
	});
}

test("a settled sweep part renders the reviewable plan: coverage line, editor and Left out (C1)", async () => {
	await mountSweep(
		record({
			leftOut: LEFT_OUT,
			sweep: {
				status: "done",
				startedAt: "2026-11-10T12:00:00.000Z",
				finishedAt: "2026-11-10T12:01:00.000Z",
				fileHashes: {},
				coverage: SWEEP_COVERAGE,
			},
		}),
	);

	assert.ok(document.querySelector('[data-testid="plan-editor"]'), "the swept plan is editable in chat");
	assert.match(
		document.querySelector('[data-testid="coverage-line"]')?.textContent ?? "",
		/Read 3 files · 120 pages \(4 looked at by vision\)/,
	);
	assert.match(document.body.textContent ?? "", /Left out \(2\)/);
});

test("a running sweep part shows the dispatch card, not a half-built editor", async () => {
	await mountSweep(record({ sections: [] }), { jobStatus: "running" });

	assert.ok(document.querySelector('[data-testid="dispatch-card"]'), "live activity while the sweep runs");
	assert.equal(document.querySelector('[data-testid="plan-editor"]'), null);
});