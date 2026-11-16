"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { photoName } from "@/components/ap/photo-name";
import { QuestionFigure } from "@/components/ap/question-figure";
import { QuestionPages } from "@/components/ap/question-pages";
import {
	FilePickerBusy,
	PICKER_BUSY_NOTICE,
	PICKER_UNAVAILABLE_NOTICE,
	requestNativePaths,
} from "@/components/attach-files-button";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { MalformedQuestion } from "@/components/malformed-question";
import { PathInput } from "@/components/path-input";
import { Button } from "@/components/ui/button";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import {
	apGenQuestionId,
	buildAnswer,
	DEFAULT_CONFIDENCE_INDEX,
	type AnswerRequest,
	type ApFrqGenDisplay,
	type QuestionAnswerData,
	type QuestionData,
	type QuestionFormDraft,
} from "@/src/core";

/**
 * A released AP free-response question (AP prep stage 2, 2026-11-14): the
 * original paper pages, then one answer box per part, an optional photo of
 * the written work and one Submit. The model's call carries only the
 * question id, so the browser fetches the public projection — title, pages,
 * parts, topic tags. No rubric travels here; the tutor grades afterwards.
 *
 * The answer for each part is typed or dictated. There is ONE dictation
 * target (the dock owns it while a question waits): speech lands in the part
 * box that last had focus, the first by default.
 */

/** The question projection the page route serves to the browser. */
export interface ApFrqQuestionView {
	id: string;
	title: string;
	file: string;
	pages: number[];
	present: boolean;
	parts: { label: string; topicId?: string; topicText?: string }[];
}

/** The form never takes a typed path: photos come from the native picker only. */
const MAX_PHOTOS = 6;

interface FrqDraftState {
	parts: Record<string, string>;
	photos: string[];
	dontKnow?: boolean;
}

/**
 * The in-memory draft (see `QuestionFormDraft`) has no fields for per-part
 * answers or photos. It is never persisted, so the frq form serialises its
 * state into the draft's `text` slot and "I don't know" into the selection;
 * every other question type keeps reading those fields exactly as before.
 */
export function frqFormDraft(state: FrqDraftState): QuestionFormDraft {
	return {
		selection: { selected: new Set(), otherSelected: false, dontKnow: state.dontKnow === true },
		thinking: "",
		other: "",
		text: JSON.stringify({ parts: state.parts, photos: state.photos }),
		confidenceIndex: DEFAULT_CONFIDENCE_INDEX,
	};
}

function readFrqDraft(draft?: QuestionFormDraft): FrqDraftState {
	if (!draft) return { parts: {}, photos: [], dontKnow: false };
	let parts: Record<string, string> = {};
	let photos: string[] = [];
	try {
		const parsed = JSON.parse(draft.text) as unknown;
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as { parts?: unknown; photos?: unknown };
			if (typeof record.parts === "object" && record.parts !== null) {
				for (const [label, text] of Object.entries(record.parts)) {
					if (typeof text === "string") parts[label] = text;
				}
			}
			if (Array.isArray(record.photos)) {
				photos = record.photos.filter((photo): photo is string => typeof photo === "string").slice(0, MAX_PHOTOS);
			}
		}
	} catch {
		/* A draft from another shape restores nothing rather than guessing. */
	}
	return { parts, photos, dontKnow: draft.selection.dontKnow === true };
}

/**
 * The answer request a submit builds, pure and testable: every part in the
 * route's order (a blank part stays an empty string), the photos as the
 * absolute paths the picker returned, and the released-question block taken
 * from the fetched question — the model's call carries only the id, so the
 * caller supplies the block the answer record replays the paper page from.
 */
export function frqAnswerRequest(
	question: ApFrqQuestionView,
	answers: { parts: Record<string, string>; photos: readonly string[]; dontKnow: boolean },
): AnswerRequest {
	return {
		dontKnow: answers.dontKnow,
		parts: question.parts.map((part) => ({ label: part.label, text: answers.parts[part.label] ?? "" })),
		photos: [...answers.photos],
		frq: {
			questionId: question.id,
			title: question.title,
			file: question.file,
			pages: [...question.pages],
		},
	};
}

/** The answer request a generated question's submit builds (AP prep stage 3):
 *  every part in display order (a blank part stays an empty string), the
 *  photos as absolute paths, and the question block the answer record
 *  replays. A generated question has no paper, so the block carries only the
 *  derived id and the title. */
export function frqGenAnswerRequest(
	question: ApFrqGenDisplay,
	toolCallId: string,
	answers: { parts: Record<string, string>; photos: readonly string[]; dontKnow: boolean },
): AnswerRequest {
	return {
		dontKnow: answers.dontKnow,
		parts: question.parts.map((part) => ({ label: part.label, text: answers.parts[part.label] ?? "" })),
		photos: [...answers.photos],
		frq: {
			questionId: apGenQuestionId(toolCallId),
			title: question.title,
		},
	};
}

/** The fetch state the body renders — exported so tests can pose a ready question. */
export type FrqQuestionFetchState =
	| { status: "loading" }
	| { status: "error" }
	| { status: "ready"; question: ApFrqQuestionView };

/**
 * The fetch state as UI, separate from the fetch. `FrqQuestion` owns the
 * request; this piece owns what each state looks like, so a render test can
 * pose `ready` without a browser. It forwards every form prop, including the
 * course id the page images and the absent-paper link are built from.
 */
export function FrqQuestionBody({
	state,
	...form
}: {
	state: FrqQuestionFetchState;
} & Omit<FrqQuestionFormProps, "question">) {
	if (state.status === "error") {
		return (
			<div data-testid="question-dock" className="px-4 pt-3">
				<MalformedQuestion />
			</div>
		);
	}
	if (state.status === "loading") {
		return (
			<div data-testid="question-dock">
				<div
					data-dock-scroll-area=""
					data-session-find-root=""
					className="max-h-[var(--dock-max-h,55dvh)] overflow-y-auto px-4 pt-3"
				>
					<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						AP · released
					</div>
					<div className="mb-3 text-sm text-muted-foreground">Loading the question…</div>
				</div>
			</div>
		);
	}
	return <FrqQuestionForm {...form} question={state.question} />;
}

/** Fetch the question projection, then pose the form. */
export function FrqQuestion({
	questionId,
	apCourseId,
	...form
}: {
	questionId: string;
	apCourseId?: string;
} & Omit<FrqQuestionFormProps, "question">) {
	const [state, setState] = useState<FrqQuestionFetchState>({ status: "loading" });

	useEffect(() => {
		if (!apCourseId) {
			setState({ status: "error" });
			return;
		}
		let cancelled = false;
		setState({ status: "loading" });
		fetch(`/api/ap/${encodeURIComponent(apCourseId)}/questions/${encodeURIComponent(questionId)}`)
			.then(async (response) => {
				if (!response.ok) throw new Error(`question request failed: ${response.status}`);
				return (await response.json()) as ApFrqQuestionView;
			})
			.then((question) => {
				if (!cancelled) setState({ status: "ready", question });
			})
			.catch(() => {
				if (!cancelled) setState({ status: "error" });
			});
		return () => {
			cancelled = true;
		};
	}, [apCourseId, questionId]);

	// `apCourseId` was destructured for the fetch, so the rest spread no
	// longer carries it: hand it to the body explicitly or the loaded form
	// builds every page URL (and the absent-paper link) with an empty id.
	return <FrqQuestionBody state={state} apCourseId={apCourseId} {...form} />;
}

/** The props every free-response form shares: the answer sheet itself, its
 *  submit and the draft/dictation seams. */
interface FrqSheetFormProps {
	toolCallId: string;
	onSubmit: (answer: QuestionAnswerData) => void;
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
	onEscape?: () => void;
	dictationClaim?: boolean;
	compactionRunning?: boolean;
}

export interface FrqQuestionFormProps extends FrqSheetFormProps {
	apCourseId?: string;
	question: ApFrqQuestionView;
	details?: string;
}

/** One answer box's heading: the label and, beside it, a released part's
 *  topic tag. A generated part's prompt is its own line above the box. */
interface FrqSheetPart {
	label: string;
	tag?: string;
	prompt?: string;
}

/** Everything the sheet needs to pose one multi-part free-response question.
 *  Both question sources (the released paper and the tutor's own) differ only
 *  in their intro, their part headings and the request a submit builds. */
interface FrqSheetProps extends FrqSheetFormProps {
	header: string;
	title: string;
	details?: string;
	parts: FrqSheetPart[];
	/** The question body between the details and the answer boxes: the
	 *  released paper's pages, or a generated question's figure and stem. */
	intro?: ReactNode;
	/** False for a released question whose paper is not on this computer:
	 *  the intro, answer boxes and photo attach are replaced by `absent`. */
	present: boolean;
	absent?: ReactNode;
	/** True for a released question: its paper pages and answer boxes can open
	 *  as a full-screen two-pane workspace (issue #7 — pages left, boxes right). */
	expandable?: boolean;
	buildRequest: (answers: { parts: Record<string, string>; photos: string[]; dontKnow: boolean }) => AnswerRequest;
	toolName: "ap_frq" | "ap_frq_gen";
}

/** The shared answer sheet: one box per part, an optional photo of the
 *  written work and one Submit. */
function FrqSheet({
	toolCallId,
	header,
	title,
	details,
	parts,
	intro,
	present,
	expandable = false,
	absent,
	buildRequest,
	toolName,
	onSubmit,
	initialDraft,
	onSaveDraft,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
}: FrqSheetProps) {
	const [texts, setTexts] = useState<Record<string, string>>(() => readFrqDraft(initialDraft).parts);
	const [photos, setPhotos] = useState<string[]>(() => readFrqDraft(initialDraft).photos);
	const [dontKnow, setDontKnowState] = useState(() => readFrqDraft(initialDraft).dontKnow === true);
	const [notice, setNotice] = useState("");
	const textsRef = useRef(texts);
	const photosRef = useRef(photos);
	const dontKnowRef = useRef(dontKnow);
	const focusedPart = useRef(0);
	const choosing = useRef(false);

	// The released question's full-screen workspace (issue #7): the paper's
	// pages on the left, the answer boxes on the right. It opens when the
	// question is posed — a rendered paper is meant to be read beside the
	// boxes, not scrolled through in the dock — and Close returns to the dock
	// with every typed answer kept, because the state lives here, not in the
	// portaled DOM.
	const [stage, setStage] = useState(false);
	useEffect(() => {
		// A new question (its title) reopens the workspace; closing it keeps it
		// closed for the question on screen.
		if (expandable && present) setStage(true);
	}, [expandable, present, title]);
	useEffect(() => {
		if (!stage) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || isDictationActive()) return;
			const target = event.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
				// Esc in an answer box stops dictation — the dock's law, never the close.
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			setStage(false);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [stage]);

	const setPartText = (label: string, value: string) => {
		textsRef.current = { ...textsRef.current, [label]: value };
		setTexts(textsRef.current);
	};
	const setPhotoList = (next: string[]) => {
		photosRef.current = next;
		setPhotos(next);
	};
	const setDontKnow = (value: boolean) => {
		dontKnowRef.current = value;
		setDontKnowState(value);
	};
	// Turning "I don't know" ON disables the part boxes. A live dictation run
	// must finish — not vanish — before the guard starts ignoring speech, or
	// its last finals would be lost.
	const toggleDontKnow = () => {
		if (dontKnowRef.current) {
			setDontKnow(false);
			return;
		}
		if (!isDictationActive()) {
			setDontKnow(true);
			return;
		}
		void finishDictation().then(() => setDontKnow(true));
	};

	// ONE dictation target per dock: the focused part box (the first by
	// default). The ref mirror keeps a submit that resumes after
	// finishDictation() reading the last finals.
	useDictationTarget(
		useCallback(
			(text: string) => {
				// Disabled boxes take no dictated text; a live run was finished
				// before the toggle turned this on.
				if (dontKnowRef.current) return;
				const label = parts[focusedPart.current]?.label;
				if (label === undefined) return;
				textsRef.current = {
					...textsRef.current,
					[label]: joinDictation(textsRef.current[label] ?? "", text),
				};
				setTexts(textsRef.current);
			},
			[parts],
		),
		dictationClaim,
	);

	const canSubmit =
		present &&
		!compactionRunning &&
		(dontKnow || photos.length > 0 || parts.some((part) => (texts[part.label] ?? "").trim().length > 0));

	const attachPhoto = async () => {
		if (dontKnowRef.current || photosRef.current.length >= MAX_PHOTOS || choosing.current) return;
		choosing.current = true;
		setNotice("");
		try {
			const chosen = await requestNativePaths("files");
			if (chosen === null) {
				setNotice(PICKER_UNAVAILABLE_NOTICE);
				return;
			}
			const next = [...photosRef.current];
			for (const path of chosen) {
				if (next.length >= MAX_PHOTOS) break;
				if (!next.includes(path)) next.push(path);
			}
			setPhotoList(next);
		} catch (error) {
			setNotice(error instanceof FilePickerBusy ? PICKER_BUSY_NOTICE : "Could not open the file picker. Try again.");
		} finally {
			choosing.current = false;
		}
	};

	const submit = () => {
		if (!canSubmit) return;
		// The same "nothing gets lost" law as the dock: stop a live run and
		// let its last finals land before reading the part boxes.
		if (!isDictationActive()) {
			doSubmit();
			return;
		}
		void finishDictation().then(doSubmit);
	};

	const doSubmit = () => {
		if (!present || compactionRunning) return;
		const attached = [...photosRef.current];
		const req = buildRequest({
			parts: textsRef.current,
			photos: attached,
			dontKnow: dontKnowRef.current,
		});
		const hasText = (req.parts ?? []).some((part) => part.text.trim().length > 0);
		if (!req.dontKnow && attached.length === 0 && !hasText) return;

		const qd: QuestionData = {
			id: toolCallId,
			kind: "frq",
			question: title,
			mode: "text",
			options: [],
			createdAt: new Date().toISOString(),
		};
		// Snapshot before the optimistic submission unmounts the form.
		onSaveDraft?.(frqFormDraft({ parts: textsRef.current, photos: attached, dontKnow: dontKnowRef.current }));
		onSubmit(buildAnswer(qd, req, toolName));
	};

	const answerSheet = (
		<>
			{parts.map((part, index) => (
				<div key={part.label} className="mb-3">
					<div className="mb-1 flex items-baseline gap-2">
						<span className="text-sm font-medium">({part.label})</span>
						{part.tag && (
							<span className="text-xs text-muted-foreground">{part.tag}</span>
						)}
					</div>
					{part.prompt && (
						<div className="mb-1 text-sm">
							<ToolContentResponse>{part.prompt}</ToolContentResponse>
						</div>
					)}
					<div
						className={cn(
							"rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50",
							dontKnow && "opacity-50",
						)}
					>
						<PathInput
							value={texts[part.label] ?? ""}
							onValueChange={(value) => setPartText(part.label, value)}
							onFocus={() => {
								focusedPart.current = index;
							}}
							onKeyDown={(event) => {
								// Esc ends dictation (the dock's law), never the question.
								if (event.key === "Escape" && onEscape) {
									event.preventDefault();
									event.stopPropagation();
									onEscape();
								}
							}}
							allowFilePaths={false}
							aria-label={
								part.tag || part.prompt
									? `(${part.label}) ${part.tag ?? part.prompt}`
									: `(${part.label})`
							}
							aria-disabled={dontKnow}
							tabIndex={dontKnow ? -1 : undefined}
							placeholder="Type your answer…"
							className={cn(
								"field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground",
								dontKnow && "pointer-events-none",
							)}
						/>
					</div>
				</div>
			))}

			<div className="mb-3">
				{photos.length > 0 && (
					<div className="mb-1.5 flex flex-wrap items-center gap-1.5">
						{photos.map((path) => {
							const name = photoName(path);
							return (
								<span
									key={path}
									className={cn(
										"flex min-w-0 items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs",
										dontKnow && "opacity-50",
									)}
								>
									<span className="truncate">{name}</span>
									<button
										type="button"
										aria-label={`Remove photo ${name}`}
										disabled={dontKnow}
										onClick={() =>
											setPhotoList(photosRef.current.filter((candidate) => candidate !== path))
										}
										className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
									>
										<XIcon className="size-3" aria-hidden />
									</button>
								</span>
							);
						})}
					</div>
				)}
				<Button
					type="button"
					variant="outline"
					size="xs"
					disabled={dontKnow || photos.length >= MAX_PHOTOS}
					onClick={() => void attachPhoto()}
				>
					Attach photo
				</Button>
				{notice && (
					<p role="status" className="mt-1.5 text-xs text-muted-foreground">
						{notice}
					</p>
				)}
			</div>
		</>
	);

	const actions = (
		<form
			className="border-t border-border/60 p-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="flex flex-col gap-2 p-1">
				<button
					type="button"
					onClick={() => toggleDontKnow()}
					aria-pressed={dontKnow}
					className={cn(
						"flex items-start gap-3 rounded-lg border border-dashed px-3 py-2 text-left text-sm outline-none transition-colors",
						dontKnow ? "border-primary text-foreground" : "text-muted-foreground hover:bg-accent/50",
					)}
				>
					<span
						className={cn(
							"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
							dontKnow ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
						)}
					>
						{dontKnow && <span className="size-1.5 rounded-full bg-current" />}
					</span>
					<span>I don't know</span>
				</button>
				<div className="flex items-center justify-end">
					<Button
						type="submit"
						disabled={!canSubmit}
						className="ml-auto h-9 rounded-[6px] px-3.5 text-sm font-medium"
					>
						Submit answer
					</Button>
				</div>
			</div>
		</form>
	);

	// The two-pane workspace (issue #7). Pages stack above the boxes on a
	// narrow window and sit beside them from md up; the answer sheet keeps its
	// own scroll area and the submit row stays pinned under it.
	if (stage) {
		return createPortal(
			<div
				role="dialog"
				aria-modal="true"
				aria-label={`${title} — question`}
				data-testid="frq-stage"
				className="fixed inset-0 z-50 flex flex-col bg-background"
			>
				<div className="flex items-center gap-3 border-b border-border/60 px-5 py-2.5">
					<div className="min-w-0 flex-1">
						<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{header}</div>
						<div className="truncate text-sm font-medium">{title}</div>
					</div>
					<Button type="button" variant="outline" size="sm" onClick={() => setStage(false)}>
						Close
					</Button>
				</div>
				<div className="flex min-h-0 flex-1 flex-col md:flex-row">
					<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 md:border-r md:border-border/60">
						{details && (
							<div className="mb-3 text-sm text-muted-foreground">
								<ToolContentResponse>{details}</ToolContentResponse>
							</div>
						)}
						{intro}
					</div>
					<div className="flex min-h-0 flex-1 flex-col border-t border-border/60 md:flex-none md:w-[28rem] md:shrink-0 md:border-t-0 lg:w-[32rem]">
						<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{answerSheet}</div>
						{actions}
					</div>
				</div>
			</div>,
			document.body,
		);
	}

	return (
		<div data-testid="question-dock">
			<div
				data-dock-scroll-area=""
				data-session-find-root=""
				className="max-h-[var(--dock-max-h,55dvh)] overflow-y-auto px-4 pt-3"
			>
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{header}
				</div>
				<div className="mb-3 flex items-baseline justify-between gap-3">
					<div className="font-medium">{title}</div>
					{expandable && present && (
						<button
							type="button"
							onClick={() => setStage(true)}
							className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline"
						>
							Open full screen
						</button>
					)}
				</div>
				{details && (
					<div className="mb-3 text-sm text-muted-foreground">
						<ToolContentResponse>{details}</ToolContentResponse>
					</div>
				)}

				{present ? (
					<>
						{intro}
						{answerSheet}
					</>
				) : (
					absent
				)}
			</div>

			{actions}
		</div>
	);
}

/** The form body — exported so the render tests can pose a loaded question. */
export function FrqQuestionForm({ apCourseId, question, details, ...form }: FrqQuestionFormProps) {
	return (
		<FrqSheet
			header="AP · released"
			title={question.title}
			details={details}
			parts={question.parts.map((part) => ({ label: part.label, tag: part.topicText }))}
			intro={
				<QuestionPages
					courseId={apCourseId ?? ""}
					file={question.file}
					pages={question.pages}
					title={question.title}
					className="mb-3 flex flex-col gap-2"
				/>
			}
			present={question.present}
			expandable
			absent={
				<div className="mb-3 rounded-lg border border-dashed bg-muted/40 p-3 text-sm">
					This paper is not on this computer. Download it from the course page.{" "}
					<Link
						href={`/ap/${apCourseId ?? ""}`}
						className="font-medium text-primary underline underline-offset-4"
					>
						Course page
					</Link>
				</div>
			}
			buildRequest={(answers) => frqAnswerRequest(question, answers)}
			toolName="ap_frq"
			{...form}
		/>
	);
}

export interface FrqGenQuestionFormProps extends FrqSheetFormProps {
	/** The dock passes the chat id so the question's figure loads through the
	 *  chat's figure route; without it no figure is shown. */
	chatId?: string;
	question: ApFrqGenDisplay;
}

/**
 * A generated free-response question (AP prep stage 3): the tutor's own
 * title, details, figure and stem, then one answer box per part. Everything
 * shown comes from `apFrqGenDisplay` of the call input — the committed
 * answers and rubric points never reach this component. No fetch: unlike a
 * released paper, there is no projection to load.
 */
export function FrqGenQuestionForm({ chatId, question, toolCallId, ...form }: FrqGenQuestionFormProps) {
	return (
		<FrqSheet
			header="AP · generated"
			title={question.title}
			details={question.details}
			parts={question.parts.map((part) => ({ label: part.label, prompt: part.prompt }))}
			intro={
				<>
					{question.figure !== undefined && chatId !== undefined && (
						<QuestionFigure chatId={chatId} figure={question.figure} className="mb-3" />
					)}
					<div className="mb-3">
						<ToolContentResponse>{question.stem}</ToolContentResponse>
					</div>
				</>
			}
			present
			buildRequest={(answers) => frqGenAnswerRequest(question, toolCallId, answers)}
			toolName="ap_frq_gen"
			toolCallId={toolCallId}
			{...form}
		/>
	);
}
