"use client";

import { useCallback, useEffect, useState } from "react";

import { useServerEvent, useServerResync } from "@/components/server-events";
import { sittingProgress } from "@/src/core";
import type { TestRecord } from "@/src/core";

/** The header pill: a mini bar plus "done/total" for this sitting. */
export function SittingProgressPill({ done, total }: { done: number; total: number }) {
	const percent = total === 0 ? 0 : Math.round((done * 100) / total);
	return (
		<span
			data-testid="sitting-progress"
			title={`${total - done} of ${total} questions left in this session`}
			className="flex shrink-0 select-none items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
		>
			<span
				className="h-1.5 w-14 overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-label="Questions answered this session"
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={done}
			>
				<span className="block h-full rounded-full bg-green-500 transition-[width]" style={{ width: `${percent}%` }} />
			</span>
			{done}/{total}
		</span>
	);
}

/** Live progress of this test-prep chat's run; hidden until the plan is
 *  confirmed and there is something to work through. */
export function SittingProgress({ testId, chatId }: { testId: string; chatId: string }) {
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/tests/${encodeURIComponent(testId)}`, { cache: "no-store" });
			if (!res.ok) return;
			const test = (await res.json()) as TestRecord;
			setProgress(test.planConfirmed ? sittingProgress(test, chatId) : null);
		} catch {
			// A failed read keeps the last value; the next event retries.
		}
	}, [testId, chatId]);

	useEffect(() => {
		void load();
	}, [load]);
	useServerEvent("tests-changed", () => void load());
	useServerResync(() => void load());

	if (!progress || progress.total === 0) return null;
	return <SittingProgressPill done={progress.done} total={progress.total} />;
}
