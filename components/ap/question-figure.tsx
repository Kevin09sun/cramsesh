"use client";

import { useState } from "react";

/**
 * A drawn figure on an AP question (AP prep stage 3, 2026-11-15): one
 * finished drawing of this chat, served as a PNG by the chat's figure route.
 * The route answers 404 for a figure from another chat, an unfinished
 * drawing or a failed one; a failed image reports it in words rather than
 * leaving a broken glyph (the same rule as a released paper's pages).
 */
export function QuestionFigure({
	chatId,
	figure,
	className,
}: {
	chatId: string;
	/** The finished drawing job's id, as the question's call carried it. */
	figure: string;
	className?: string;
}) {
	const [failed, setFailed] = useState(false);

	return (
		<div className={className}>
			{failed ? (
				<div className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
					This figure could not be shown.
				</div>
			) : (
				// The figure route serves the rendered PNG itself; next/image's
				// optimizer has nothing to add and would re-fetch the drawing.
				// eslint-disable-next-line @next/next/no-img-element
				<img
					src={`/api/chats/${encodeURIComponent(chatId)}/figures/${encodeURIComponent(figure)}`}
					alt="Figure for this question"
					loading="lazy"
					className="w-full rounded-lg border"
					onError={() => setFailed(true)}
				/>
			)}
		</div>
	);
}
