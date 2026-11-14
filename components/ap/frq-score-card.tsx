"use client";

import type { ArtifactPartProps } from "@/src/core";

/**
 * The free-response score card (AP prep stage 2, Task 11): the ONE verdict
 * surface for a released question, rendered from `ap_record_frq`'s result
 * details and from nothing else. The header names the question and the score;
 * each row carries a part's points, its topic (when the part is tagged) and
 * the outcome word. The tutor's reply explains the score — the card does not.
 *
 * A refused call returns the invalid-input details (`{ tool, problems }`), and
 * an unfinished part has no details yet; anything that does not satisfy the
 * shape guard renders NOTHING, so no verdict can leak from a non-result.
 */

/** One scored part: its rubric points and the recorded outcome word. */
export interface FrqScorePartDetails {
	label: string;
	earned: number;
	total: number;
	/** The part's confirmed topic text; absent when the part is untagged. */
	topicText?: string;
	outcome: "earned" | "missed" | "not counted";
}

/** The `ap_record_frq` success details rendered by this card. */
export interface FrqScoreDetails {
	questionId: string;
	title: string;
	earned: number;
	total: number;
	parts: FrqScorePartDetails[];
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isScorePart(value: unknown): value is FrqScorePartDetails {
	const part = value as Partial<FrqScorePartDetails> | null | undefined;
	return (
		typeof part?.label === "string" &&
		isFiniteNumber(part.earned) &&
		isFiniteNumber(part.total) &&
		(part.topicText === undefined || typeof part.topicText === "string") &&
		(part.outcome === "earned" || part.outcome === "missed" || part.outcome === "not counted")
	);
}

/** The shape guard for `ap_record_frq`'s success details. Exported so the
 *  card's single validation point can be tested directly. */
export function isFrqScoreDetails(value: unknown): value is FrqScoreDetails {
	const details = value as Partial<FrqScoreDetails> | null | undefined;
	return (
		typeof details?.questionId === "string" &&
		typeof details.title === "string" &&
		isFiniteNumber(details.earned) &&
		isFiniteNumber(details.total) &&
		Array.isArray(details.parts) &&
		details.parts.every(isScorePart)
	);
}

export function FrqScoreCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available" || !isFrqScoreDetails(part.output)) return null;
	const details = part.output;
	return (
		<div data-testid="frq-score-card" className="my-1 rounded-xl border bg-card p-4">
			<div data-testid="score-header" className="text-[15px] font-medium">
				{`${details.title} — scored ${details.earned}/${details.total}`}
			</div>
			<ul className="mt-2 space-y-1">
				{details.parts.map((scorePart) => (
					<li
						key={scorePart.label}
						data-testid="score-part"
						className="flex items-baseline gap-2 text-sm"
					>
						<span className="font-medium tabular-nums">{`(${scorePart.label})`}</span>
						<span className="tabular-nums">{`${scorePart.earned}/${scorePart.total}`}</span>
						{scorePart.topicText !== undefined && (
							<span className="min-w-0 text-muted-foreground">{scorePart.topicText}</span>
						)}
						{/* Plain words only: no ✓/✗ and no red. `earned` keeps the
						    body's emphasis; a miss reads in the muted register. */}
						<span
							className={`ml-auto shrink-0 ${
								scorePart.outcome === "earned" ? "text-foreground" : "text-muted-foreground"
							}`}
						>
							{scorePart.outcome}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}