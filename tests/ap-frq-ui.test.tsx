/**
 * AP's `ap_frq` in the question UI (stage 2, task 10): a released
 * free-response question is shown as its original page images with one
 * answer box per part, an optional photo attach and one Submit — never a
 * confidence slider, never the rubric. The answered card replays the parts,
 * the photos' file names and the page images (behind "Show question"), with
 * no verdict of any kind: the tutor's `ap_record_frq` result is the only
 * verdict surface (stage 2 global constraint).
 *
 * tsx ignores tsconfig's `jsx` field and uses the CLASSIC transform, so React
 * must be a resolvable global before this module's JSX runs (same shim as
 * tests/ap-question-ui.test.tsx).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import {
	FrqQuestion,
	FrqQuestionBody,
	FrqQuestionForm,
	frqAnswerRequest,
	frqFormDraft,
	type ApFrqQuestionView,
} from "../components/ap/frq-question.tsx";
import type { QuestionAnswerData, QuestionFormDraft } from "../src/core/index.ts";

// linkedom gives createRoot a document for the one test that mounts the
// fetch container; the server-render tests never touch it (the chatgpt-ui
// shim).
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const question: ApFrqQuestionView = {
	id: "2023-2",
	title: "2023 FRQ 2",
	file: "frq-2023.pdf",
	pages: [5, 6],
	present: true,
	parts: [
		{ label: "a", topicId: "topic_1", topicText: "1.1 Average rates of change" },
		{ label: "b" },
		{ label: "c-i" },
	],
};

const details = "Show every step of the reasoning.";

// Server render never runs effects, so no request may leave this test.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("CLOSED: the server-rendered form must not fetch");
};
after(() => {
	globalThis.fetch = originalFetch;
});

function renderForm(overrides: Partial<React.ComponentProps<typeof FrqQuestionForm>> = {}, draft?: QuestionFormDraft) {
	return renderToStaticMarkup(
		<FrqQuestionForm
			toolCallId="frq1"
			apCourseId="ap_1"
			question={question}
			details={details}
			onSubmit={() => {}}
			initialDraft={draft}
			{...overrides}
		/>,
	);
}

/** A persisted ap_frq answer record (the tutor's verdict is not in it). */
function answeredFrq(overrides: Partial<QuestionAnswerData> = {}): QuestionAnswerData {
	return {
		kind: "frq",
		tool: "ap_frq",
		questionText: question.title,
		options: [],
		dontKnow: false,
		answers: [],
		parts: [
			{ label: "a", text: "The average rate is 12." },
			{ label: "b", text: "" },
		],
		photos: ["C:\\Users\\kevin\\work\\page.png"],
		frq: { questionId: question.id, title: question.title, file: question.file, pages: [...question.pages] },
		answeredAt: new Date().toISOString(),
		...overrides,
	};
}

describe("AP: the live ap_frq dock", () => {
	it("shows the title and one labelled box per part, the topic tag, photo attach and no confidence slider", () => {
		const html = renderForm();
		assert.match(html, /AP · released/);
		assert.ok(html.includes(question.title), "the question title renders");
		assert.ok(html.includes(details), "the call's details render");
		for (const label of ["(a)", "(b)", "(c-i)"]) assert.ok(html.includes(label), `part ${label} is labelled`);
		assert.ok(html.includes(question.parts[0]!.topicText!), "the part's topic tag renders");
		assert.equal((html.match(/data-file-path-input=""/g) ?? []).length, 3, "one answer box per part");
		assert.match(html, /Attach photo/);
		assert.match(html, /I don(?:&#x27;|'|’)t know/);
		assert.ok(!html.includes('data-testid="confidence-slider"'), "no confidence slider on a free-response question");
	});

	it("names each answer box with its part label and, when known, its topic", () => {
		const html = renderForm();
		assert.match(html, /aria-label="\(a\) 1\.1 Average rates of change"/);
		assert.match(html, /aria-label="\(b\)"/);
		assert.match(html, /aria-label="\(c-i\)"/);
	});

	it("loads the original page images in order, from the course's page route", () => {
		const html = renderForm();
		assert.match(html, /src="\/api\/ap\/ap_1\/pages\/frq-2023\.pdf\/5"/);
		assert.match(html, /src="\/api\/ap\/ap_1\/pages\/frq-2023\.pdf\/6"/);
		assert.match(html, /alt="2023 FRQ 2 — page 5"/);
		assert.match(html, /alt="2023 FRQ 2 — page 6"/);
		assert.match(html, /loading="lazy"/);
	});

	it("submits only with a part filled, a photo attached or I don't know", () => {
		assert.match(renderForm(), /<button[^>]*type="submit"[^>]*disabled=""/);
		const onePart = frqFormDraft({ parts: { a: "12" }, photos: [] });
		assert.ok(
			!/<button[^>]*type="submit"[^>]*disabled=""/.test(renderForm({}, onePart)),
			"one part is a complete answer",
		);
		const photoOnly = frqFormDraft({ parts: {}, photos: ["C:\\work\\page.png"] });
		assert.ok(
			!/<button[^>]*type="submit"[^>]*disabled=""/.test(renderForm({}, photoOnly)),
			"an attached photo is a complete answer",
		);
		const dontKnow = frqFormDraft({ parts: {}, photos: [], dontKnow: true });
		assert.ok(
			!/<button[^>]*type="submit"[^>]*disabled=""/.test(renderForm({}, dontKnow)),
			"I don't know is a complete answer",
		);
	});

	it("shows each photo by its file name only and stops attaching at six", () => {
		const one = renderForm({}, frqFormDraft({ parts: {}, photos: ["C:\\Users\\kevin\\work\\page.png"] }));
		assert.ok(one.includes("Remove photo page.png"), "the remove control is labelled with the file name");
		assert.ok(!one.includes("Users"), "the photo's full path never renders");
		const six = renderForm(
			{},
			frqFormDraft({ parts: {}, photos: Array.from({ length: 6 }, (_, index) => `C:\\work\\p${index}.png`) }),
		);
		assert.match(six, /<button[^>]*disabled=""[^>]*>Attach photo<\/button>/, "six photos is the cap");
	});

	it("disables the part boxes and photo removal under I don't know but keeps their content", () => {
		const html = renderForm(
			{},
			frqFormDraft({ parts: { a: "kept answer" }, photos: ["C:\\work\\page.png"], dontKnow: true }),
		);
		assert.ok(html.includes("kept answer"), "the typed content stays visible");
		assert.ok(html.includes('aria-disabled="true"'), "the part boxes are disabled");
		assert.ok(html.includes('tabindex="-1"'), "a disabled part box is out of the tab order");
		assert.match(html, /aria-pressed="true"/);
		assert.match(
			html,
			/<button[^>]*aria-label="Remove photo page\.png"[^>]*disabled=""/,
			"the photo's remove control is disabled",
		);
	});

	it("builds the answer request with every part in route order and the fetched question block", () => {
		const req = frqAnswerRequest(question, {
			parts: { "c-i": "third", a: "first" },
			photos: ["C:\\work\\page.png"],
			dontKnow: false,
		});
		assert.deepEqual(req.parts, [
			{ label: "a", text: "first" },
			{ label: "b", text: "" },
			{ label: "c-i", text: "third" },
		]);
		assert.equal(req.frq?.questionId, question.id, "the block's id is the fetched question's id");
		assert.deepEqual(req.frq, {
			questionId: "2023-2",
			title: "2023 FRQ 2",
			file: "frq-2023.pdf",
			pages: [5, 6],
		});
		assert.deepEqual(req.photos, ["C:\\work\\page.png"]);
		assert.equal(req.dontKnow, false);
	});

	it("says the paper is absent, links to the course page and disables Submit", () => {
		const html = renderForm({ question: { ...question, present: false } });
		assert.ok(html.includes("This paper is not on this computer. Download it from the course page."));
		assert.match(html, /href="\/ap\/ap_1"/);
		assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
		assert.ok(!html.includes("/pages/frq-2023.pdf/"), "no page image is requested for an absent paper");
	});

	it("carries the course id across the fetch boundary into the pages and the absent-paper link", () => {
		const ready = renderToStaticMarkup(
			<FrqQuestionBody
				state={{ status: "ready", question }}
				toolCallId="frq1"
				apCourseId="ap_1"
				details={details}
				onSubmit={() => {}}
			/>,
		);
		assert.match(ready, /src="\/api\/ap\/ap_1\/pages\/frq-2023\.pdf\/5"/);
		assert.ok(!ready.includes("/api/ap//pages/"), "the page route never gets an empty course id");

		const absent = renderToStaticMarkup(
			<FrqQuestionBody
				state={{ status: "ready", question: { ...question, present: false } }}
				toolCallId="frq1"
				apCourseId="ap_1"
				details={details}
				onSubmit={() => {}}
			/>,
		);
		assert.match(absent, /href="\/ap\/ap_1"/);
	});

	it("mounts the fetch container so the loaded question keeps the course id", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const stubbed = globalThis.fetch;
		globalThis.fetch = (async () =>
			({ ok: true, json: async () => question }) as Response) as typeof fetch;
		try {
			await act(async () => {
				root.render(
					<FrqQuestion
						questionId="2023-2"
						apCourseId="ap_1"
						toolCallId="frq1"
						details={details}
						onSubmit={() => {}}
					/>,
				);
			});
			// The loaded question opens as the full-screen workspace, which is
			// portaled into document.body — the host itself is left empty.
			const stage = document.body.querySelector('[data-testid="frq-stage"]');
			assert.ok(stage, "the fetched question is posed");
			assert.match(stage.textContent ?? "", /2023 FRQ 2/, "the fetched question is posed");
			assert.equal(
				stage.querySelector("img")?.getAttribute("src"),
				"/api/ap/ap_1/pages/frq-2023.pdf/5",
				"the course id reaches the page images",
			);
			assert.ok(!(stage.innerHTML ?? "").includes("/api/ap//pages/"), "never an empty course id");
		} finally {
			globalThis.fetch = stubbed;
			await act(async () => root.unmount());
			host.remove();
			// The workspace is a portal on document.body: unmounting removes it,
			// but never let a leftover stage pose as another test's question.
			for (const leftover of document.body.querySelectorAll('[data-testid="frq-stage"]')) leftover.remove();
		}
	});

	it("is delegated to by the dock: loading state and AP · released", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="ap_frq"
				toolCallId="frq1"
				input={{ questionId: "2023-2", details } as never}
				apCourseId="ap_1"
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /AP · released/);
		assert.match(html, /Loading the question…/);
		assert.ok(!html.includes("could not be displayed"), "the old fallback is gone");
	});

	it("labels the collapsed bar AP · released", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="ap_frq"
				toolCallId="frq1"
				input={{ questionId: "2023-2" } as never}
				apCourseId="ap_1"
				expanded={false}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="question-dock-bar"'), "the collapsed bar renders");
		assert.match(html, /data-testid="question-dock-bar"[\s\S]*?AP · released/);
		assert.match(html, /data-testid="question-dock-bar"[\s\S]*?Free-response question/);
	});
});

describe("AP: the answered ap_frq card", () => {
	it("replays the parts with blank parts as an em dash, the photos by name and I don't know", () => {
		const html = renderToStaticMarkup(
			<AnsweredCard
				answer={answeredFrq({ dontKnow: true })}
				input={{ questionId: question.id, details }}
				apCourseId="ap_1"
			/>,
		);
		assert.match(html, /AP · released/);
		assert.ok(html.includes(question.title));
		assert.ok(html.includes(details), "the call's details render");
		assert.ok(html.includes("(a)"));
		assert.ok(html.includes("(b)"));
		assert.ok(html.includes("The average rate is 12."));
		assert.ok(html.includes("—"), "a blank part renders an em dash");
		assert.ok(html.includes("Photo attached"));
		assert.ok(html.includes("page.png"), "the photo's file name renders");
		assert.ok(!html.includes("Users"), "the photo's full path never renders");
		assert.match(html, /I don(?:&#x27;|'|’)t know/);
	});

	it("puts the page images behind Show question", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={answeredFrq()} apCourseId="ap_1" />);
		assert.match(html, /Show question/);
		assert.ok(!html.includes("/api/ap/ap_1/pages/frq-2023.pdf/5"), "pages stay collapsed until asked for");
	});

	it("renders an old answer without pages when frq is missing", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={answeredFrq({ frq: undefined })} apCourseId="ap_1" />);
		assert.ok(html.includes("(a)"));
		assert.ok(!html.includes("Show question"), "no page toggle without the frq block");
	});

	it("carries no verdict and no rubric of any kind", () => {
		const html = renderToStaticMarkup(
			<AnsweredCard
				answer={answeredFrq()}
				input={{ questionId: question.id, rubric: ["SECRET RUBRIC POINT"] }}
				apCourseId="ap_1"
			/>,
		);
		assert.ok(!html.includes("SECRET RUBRIC POINT"), "the rubric never reaches the card");
		assert.ok(!html.includes('data-testid="tucked-explanation"'), "no Why control");
		assert.ok(!html.includes('data-testid="answered-confidence"'), "no confidence rail");
		assert.ok(!html.includes('data-testid="answered-other"'), "no option answer UI");
		assert.ok(!html.includes("incorrect"), "no incorrect chip");
		assert.ok(!html.includes(">correct<"), "no correct chip");
		assert.ok(!html.includes("data-mark"), "no mark glyph");
		assert.ok(!html.includes("text-red-") && !html.includes("border-red-"), "no red marking");
		assert.ok(!html.includes("text-green-") && !html.includes("border-green-"), "no green marking");
	});
});

describe("AP: the released question's full-screen workspace (issue #7)", () => {
	it("offers the workspace from the dock and renders the dock layout on the server", () => {
		const html = renderForm();
		assert.match(html, /Open full screen/);
		assert.ok(!html.includes('data-testid="frq-stage"'), "the workspace is a client-side surface");
		assert.equal((html.match(/data-file-path-input=""/g) ?? []).length, 3, "the dock keeps one box per part");
	});

	it("opens pages-left / boxes-right when the question is posed, and Close returns to the dock", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () => {
				root.render(
					<FrqQuestionForm
						toolCallId="frq1"
						apCourseId="ap_1"
						question={question}
						details={details}
						onSubmit={() => {}}
					/>,
				);
			});
			const stage = document.body.querySelector('[data-testid="frq-stage"]');
			assert.ok(stage, "the workspace opens with the question");
			assert.equal(stage.getAttribute("role"), "dialog", "it is a modal surface");
			assert.equal(stage.getAttribute("aria-modal"), "true");
			assert.match(stage.innerHTML, /\/api\/ap\/ap_1\/pages\/frq-2023\.pdf\/5/, "the paper pages are in the workspace");
			assert.equal(
				stage.querySelectorAll('[data-file-path-input=""]').length,
				3,
				"one answer box per part sits beside the pages",
			);
			assert.match(stage.innerHTML, /Submit answer/);
			const close = Array.from(stage.querySelectorAll("button")).find((button) => button.textContent === "Close");
			assert.ok(close, "the workspace can be closed");
			await act(async () => {
				(close as HTMLElement).click();
			});
			assert.equal(document.body.querySelector('[data-testid="frq-stage"]'), null, "Close leaves the workspace");
			assert.ok(host.querySelector('[data-testid="question-dock"]'), "the dock is back in the composer");
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
