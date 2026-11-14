/**
 * ap-indexer — the indexing sub-agent (AP prep stage 2, Task 5).
 *
 * One call reads ONE saved released paper with its scoring guideline and
 * submits the question index for that pair: every free-response question,
 * the paper pages that show it, the guideline pages that score it, its
 * lettered parts tagged to one confirmed topic, and every rubric point as a
 * separately awarded item. The server assigns the point ids ("<label><n>");
 * the model never invents them.
 *
 * Text only: both PDFs are extracted page by page (each page headed
 * `--- page N ---`) and the model sees nothing else of the lesson. A pair
 * whose text is too long or unreadable fails with a plain reason — never a
 * silent truncation. The caller writes the returned questions after this
 * resolves, so an abort or a bad answer never leaves half an index behind.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { PiEngine } from "../models.ts";
import type { ApDocument } from "../../core/ap.ts";
import { apPaperFileName, apQuestionId } from "../../core/ap-frq.ts";
import type { ApRealQuestion } from "../../core/ap-frq.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { pdfExtract, pdfPageCount } from "./pdf-ops.ts";

/** The pair fails honestly past this much text (paper + guideline together).
 *  A real released pair is far under it; the guard stops a pathological
 *  document from flooding the model's context. */
export const AP_INDEX_MAX_CHARS = 400_000;

/** A document with less readable text than this is treated as scanned: the
 *  indexer cannot see the questions and must not guess them. */
export const AP_INDEX_MIN_CHARS = 200;

const submitSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			number: Type.Integer({ description: "The question number on the paper." }),
			pages: Type.Array(Type.Integer(), {
				description: "The paper's pages that show this question.",
			}),
			scoringPages: Type.Array(Type.Integer(), {
				description: "The scoring guideline's pages that score this question.",
			}),
			parts: Type.Array(
				Type.Object({
					label: Type.String({ description: "The part's letter, e.g. \"a\"." }),
					topicId: Type.String({
						description: "One confirmed topic id, or the empty string when no listed topic fits.",
					}),
					points: Type.Array(Type.String(), {
						description: "Each separately awarded rubric point, quoted or closely paraphrased.",
					}),
				}),
			),
		}),
	),
});

type SubmitValue = Static<typeof submitSchema>;

const SYSTEM_PROMPT = [
	"You index a released AP free-response paper and its scoring guideline into a question index.",
	"",
	"Rules:",
	"- Index every free-response question on the paper.",
	"- `pages` are the paper's pages that show that question; `scoringPages` are the guideline's pages that score it.",
	"- Give one entry per lettered part. A question with no lettered parts has a single part labelled \"a\".",
	"- Each rubric point is one separately awarded point, quoted or closely paraphrased from the guideline.",
	"- Tag each part with the one listed topic it chiefly tests, or leave `topicId` empty.",
	"- Never invent a question, a part or a rubric point.",
	"",
	"Submit the whole index in one call. If a submission is rejected, read the rejection and submit a corrected index.",
].join("\n");

export interface ApIndexPaperInput {
	paper: ApDocument;
	scoring: ApDocument;
	/** Absolute path of the paper PDF on this computer. */
	paperPath: string;
	/** Absolute path of its scoring guideline PDF on this computer. */
	scoringPath: string;
	/** The confirmed unit and topic list questions may be tagged against. */
	topics: { id: string; unit: string; text: string }[];
}

export interface ApIndexPaperOptions {
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	chatId?: string;
	onUsage: (usage: Usage) => void;
}

/** One document's extraction: its pages as text (bodies only, for the
 *  readability and length checks) and the formatted transcript the model
 *  reads (each page headed `--- page N ---`). */
async function extractDocument(filePath: string): Promise<{
	pages: number;
	text: string;
	formatted: string;
}> {
	const pages = await pdfPageCount(filePath);
	const bodies: string[] = [];
	const formatted: string[] = [];
	for (let page = 1; page <= pages; page++) {
		// pdfExtract emits its own `--- Page N ---` heading; strip exactly that
		// and add the lowercase heading this prompt uses.
		const body = (await pdfExtract(filePath, String(page))).replace(/^--- Page \d+ ---\r?\n?/, "");
		bodies.push(body);
		formatted.push(`--- page ${page} ---\n${body}`);
	}
	return { pages, text: bodies.join("\n"), formatted: formatted.join("\n") };
}

/** The set encoded in a paper id (`frq-2023-set2` → 2), else undefined.
 *  Rebuilt from the same file-name rule the save tool writes with. */
function setOfPaper(paper: ApDocument): number | undefined {
	if (paper.year === undefined) return undefined;
	for (let set = 1; set <= 9; set++) {
		if (apPaperFileName("frq", paper.year, set).slice(0, -".pdf".length) === paper.id) return set;
	}
	return undefined;
}

/** Every problem with one submitted index; empty = usable. One string so the
 *  model receives the whole correction in a single retryable tool error. */
function submissionProblem(
	value: SubmitValue,
	paperPages: number,
	scoringPages: number,
	topicIds: ReadonlySet<string>,
): string | null {
	const problems: string[] = [];
	if (value.questions.length === 0) problems.push("no questions were submitted");

	const numbers = new Set<number>();
	for (const question of value.questions) {
		if (numbers.has(question.number)) problems.push(`question ${question.number} is listed more than once`);
		numbers.add(question.number);

		for (const page of question.pages) {
			if (page < 1 || page > paperPages) {
				problems.push(
					`question ${question.number} cites paper page ${page}, but the paper has ${paperPages} page(s)`,
				);
			}
		}
		for (const page of question.scoringPages) {
			if (page < 1 || page > scoringPages) {
				problems.push(
					`question ${question.number} cites scoring page ${page}, but the guideline has ${scoringPages} page(s)`,
				);
			}
		}

		if (question.parts.length === 0) problems.push(`question ${question.number} has no parts`);
		const labels = new Set<string>();
		for (const part of question.parts) {
			if (labels.has(part.label)) {
				problems.push(`question ${question.number} lists part "${part.label}" more than once`);
			}
			labels.add(part.label);
			if (part.points.length === 0) {
				problems.push(`part "${part.label}" of question ${question.number} has no rubric points`);
			}
			if (part.topicId !== "" && !topicIds.has(part.topicId)) {
				problems.push(
					`part "${part.label}" of question ${question.number} has an unknown topic "${part.topicId}"`,
				);
			}
		}
	}

	return problems.length > 0 ? problems.join("; ") : null;
}

/**
 * Read one released pair and return its questions. Throws with a plain,
 * learner-safe reason when the pair cannot be indexed (`too long to index`,
 * `no readable text (scanned document)`, the indexer's never-submitted
 * message); the caller records that as the pair's failure.
 */
export async function indexApPaper(
	input: ApIndexPaperInput,
	opts: ApIndexPaperOptions,
): Promise<ApRealQuestion[]> {
	const year = input.paper.year;
	if (year === undefined) throw new Error("the released paper has no year");
	const set = setOfPaper(input.paper);

	const paper = await extractDocument(input.paperPath);
	const scoring = await extractDocument(input.scoringPath);
	opts.signal?.throwIfAborted();

	if (paper.text.length + scoring.text.length > AP_INDEX_MAX_CHARS) throw new Error("too long to index");
	if (paper.text.trim().length < AP_INDEX_MIN_CHARS || scoring.text.trim().length < AP_INDEX_MIN_CHARS) {
		throw new Error("no readable text (scanned document)");
	}

	const topicIds = new Set(input.topics.map((topic) => topic.id));
	const topicLines =
		input.topics.length === 0
			? ["(none — leave every topicId empty)"]
			: input.topics.map((topic) => `- ${topic.id} — ${topic.unit}: ${topic.text}`);

	const prompt = [
		`Paper: ${input.paper.label} (${paper.pages} pages)`,
		`Scoring guideline: ${input.scoring.label} (${scoring.pages} pages)`,
		"",
		"=== PAPER TEXT ===",
		paper.formatted,
		"",
		"=== SCORING GUIDELINE TEXT ===",
		scoring.formatted,
		"",
		"Confirmed topics:",
		...topicLines,
	].join("\n");

	const submission = await runSubmitAgent<SubmitValue>({
		role: "apIndexer",
		toolName: "submit_index",
		toolDescription:
			"Submit the complete question index for this released paper and its scoring guideline: every question " +
			"with the paper pages that show it, the guideline pages that score it, its lettered parts tagged to one " +
			"confirmed topic (or the empty string), and every separately awarded rubric point.",
		parameters: submitSchema,
		fill: (value) => value as SubmitValue,
		systemPrompt: SYSTEM_PROMPT,
		prompt,
		engine: opts.engine,
		signal: opts.signal,
		chatId: opts.chatId,
		onStep: (usage) => opts.onUsage(usage),
		neverSubmitted: "the indexer never submitted a question index",
		validate: (value) => submissionProblem(value, paper.pages, scoring.pages, topicIds),
	});

	return submission.questions.map((question) => ({
		id: apQuestionId(year, question.number, set),
		paperId: input.paper.id,
		scoringId: input.scoring.id,
		year,
		...(set === undefined ? {} : { set }),
		number: question.number,
		pages: question.pages,
		scoringPages: question.scoringPages,
		parts: question.parts.map((part) => ({
			label: part.label,
			...(part.topicId === "" ? {} : { topicId: part.topicId }),
			points: part.points.map((text, index) => ({ id: `${part.label}${index + 1}`, text })),
		})),
	}));
}