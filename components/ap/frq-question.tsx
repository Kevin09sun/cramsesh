"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";

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
	buildAnswer,
	DEFAULT_CONFIDENCE_INDEX,
	type AnswerRequest,
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

function photoName(path: string): string {
	const pieces = path.split(/[\\/]/);
	return pieces[pieces.length - 1] || path;
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
	const [state, setState] = useState<
		{ status: "loading" } | { status: "error" } | { status: "ready"; question: ApFrqQuestionView }
	>({ status: "loading" });

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

export interface FrqQuestionFormProps {
	toolCallId: string;
	apCourseId?: string;
	question: ApFrqQuestionView;
	details?: string;
	onSubmit: (answer: QuestionAnswerData) => void;
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
	onEscape?: () => void;
	dictationClaim?: boolean;
	compactionRunning?: boolean;
}

/** The form body — exported so the render tests can pose a loaded question. */
export function FrqQuestionForm({
	toolCallId,
	apCourseId,
	question,
	details,
	onSubmit,
	initialDraft,
	onSaveDraft,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
}: FrqQuestionFormProps) {
	const [texts, setTexts] = useState<Record<string, string>>(() => readFrqDraft(initialDraft).parts);
	const [photos, setPhotos] = useState<string[]>(() => readFrqDraft(initialDraft).photos);
	const [dontKnow, setDontKnowState] = useState(() => readFrqDraft(initialDraft).dontKnow === true);
	const [notice, setNotice] = useState("");
	const textsRef = useRef(texts);
	const photosRef = useRef(photos);
	const dontKnowRef = useRef(dontKnow);
	const focusedPart = useRef(0);
	const choosing = useRef(false);

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

	// ONE dictation target per dock: the focused part box (the first by
	// default). The ref mirror keeps a submit that resumes after
	// finishDictation() reading the last finals.
	useDictationTarget(
		useCallback(
			(text: string) => {
				const label = question.parts[focusedPart.current]?.label;
				if (label === undefined) return;
				textsRef.current = {
					...textsRef.current,
					[label]: joinDictation(textsRef.current[label] ?? "", text),
				};
				setTexts(textsRef.current);
			},
			[question.parts],
		),
		dictationClaim,
	);

	const canSubmit =
		question.present &&
		!compactionRunning &&
		(dontKnow || photos.length > 0 || question.parts.some((part) => (texts[part.label] ?? "").trim().length > 0));

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
		if (!question.present || compactionRunning) return;
		const parts = question.parts.map((part) => ({
			label: part.label,
			text: textsRef.current[part.label] ?? "",
		}));
		const attached = [...photosRef.current];
		if (!dontKnowRef.current && attached.length === 0 && !parts.some((part) => part.text.trim().length > 0)) return;

		const qd: QuestionData = {
			id: toolCallId,
			kind: "frq",
			question: question.title,
			mode: "text",
			options: [],
			createdAt: new Date().toISOString(),
		};
		const req: AnswerRequest = {
			dontKnow: dontKnowRef.current,
			parts,
			photos: attached,
			// The model passes only the id (stage 2 contract): the caller
			// supplies the released-question block so the answer record can
			// replay the paper page.
			frq: { questionId: question.id, title: question.title, file: question.file, pages: [...question.pages] },
		};
		// Snapshot before the optimistic submission unmounts the form.
		onSaveDraft?.(frqFormDraft({ parts: textsRef.current, photos: attached, dontKnow: dontKnowRef.current }));
		onSubmit(buildAnswer(qd, req, "ap_frq"));
	};

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
				<div className="mb-3 font-medium">{question.title}</div>
				{details && (
					<div className="mb-3 text-sm text-muted-foreground">
						<ToolContentResponse>{details}</ToolContentResponse>
					</div>
				)}

				{question.present ? (
					<>
						<QuestionPages
							courseId={apCourseId ?? ""}
							file={question.file}
							pages={question.pages}
							title={question.title}
							className="mb-3 flex flex-col gap-2"
						/>

						{question.parts.map((part, index) => (
							<div key={part.label} className="mb-3">
								<div className="mb-1 flex items-baseline gap-2">
									<span className="text-sm font-medium">({part.label})</span>
									{part.topicText && (
										<span className="text-xs text-muted-foreground">{part.topicText}</span>
									)}
								</div>
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
				) : (
					<div className="mb-3 rounded-lg border border-dashed bg-muted/40 p-3 text-sm">
						This paper is not on this computer. Download it from the course page.{" "}
						<Link
							href={`/ap/${apCourseId ?? ""}`}
							className="font-medium text-primary underline underline-offset-4"
						>
							Course page
						</Link>
					</div>
				)}
			</div>

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
						onClick={() => setDontKnow(!dontKnowRef.current)}
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
		</div>
	);
}