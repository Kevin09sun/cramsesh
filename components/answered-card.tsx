"use client";

import { useState } from "react";
import { ConfidenceRail } from "@/components/confidence-rail";
import { photoName } from "@/components/ap/photo-name";
import { QuestionFigure } from "@/components/ap/question-figure";
import { QuestionPages } from "@/components/ap/question-pages";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { ThinkingBlock } from "@/components/thinking-block";
import { PathText } from "@/components/file-path-chip";
import { cn } from "@/lib/utils";
import { ToolContentResponse } from "@/components/ai-elements/message";
import type { QuestionAnswerData } from "@/src/core";
import {
	answerForPresentation,
	apFrqGenDisplay,
	parseApFrqGenInput,
	parseApFrqInput,
	parseApMcqInput,
	parseAskInput,
	parseExplainInput,
	parseQuizInput,
} from "@/src/core";

/**
 * Static rendering of an answered question (tool part in `output-available`).
 *
 * Quiz answers are GRADED: ✓/✗ marks, the correct answers, and the
 * explanation. Ask answers are NOT graded — a plain record of what was said.
 * (The v1 bug this pins: ask answers must never get quiz grading UI.)
 * Explain answers are graded by the MODEL in its next reply, not by the
 * client — the card reveals his answer, the committed correct answer, and
 * the explanation, with NO verdict chips (owner ruling 2026-09-27).
 */
export function AnsweredCard({
	answer: savedAnswer,
	input,
	apCourseId,
	chatId,
}: {
	answer: QuestionAnswerData;
	input?: unknown;
	/** The AP course the released question belongs to (ap_frq only): the
	 *  "Show question" page images load through its route. */
	apCourseId?: string;
	/** The chat whose figure route serves an ap_mcq's drawing (stage 3). */
	chatId?: string;
}) {
	const answer = answerForPresentation(savedAnswer, input);
	const [whyOpen, setWhyOpen] = useState(false); // the tucked explanation (predictions, owner 2026-10-03)
	if (answer.dismissed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				<span className="font-medium">{answer.questionText}</span> — skipped
			</div>
		);
	}
	// AP's answered free-response record is a record of parts and photos —
	// never a verdict (the tutor's score card is the only verdict surface).
	// A generated question replays its projected fields (stage 3) from the
	// call input; a released one keeps its paper pages.
	if (answer.kind === "frq")
		return answer.tool === "ap_frq_gen" ? (
			<FrqGenAnsweredCard answer={answer} input={input} chatId={chatId} />
		) : (
			<FrqAnsweredCard answer={answer} input={input} apCourseId={apCourseId} />
		);

	const isQuiz = answer.kind === "quiz";
	// AP multiple choice is quiz-shaped, but the verdict is the tutor's
	// (stage 1 global constraint): NO graded chip, no ✓/✗ or green/red
	// option marking, no explanation/Why control, no confidence rail. The
	// pick keeps the neutral selected styling.
	const isAp = answer.tool === "ap_mcq";
	const gradedQuiz = isQuiz && !isAp;
	const isExplain = answer.kind === "explain";
	const selectedIdx = new Set(answer.answers.map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);
	// The question's own context rides the ORIGINAL CALL, not the answer
	// snapshot (owner, 2026-10-12): the details line — and, for ask
	// questions, option descriptions — re-render from the persisted
	// arguments, so every existing transcript shows them too. The lean
	// snapshot (what the model sees) is untouched — for check_point that is
	// compactAnswerForModel behind the learner's-answer frame. Any parse
	// failure or absent input renders exactly the older card.
	const askInput = answer.kind === "ask" ? parseAskInput(input) : undefined;
	// check_point carries the post-miss explanation on the call's
	// explain-shaped `details` — the same visible field the dock shows — so
	// the answered record keeps it too. Explain/recall cards are unchanged.
	const checkPointInput = answer.tool === "check_point" ? parseExplainInput(input) : undefined;
	const apMcqInput = isAp ? parseApMcqInput(input) : undefined;
	const parsedDetails =
		apMcqInput?.details ??
		askInput?.details ??
		(isQuiz && !isAp ? parseQuizInput(input)?.details : checkPointInput?.details);
	const descByIndex = new Map((askInput?.options ?? []).map((o, i) => [i + 1, o.description]));

	return (
		<>
		{/* The reading channel LIFTED (owner round, 2026-10-05): thoughts
		    captured while reading are chronologically PRIOR to the question —
		    rendered as its own user-side block ABOVE the card, the unified
		    ThinkingBlock, instead of an inset inside the answer. Same muted
		    rail as before; the label is now plain "Your thinking". */}
		{answer.readingThinking && (
			<ThinkingBlock testId="reading-thinking-block" label="YOUR THINKING" text={answer.readingThinking} defaultOpen />
		)}
		{/* [&>*:last-child]:mb-0 (owner round, 2026-10-07): on ask cards the
		    thinking row is the last child — its my-3 stacked with the card's
		    p-4 into a 28px void below (12px above); the card's own padding is
		    the bottom rhythm when a row ends the card. */}
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground [&>*:last-child]:mb-0"
			data-testid="answered-card"
		>
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{/* The tool's OWN name first (owner 2026-10-09): probe-phase
			    cards label Probe/Recall — the phase boundary visible in the
			    transcript. No `tool` on old records: kind labels as before. */}
				{answer.tool === "probe"
					? "Probe"
					: answer.tool === "recall"
						? "Recall"
						: answer.tool === "check_point"
							? "Check"
							: isAp
								? "AP · generated"
								: isQuiz
									? answer.questionType === "predict"
										? "Prediction"
										: "Check"
									: isExplain
										? "Explain"
											: "Question"}
				{gradedQuiz &&
					(answer.dontKnow ? (
						<span className="rounded bg-muted px-1.5 py-0.5">didn't know</span>
					) : answer.correct ? (
						<span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500">correct</span>
					) : (
						<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">incorrect</span>
					))}
			</div>
			{/* AP multiple choice may carry a drawn figure (stage 3): it sits
			    above the question, exactly as in the live dock. No figure = the
			    card is unchanged. */}
			{apMcqInput?.figure !== undefined && chatId !== undefined && (
				<QuestionFigure chatId={chatId} figure={apMcqInput.figure} className="mb-3" />
			)}
			<div className="mb-3 font-medium">
				<ToolContentResponse>{answer.questionText}</ToolContentResponse>
			</div>
			{parsedDetails && (
				// The details line, same paint as the pending dock (owner,
				// 2026-10-12): full markdown, LaTeX included.
				<div className="mb-3 text-sm text-muted-foreground">
					<ToolContentResponse>{parsedDetails}</ToolContentResponse>
				</div>
			)}

			{((answer.options?.length ?? 0) > 0 || answer.other) && (
				<div className="flex flex-col gap-1.5 text-sm">
					{answer.options?.map((opt) => {
						const sel = selectedIdx.has(opt.index);
						const key = gradedQuiz && correctIdx.has(opt.index);
						return (
							<div
								key={opt.index}
								className={cn(
									"flex items-center gap-2 rounded-lg border px-3 py-1.5",
									sel && key && "border-green-500/60 bg-green-500/10",
									sel && !key && gradedQuiz && "border-red-500/60 bg-red-500/10",
									sel && !gradedQuiz && "border-primary bg-accent",
									!sel && key && "border-green-500/40",
								)}
							>
								{gradedQuiz && (
									// Zapf-Dingbats-derived SVG outlines — the exact LaTeX \ding{51}/
									// \ding{55} hand-drawn shapes (owner, round 6); see ui/glyph-mark.
									<span
										aria-hidden
										data-mark={sel && key ? "check" : sel && !key ? "x" : !sel && key ? "check" : undefined}
										className={cn(
											"flex shrink-0 items-center",
											sel && key && "text-green-500",
											sel && !key && "text-red-500",
											!sel && key && "text-green-500",
										)}
									>
										{/* Owner round 8: a touch smaller than the text (size-4→size-3.5,
											   ≈14px vs the 16px row) while centered. */}
										{(key || sel) && <GlyphMark kind={key ? "check" : "x"} className="size-3.5" />}
									</span>
								)}
								<span className={cn(!sel && "text-muted-foreground")}>
									<ToolContentResponse>{opt.label}</ToolContentResponse>
									{descByIndex.get(opt.index) && (
										// Ask-option subtext (owner, 2026-10-12): same markdown path
										// as the pending dock — LaTeX included. Quiz options carry
										// none (owner ruling 2026-09-26); the map stays empty for them.
										<ToolContentResponse className="lh-prose block text-xs text-muted-foreground">
											{descByIndex.get(opt.index)}
										</ToolContentResponse>
									)}
								</span>
							</div>
						);
					})}
					{/* The learner's own typed option is an OPTION — same container,
					    same selected styling as its siblings, not a loose quote
					    floating outside the list. Quotes keep the learner's words. */}
					{answer.other && (
						<div
							data-testid="answered-other"
							className="flex items-center gap-2 rounded-lg border border-primary bg-accent px-3 py-1.5"
						>
							<span>“<PathText text={answer.other} />”</span>
						</div>
					)}
				</div>
			)}

			{answer.text && <div className="lh-prose mt-2 whitespace-pre-wrap">“<PathText text={answer.text} />”</div>}

			{/* The confidence record (owner round 6): the slider's rail, disc
			    removed — the missing handle itself says "this is a record, not a
			    control". Same paint, same ticks, same ramp, same % read-out as the
			    live dock. Quiz answers only, and only when a confidence exists:
			    "I don't know" sent none (its slider was grayed out), explain and
			    ask never had one, and records from before the feature carry no
			    field — nothing to show, nothing rendered. */}
			{gradedQuiz && answer.confidence != null && (
				<div className="mt-3 flex items-center gap-3" data-testid="answered-confidence">
					<ConfidenceRail value={answer.confidence} className="min-w-0 flex-1" />
					<span className="w-9 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
						{answer.confidence}%
					</span>
				</div>
			)}
			{answer.dontKnow && isQuiz && (
				<div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>
			)}

			{(answer.thinking ?? answer.note) && (
				/* The SAME unified row (owner round, 2026-10-05): the quiz answer's
				    thinking is the identical collapsible ThinkingBlock — one
				    geometry, but NO band on the card (owner round five, 2026-10-07:
				    the accent lift read too light); rail only, heights identical. */
				<ThinkingBlock
					testId="your-thinking"
					label={isAp ? "YOUR REASONING" : "YOUR THINKING"}
					text={answer.thinking ?? answer.note ?? ""}
					inCard
				/>
			)}

			{/* px-3→removed: card p-4 + box px-3 double-inset sat the "Why" label deeper
			    than the option box edges (owner, round 3). Sides flush with everything
			    else; py-2 stays for vertical air. */}
			{gradedQuiz && answer.explanation && (
				/* The TUCKED explanation — ALL questions (owner, 2026-10-07): the
				   verdict shows, the explanation sits collapsed behind the Why
				   toggle — viewable, never center stage. Identical to the
				   prediction pattern it generalizes (owner, 2026-10-03). */
				<div className="mt-2" data-testid="tucked-explanation">
					<button
						type="button"
						onClick={() => setWhyOpen((v) => !v)}
						className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						{whyOpen ? "Hide why" : "Why"}
					</button>
					{whyOpen && (
						<div className="mt-1.5 rounded-lg bg-muted py-2 text-sm text-foreground/50">
							<span className="font-medium text-muted-foreground">Why: </span>
							{/* Keep the first paragraph beside the label, not every paragraph:
							   later paragraphs must retain their recovered document structure. */}
							<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{answer.explanation}</ToolContentResponse>
						</div>
					)}
				</div>
			)}

			{/* The explain reveal (owner ruling 2026-09-27): the committed answer
			    — one field, reasoning included — shown on submit; no verdict,
			    the model's next reply IS the grading. Test prep's check_point
			    is the exception (spec 2026-11-10): the commitment is never
			    shown, correct or wrong — a ✓ only. */}
			{isExplain && answer.tool !== "check_point" && answer.committed && (
				<div className="mt-3 rounded-lg bg-muted py-2 text-sm text-muted-foreground">
					<span className="font-medium text-foreground">The answer: </span>
					<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{answer.committed}</ToolContentResponse>
				</div>
			)}
		</div>
		</>
	);
}

/**
 * AP's answered free-response record (stage 2, 2026-11-14): the released
 * question's title, its original pages behind "Show question", every part's
 * label with the learner's words (a blank part is an em dash) and the
 * attached photos by file name. No verdict of any kind: the tutor's score
 * card is the only place a result is shown.
 */
function FrqAnsweredCard({
	answer,
	input,
	apCourseId,
}: {
	answer: QuestionAnswerData;
	input?: unknown;
	apCourseId?: string;
}) {
	const [questionOpen, setQuestionOpen] = useState(false);
	const details = parseApFrqInput(input)?.details;
	const frq = answer.frq;

	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground [&>*:last-child]:mb-0"
			data-testid="answered-card"
		>
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				AP · released
			</div>
			<div className="mb-3 font-medium">
				<ToolContentResponse>{answer.questionText}</ToolContentResponse>
			</div>
			{details && (
				<div className="mb-3 text-sm text-muted-foreground">
					<ToolContentResponse>{details}</ToolContentResponse>
				</div>
			)}
			{frq !== undefined &&
				apCourseId !== undefined &&
				frq.file !== undefined &&
				frq.pages !== undefined && (
				<div className="mb-3" data-testid="answered-frq-pages">
					<button
						type="button"
						onClick={() => setQuestionOpen((open) => !open)}
						className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						{questionOpen ? "Hide question" : "Show question"}
					</button>
					{questionOpen && (
						<QuestionPages
							courseId={apCourseId}
							file={frq.file}
							pages={frq.pages}
							title={frq.title}
							className="mt-2 flex flex-col gap-2"
						/>
					)}
				</div>
			)}
			<div className="flex flex-col gap-2 text-sm">
				{(answer.parts ?? []).map((part) => (
					<div key={part.label} className="rounded-lg border px-3 py-2">
						<div className="mb-1 font-medium">({part.label})</div>
						<div className="lh-prose whitespace-pre-wrap">
							{part.text.trim() ? (
								<PathText text={part.text} />
							) : (
								<span className="text-muted-foreground">—</span>
							)}
						</div>
					</div>
				))}
			</div>
			{(answer.photos ?? []).length > 0 && (
				<div className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
					{answer.photos!.map((path) => (
						<div key={path} className="truncate">
							Photo attached: {photoName(path)}
						</div>
					))}
				</div>
			)}
			{answer.dontKnow && <div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>}
		</div>
	);
}

/**
 * AP's answered generated free-response record (stage 3, 2026-11-15): the
 * same shape of record as a released question's, but everything the tutor
 * wrote comes from `apFrqGenDisplay` of the call input — never the raw
 * input, which carries committed answers and rubric points. The learner's
 * words come from the stored answer. No verdict of any kind: the tutor's
 * score card is the only place a result is shown.
 */
function FrqGenAnsweredCard({
	answer,
	input,
	chatId,
}: {
	answer: QuestionAnswerData;
	input?: unknown;
	chatId?: string;
}) {
	const parsed = parseApFrqGenInput(input);
	const question = parsed === undefined ? undefined : apFrqGenDisplay(parsed);
	const texts = new Map((answer.parts ?? []).map((part) => [part.label, part.text]));
	// A failed parse still records the learner's parts, labelled but without
	// prompts — never a raw-input field. The display order is the question's.
	const parts: { label: string; prompt?: string }[] =
		question?.parts ?? (answer.parts ?? []).map((part) => ({ label: part.label }));

	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground [&>*:last-child]:mb-0"
			data-testid="answered-card"
		>
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				AP · generated
			</div>
			<div className="mb-3 font-medium">
				<ToolContentResponse>{question?.title ?? answer.questionText}</ToolContentResponse>
			</div>
			{question?.details && (
				// The details line, in the released card's place and paint.
				<div className="mb-3 text-sm text-muted-foreground">
					<ToolContentResponse>{question.details}</ToolContentResponse>
				</div>
			)}
			{question?.figure !== undefined && chatId !== undefined && (
				<QuestionFigure chatId={chatId} figure={question.figure} className="mb-3" />
			)}
			{question !== undefined && (
				<div className="mb-3">
					<ToolContentResponse>{question.stem}</ToolContentResponse>
				</div>
			)}
			<div className="flex flex-col gap-2 text-sm">
				{parts.map((part) => (
					<div key={part.label} className="rounded-lg border px-3 py-2">
						<div className="mb-1 font-medium">({part.label})</div>
						{part.prompt !== undefined && (
							<div className="mb-1 text-sm text-muted-foreground">
								<ToolContentResponse>{part.prompt}</ToolContentResponse>
							</div>
						)}
						<div className="lh-prose whitespace-pre-wrap">
							{(texts.get(part.label) ?? "").trim() ? (
								<PathText text={texts.get(part.label) ?? ""} />
							) : (
								<span className="text-muted-foreground">—</span>
							)}
						</div>
					</div>
				))}
			</div>
			{(answer.photos ?? []).length > 0 && (
				<div className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
					{answer.photos!.map((path) => (
						<div key={path} className="truncate">
							Photo attached: {photoName(path)}
						</div>
					))}
				</div>
			)}
			{answer.dontKnow && <div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>}
		</div>
	);
}
