"use client";

import { coverageLine } from "@/src/core";
import type { SweepCoverage } from "@/src/core";

/**
 * The audit line under a swept plan's title (Task 10): files and pages read,
 * what was looked at by vision, and the files/pages that were not (or could
 * not be) read. Renders nothing before any sweep has recorded coverage, so a
 * handmade plan's review card is unchanged.
 *
 * Reused by Task 11's readiness page — the wording is the shared
 * coverageLine() rule, never re-spelled here.
 */
export function CoverageLine({ coverage }: { coverage?: SweepCoverage }) {
	if (!coverage) return null;
	const line = coverageLine(coverage);
	if (line.trim() === "") return null;
	return (
		<p data-testid="coverage-line" className="mb-3 text-xs text-muted-foreground">
			{line}
		</p>
	);
}