/**
 * AP's generated free-response question and drawn figures in the question UI
 * (AP prep stage 3, task 6). A generated question is posed by the same
 * multi-part form as a released one: the header `AP · generated`, the title,
 * details, the figure, the stem and one answer box per part — everything
 * shown comes from `apFrqGenDisplay` of the call input, so no committed
 * answer or rubric point reaches a screen. The answered card replays the same
 * projected fields and the learner's own words. An `ap_mcq` carrying a figure
 * shows it above the question in both the live form and the answered card.
 *
 * tsx ignores tsconfig's `jsx` field and uses the CLASSIC transform, so React
 * must be a resolvable global before this module's JSX runs (same shim as
 * tests/ap-frq-ui.test.tsx).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { QuestionFigure } from "../components/ap/question-figure.tsx";
import { FrqGenQuestionForm, frqGenAnswerRequest } from "../components/ap/frq-question.tsx";
import { apFrqGenDisplay, buildAnswer, type ApFrqGenToolInput, type QuestionAnswerData, type QuestionData } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const generatedInput: ApFrqGenToolInput = {
	title: "Rates of change in a cooling model",
	stem: "A cup of coffee cools in a room kept at 20 degrees.",
	parts: [
		{
			label: "a",
			prompt: "Find the average rate of change.",
			topicId: "t11",
			answer: "COMMITTED-ANSWER-ALPHA",
			points: ["RUBRIC-POINT-ONE", "RUBRIC-POINT-TWO"],
		},
		{
			label: "b",
			prompt: "Interpret your answer.",
			topicId: "t11",
			answer: "COMMITTED-ANSWER-BETA",
			points: ["RUBRIC-POINT-THREE"],
		},
	],
	details: "Show your work.",
	figure: "fig_1",
};

const SECRETS = ["COMMITTED-ANSWER-ALPHA", "COMMITTED-ANSWER-BETA", "RUBRIC-POINT-ONE", "RUBRIC-POINT-TWO", "RUBRIC-POINT-THREE"];

function renderGenerated(overrides: Partial<React.ComponentProps<typeof FrqGenQuestionForm>> = {}) {
	return renderToStaticMarkup(
		<FrqGenQuestionForm
			toolCallId="gen1"
			chatId="chat1"
			question={apFrqGenDisplay(generatedInput)}
			onSubmit={() => {}}
			{...overrides}
		/>,
	);
}

function generatedQD(): QuestionData {
	return {
		id: "gen1",
		kind: "frq",
		question: generatedInput.title,
		mode: "text",
		options: [],
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function answeredGenerated(overrides: Partial<QuestionAnswerData> = {}): QuestionAnswerData {
	return {
		kind: "frq",
		tool: "ap_frq_gen",
		questionText: generatedInput.title,
		options: [],
		dontKnow: false,
		answers: [],
		parts: [
			{ label: "a", text: "The coffee loses twelve degrees every minute." },
			{ label: "b", text: "" },
		],
		photos: ["C:\\Users\\kevin\\work\\page.png"],
		frq: { questionId: "gen-gen1", title: generatedInput.title },
		answeredAt: new Date().toISOString(),
		...overrides,
	};
}

const apMcqInput = {
	topicId: "1.1",
	question: "Which expression is the derivative of x²?",
	options: [
		{ label: "2x", value: "2x" },
		{ label: "x", value: "x" },
		{ label: "x²/2", value: "x^2/2" },
		{ label: "2", value: "2" },
	],
	correctAnswer: "2x",
	optionNotes: [
		"Right answer: the power rule gives 2x.",
		"Wrong answer: the factor of two is dropped.",
		"Wrong answer: that is the antiderivative, not the derivative.",
		"Wrong answer: that is the derivative of 2x.",
	],
	details: "Use the power rule: d/dx xⁿ = n·xⁿ⁻¹.",
};

function answeredApMcq(overrides: Partial<QuestionAnswerData> = {}): QuestionAnswerData {
	return {
		kind: "quiz",
		tool: "ap_mcq",
		questionText: apMcqInput.question,
		options: apMcqInput.options.map((option, index) => ({ index: index + 1, label: option.label })),
		dontKnow: false,
		answers: [{ index: 1, label: "2x", value: "2x" }],
		thinking: "I used the power rule.",
		correct: true,
		correctIndices: [1],
		explanation: "A model-authored explanation.",
		answeredAt: new Date().toISOString(),
		...overrides,
	};
}

describe("AP: the live ap_frq_gen form", () => {
	it("shows the header, title, details, figure, stem and one labelled box per part", () => {
		const html = renderGenerated();
		assert.match(html, /AP · generated/);
		assert.ok(html.includes(generatedInput.title), "the title renders");
		assert.ok(html.includes(generatedInput.details!), "the call's details render");
		assert.match(html, /src="\/api\/chats\/chat1\/figures\/fig_1"/);
		assert.match(html, /alt="Figure for this question"/);
		assert.match(html, /loading="lazy"/);
		assert.ok(html.includes(generatedInput.stem), "the stem renders");
		for (const part of generatedInput.parts) assert.ok(html.includes(part.prompt), `part ${part.label}'s prompt renders`);
		for (const part of generatedInput.parts) assert.ok(html.includes(`(${part.label})`), `part ${part.label} is labelled`);
		assert.equal((html.match(/data-file-path-input=""/g) ?? []).length, 2, "one answer box per part");
		assert.match(html, /Attach photo/);
		assert.match(html, /I don(?:&#x27;|'|’)t know/);
		assert.ok(!html.includes('data-testid="confidence-slider"'), "no confidence slider on a free-response question");
	});

	it("renders nothing of the committed answers or rubric points", () => {
		const html = renderGenerated();
		for (const secret of SECRETS) assert.ok(!html.includes(secret), `${secret} never reaches the form`);
	});

	it("fetches nothing: the dock poses a generated question from the call input alone", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="ap_frq_gen"
				toolCallId="gen1"
				input={generatedInput as never}
				chatId="chat1"
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /AP · generated/);
		assert.ok(html.includes(generatedInput.title));
		assert.ok(html.includes(generatedInput.stem));
		for (const part of generatedInput.parts) assert.ok(html.includes(part.prompt), part.prompt);
		assert.match(html, /src="\/api\/chats\/chat1\/figures\/fig_1"/);
		for (const secret of SECRETS) assert.ok(!html.includes(secret), `${secret} never reaches the transcript`);
		assert.ok(!html.includes("Loading the question…"), "a generated question never fetches");
	});

	it("labels the collapsed bar AP · generated with the free-response teaser", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="ap_frq_gen"
				toolCallId="gen1"
				input={generatedInput as never}
				chatId="chat1"
				expanded={false}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="question-dock-bar"'), "the collapsed bar renders");
		assert.match(html, /data-testid="question-dock-bar"[\s\S]*?AP · generated/);
		assert.match(html, /data-testid="question-dock-bar"[\s\S]*?Free-response question/);
	});

	it("builds the answer request with every part in display order and the derived question id", () => {
		const req = frqGenAnswerRequest(apFrqGenDisplay(generatedInput), "call_1", {
			parts: { b: "second", a: "first" },
			photos: ["C:\\work\\page.png"],
			dontKnow: false,
		});
		assert.deepEqual(req.parts, [
			{ label: "a", text: "first" },
			{ label: "b", text: "second" },
		]);
		assert.deepEqual(req.frq, {
			questionId: "gen-call_1",
			title: generatedInput.title,
		});
		assert.deepEqual(req.photos, ["C:\\work\\page.png"]);
		assert.equal(req.dontKnow, false);
	});
});

describe("AP: the answered ap_frq_gen card", () => {
	it("replays the title, figure, stem and each part's prompt with the learner's words", () => {
		const html = renderToStaticMarkup(
			<AnsweredCard answer={answeredGenerated()} input={generatedInput} chatId="chat1" />,
		);
		assert.match(html, /AP · generated/);
		assert.ok(html.includes(generatedInput.title));
		assert.match(html, /src="\/api\/chats\/chat1\/figures\/fig_1"/);
		assert.ok(html.includes(generatedInput.stem));
		for (const part of generatedInput.parts) {
			assert.ok(html.includes(`(${part.label})`), part.label);
			assert.ok(html.includes(part.prompt), part.prompt);
		}
		assert.ok(html.includes("The coffee loses twelve degrees every minute."));
		assert.ok(html.includes("—"), "a blank part renders an em dash");
		assert.ok(html.includes("Photo attached"));
		assert.ok(html.includes("page.png"), "the photo's file name renders");
		assert.ok(!html.includes("Users"), "the photo's full path never renders");
	});

	it("replays the call's details line", () => {
		const html = renderToStaticMarkup(
			<AnsweredCard answer={answeredGenerated()} input={generatedInput} chatId="chat1" />,
		);
		assert.ok(html.includes(generatedInput.details!), "the details line renders");
		for (const secret of SECRETS) assert.ok(!html.includes(secret), `${secret} never reaches the card`);
	});

	it("carries no committed answer, rubric point, verdict or confidence record", () => {
		const html = renderToStaticMarkup(
			<AnsweredCard answer={answeredGenerated()} input={generatedInput} chatId="chat1" />,
		);
		for (const secret of SECRETS) assert.ok(!html.includes(secret), `${secret} never reaches the card`);
		assert.ok(!html.includes('data-testid="tucked-explanation"'), "no Why control");
		assert.ok(!html.includes('data-testid="answered-confidence"'), "no confidence rail");
		assert.ok(!html.includes('data-mark'), "no mark glyph");
		assert.ok(!html.includes(">correct<"), "no correct chip");
		assert.ok(!html.includes("incorrect"), "no incorrect chip");
	});

	it("says I don't know when that was the answer", () => {
		const html = renderToStaticMarkup(
			<AnsweredCard
				answer={answeredGenerated({ dontKnow: true, parts: undefined, photos: [] })}
				input={generatedInput}
				chatId="chat1"
			/>,
		);
		assert.match(html, /Answered [“"]I don(?:&#x27;|'|’)t know[”"]\./);
	});
});

describe("AP: ap_mcq with a figure", () => {
	it("shows the figure above the question in the live form", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="ap_mcq"
				toolCallId="ap1"
				input={{ ...apMcqInput, figure: "fig_1" } as never}
				chatId="chat1"
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /src="\/api\/chats\/chat1\/figures\/fig_1"/);
		assert.match(html, /alt="Figure for this question"/);
		assert.ok(
			html.indexOf("/figures/fig_1") < html.indexOf(apMcqInput.question),
			"the figure sits above the question",
		);
	});

	it("shows the figure above the question in the answered card", () => {
		const html = renderToStaticMarkup(
			<AnsweredCard
				answer={answeredApMcq()}
				input={{ ...apMcqInput, figure: "fig_1" }}
				chatId="chat1"
			/>,
		);
		assert.match(html, /src="\/api\/chats\/chat1\/figures\/fig_1"/);
		assert.ok(
			html.indexOf("/figures/fig_1") < html.indexOf(apMcqInput.question),
			"the figure sits above the question",
		);
	});

	it("is byte-for-byte unchanged without a figure, with or without a chat id", () => {
		const form = (props: { chatId?: string } = {}) =>
			renderToStaticMarkup(
				<QuestionDock
					toolName="ap_mcq"
					toolCallId="ap1"
					input={apMcqInput as never}
					expanded={true}
					onExpand={() => {}}
					onSubmit={() => {}}
					{...props}
				/>,
			);
		assert.equal(form({ chatId: "chat1" }), form(), "no chat id changes a figure-less form");
		assert.ok(!form({ chatId: "chat1" }).includes("/figures/"), "no figure URL without a figure");

		const card = (props: { chatId?: string } = {}) =>
			renderToStaticMarkup(<AnsweredCard answer={answeredApMcq()} input={apMcqInput} {...props} />);
		assert.equal(card({ chatId: "chat1" }), card(), "no chat id changes a figure-less card");
		assert.ok(!card({ chatId: "chat1" }).includes("/figures/"), "no figure URL without a figure");
	});
});

describe("QuestionFigure", () => {
	it("says so when the image fails to load", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () => {
				root.render(<QuestionFigure chatId="chat1" figure="fig_1" />);
			});
			const image = host.querySelector("img");
			assert.ok(image, "the image renders");
			await act(async () => {
				image.dispatchEvent(new dom.window.Event("error"));
			});
			assert.ok(
				(host.textContent ?? "").includes("This figure could not be shown."),
				"a failed image is reported in words",
			);
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});