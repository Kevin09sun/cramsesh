/**
 * THE FREE-RESPONSE SCORE CARD (AP prep stage 2, Task 11): the one verdict
 * surface for a released question. It renders only from `ap_record_frq`'s
 * result details — a header (`<title> — scored <earned>/<total>`) and one
 * row per part with its points, topic and outcome word. A refused call, a
 * still-streaming part or any malformed output renders nothing at all.
 *
 * Also pins the remaining AP tool wiring: the registry rows (the score card,
 * the indexing dispatch card, the retag trace card — and the deliberate
 * absence of ap_frq / ap_rubric / ap_view_photo), the retag headline, the
 * three live-activity labels, and the index job's steer card.
 *
 * tsx ignores tsconfig's `jsx` field and uses the CLASSIC transform, so React
 * must be a resolvable global before this module's JSX runs (the same shim
 * as tests/ap-course-ui.test.tsx).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { FrqScoreCard } from "../components/ap/frq-score-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { ApIndexJobCard } from "../components/artifacts/dispatch-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { toolActivityLabel } from "../src/core/pending.ts";
import { projectView } from "../src/core/view.ts";
import type { ApIndexResult } from "../src/core/contracts.ts";

/** The preview's example: 6 of 9 points, earned / missed / missed. */
const PREVIEW = {
	questionId: "2023-2",
	title: "2023 FRQ 2",
	earned: 6,
	total: 9,
	parts: [
		{ label: "a", earned: 4, total: 4, topicText: "1.1 Average rates of change", outcome: "earned" },
		{ label: "b", earned: 2, total: 3, topicText: "2.1 Definition of the derivative", outcome: "missed" },
		{ label: "c", earned: 0, total: 2, topicText: "3.1 The chain rule", outcome: "missed" },
	],
};

function renderScoreCard(output: unknown, state = "output-available"): string {
	return renderToStaticMarkup(
		<FrqScoreCard part={{ type: "tool-ap_record_frq", state, toolCallId: "call_score", output }} />,
	);
}

function documentOf(html: string) {
	return parseHTML(`<html><body>${html}</body></html>`).document;
}

/** Each row's visible cells, in order: label, points, topic (when present),
 *  outcome. */
function rows(html: string): string[][] {
	const doc = documentOf(html);
	return [...doc.querySelectorAll('[data-testid="score-part"]')].map((row) =>
		Array.from(
			(row as unknown as { children: ArrayLike<{ textContent: string | null }> }).children,
			(cell) => cell.textContent ?? "",
		),
	);
}

describe("FrqScoreCard", () => {
	it("renders the preview's 6/9 card: header, then each part's points, topic and outcome", () => {
		const html = renderScoreCard(PREVIEW);
		assert.ok(html.length > 0, "a valid result renders the card");
		assert.equal(
			documentOf(html).querySelector('[data-testid="score-header"]')?.textContent,
			"2023 FRQ 2 — scored 6/9",
		);
		assert.deepEqual(rows(html), [
			["(a)", "4/4", "1.1 Average rates of change", "earned"],
			["(b)", "2/3", "2.1 Definition of the derivative", "missed"],
			["(c)", "0/2", "3.1 The chain rule", "missed"],
		]);
	});

	it("an untagged part reads not counted and carries no topic text", () => {
		const html = renderScoreCard({
			...PREVIEW,
			questionId: "2023-3",
			title: "2023 FRQ 3",
			earned: 1,
			total: 4,
			parts: [
				{ label: "a", earned: 1, total: 2, topicText: "1.1 Average rates of change", outcome: "missed" },
				{ label: "c", earned: 0, total: 2, outcome: "not counted" },
			],
		});
		assert.deepEqual(rows(html), [
			["(a)", "1/2", "1.1 Average rates of change", "missed"],
			["(c)", "0/2", "not counted"],
		]);
	});

	it("renders nothing for a refused call, a still-streaming part or malformed details", () => {
		assert.equal(
			renderScoreCard({ tool: "ap_record_frq", problems: ["the learner has not answered this question"] }),
			"",
			"a refused call's invalid-input details render nothing",
		);
		assert.equal(renderScoreCard(PREVIEW, "input-streaming"), "", "a still-streaming part renders nothing");
		assert.equal(renderScoreCard(undefined), "", "no output renders nothing");
		assert.equal(
			renderScoreCard({ ...PREVIEW, parts: [{ label: "a", earned: 1, total: 1, outcome: "perfect" }] }),
			"",
			"an unknown outcome word fails the shape guard",
		);
	});
});

describe("the remaining AP tool wiring", () => {
	it("the registry maps the score card, the index dispatch card and the retag trace card", () => {
		assert.equal(artifactRenderers.ap_record_frq, FrqScoreCard);
		assert.equal(artifactRenderers.ap_record_gen, FrqScoreCard);
		assert.equal(artifactRenderers.ap_index_papers, ApIndexJobCard);
		assert.equal(artifactRenderers.ap_retag_part, ToolCallCard);
	});

	it("omits ap_frq, ap_frq_gen, ap_rubric, ap_view_photo and ap_view_figure so none prints its raw input or output", () => {
		assert.equal(artifactRenderers.ap_frq, undefined);
		assert.equal(artifactRenderers.ap_frq_gen, undefined);
		assert.equal(artifactRenderers.ap_rubric, undefined);
		assert.equal(artifactRenderers.ap_view_photo, undefined);
		assert.equal(artifactRenderers.ap_view_figure, undefined);
	});

	it("the tool-call card headlines the retagged question id", () => {
		const html = renderToStaticMarkup(
			<ToolCallCard
				part={{
					type: "tool-ap_retag_part",
					state: "output-available",
					toolCallId: "call_retag",
					input: { questionId: "2023-2", part: "a", topicId: "t_limits" },
					output: "Part (a) of 2023 FRQ 2 is now tagged.",
				}}
			/>,
		);
		const summary = html.split("<summary")[1]?.split("</summary>")[0] ?? "";
		assert.match(summary, /ap_retag_part/);
		assert.match(summary, /2023-2/);
	});

	it("names each new AP tool's live activity", () => {
		assert.equal(toolActivityLabel("ap_rubric"), "Reading the scoring guideline…");
		assert.equal(toolActivityLabel("ap_view_photo"), "Looking at your photo…");
		assert.equal(toolActivityLabel("ap_view_figure"), "Checking the figure…");
		assert.equal(toolActivityLabel("ap_record_frq"), "Recording the score…");
		assert.equal(toolActivityLabel("ap_record_gen"), "Recording the score…");
	});
});

describe("the ap_index steer card", () => {
	function steerHtml(result: ApIndexResult): string {
		const steer = buildSubagentSteer({ id: "jai", kind: "ap_index", toolCallId: "cai" }, result);
		return renderToStaticMarkup(<SubagentSteerCard message={projectView([steer])[0] as never} />);
	}

	it("shows the indexing brief under Released papers indexed", () => {
		const html = steerHtml({
			brief: "Indexed 12 questions from 2 papers; 1 part has no topic tag.",
			indexed: [
				{ paperId: "frq-2023", questions: 6 },
				{ paperId: "frq-2024", questions: 6 },
			],
			failed: [],
			untagged: 1,
		});
		assert.match(html, /Released papers indexed/);
		assert.ok(html.includes("Indexed 12 questions from 2 papers"), "the brief text renders");
	});

	it("shows the failure brief under Indexing failed", () => {
		const html = steerHtml({
			brief: "Indexing failed: frq-2023 could not be read on this computer",
			indexed: [],
			failed: [],
			untagged: 0,
		});
		assert.match(html, /Indexing failed/);
		assert.ok(html.includes("could not be read on this computer"), "the failure brief renders");
	});
});