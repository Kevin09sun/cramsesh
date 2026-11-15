"use client";

import { useState } from "react";

import { OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { SessionStarter } from "@/components/start-session";
import { Button } from "@/components/ui/button";
import { sittingLabel } from "@/src/core";
import type { ApCourseRecord, ApSitting, ApSittingScope } from "@/src/core";

/**
 * Starting an AP practice sitting (AP prep, 2026-11-13).
 *
 * A unit, topic or the weak-topics button opens this small chooser: the
 * sitting's WHAT is the button that opened it; the chooser asks the KIND.
 * All three kinds always start: a free-response sitting asks a released
 * question when an unused one covers the topic and otherwise has the tutor
 * write one (AP prep stage 3, 2026-11-15), so it needs no released papers.
 *
 * A sitting is one session: POST /api/chats with the course id and the
 * sitting, then navigate to the returned chat. The session title is the
 * shared `sittingLabel` — "course · scope · kind" — so the sidebar names the
 * sitting without a second vocabulary.
 */
export function StartSitting({
	course,
	scope,
	testId,
	label = "Practise",
	navigate,
	fetchLike,
}: {
	course: Pick<ApCourseRecord, "id" | "title" | "sections">;
	scope: ApSittingScope;
	/** The trigger's data-testid (unit/topic/weak are separate buttons). */
	testId: string;
	label?: string;
	navigate?: (target: string) => void;
	fetchLike?: typeof fetch;
}) {
	const [open, setOpen] = useState(false);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [starter] = useState(() => new SessionStarter());
	const go = navigate ?? ((target: string) => window.location.assign(target));

	async function start(sitting: ApSitting): Promise<void> {
		if (starting) return;
		setStarting(true);
		setError(null);
		try {
			const target = await starter.start(
				{
					title: sittingLabel(course, sitting),
					kind: "ap",
					apCourseId: course.id,
					apSitting: sitting,
				},
				fetchLike ?? fetch,
			);
			go(target);
		} catch {
			setStarting(false);
			setError(OPENING_PROMPT_FAILURE);
		}
	}

	return (
		<div className="relative inline-block">
			<Button
				type="button"
				variant="outline"
				size="sm"
				data-testid={testId}
				aria-expanded={open}
				disabled={starting}
				onClick={() => {
					setError(null);
					setOpen((current) => !current);
				}}
			>
				{starting ? "Starting…" : label}
			</Button>
			{open && (
				<div
					data-testid="sitting-chooser"
					className="absolute right-0 z-10 mt-1 w-64 rounded-xl border bg-card p-3 shadow-md"
				>
					<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Start a sitting
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="w-full justify-start"
						data-testid="sitting-mcq"
						disabled={starting}
						onClick={() => void start({ scope, kind: "mcq" })}
					>
						Multiple-choice
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-2 w-full justify-start"
						data-testid="sitting-frq"
						disabled={starting}
						onClick={() => void start({ scope, kind: "frq" })}
					>
						Free-response
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-1 w-full justify-start"
						data-testid="sitting-mixed"
						disabled={starting}
						onClick={() => void start({ scope, kind: "mixed" })}
					>
						Mixed
					</Button>
					{error && (
						<p role="alert" className="mt-2 text-xs text-destructive">
							{error}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
