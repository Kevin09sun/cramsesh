"use client";

import { useState } from "react";

/**
 * The original pages of a released AP free-response question (AP prep stage
 * 2, 2026-11-14): the paper is shown as the images the official PDF renders
 * to, figures included, never as a transcription. The page route serves a
 * PNG per page; a page the stored paper cannot render (a missing paper on a
 * second computer, a malformed entry) is a 404 and its image reports the
 * failure, which this component says in words rather than leaving a broken
 * glyph.
 */
export function QuestionPages({
	courseId,
	file,
	pages,
	title,
	className,
}: {
	courseId: string;
	file: string;
	pages: number[];
	/** The question's heading, e.g. "2023 FRQ 2" — used for each image's alt text. */
	title: string;
	className?: string;
}) {
	const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());

	return (
		<div className={className ?? "flex flex-col gap-2"}>
			{pages.map((page) =>
				failed.has(page) ? (
					<div
						key={page}
						className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground"
					>
						This page could not be shown.
					</div>
				) : (
					// The page route serves the rendered PNG itself; next/image's
					// optimizer has nothing to add and would re-fetch the page.
					// eslint-disable-next-line @next/next/no-img-element
					<img
						key={page}
						src={`/api/ap/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(file)}/${page}`}
						alt={`${title} — page ${page}`}
						loading="lazy"
						className="w-full rounded-lg border"
						onError={() =>
							setFailed((previous) => {
								const next = new Set(previous);
								next.add(page);
								return next;
							})
						}
					/>
				),
			)}
		</div>
	);
}
