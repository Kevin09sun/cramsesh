"use client";

import { useState } from "react";

import { LeftOutList } from "@/components/test-prep/left-out-list";
import { Button } from "@/components/ui/button";
import type { PendingAdditions } from "@/src/core";

/**
 * The re-sweep's proposal, held for review (test material sweep, 2026-11-21).
 * Each proposed point is a checkbox (checked by default) grouped under its
 * section title; "Add accepted" hands the checked proposal keys
 * (`${sectionIndex}:${pointIndex}`) to the readiness page, which posts them to
 * POST /api/tests/[id]/additions. The proposal's own left-out items are shown
 * read-only below — recovering those happens from the persistent list once
 * the review clears.
 */
export function ResweepAdditionsCard({
	additions,
	onAccept,
	accepting = false,
}: {
	additions: PendingAdditions;
	onAccept: (accepted: string[]) => void;
	accepting?: boolean;
}) {
	const [checked, setChecked] = useState<ReadonlySet<string>>(() => {
		const all = new Set<string>();
		additions.sections.forEach((section, sectionIndex) => {
			section.points.forEach((_point, pointIndex) => {
				all.add(`${sectionIndex}:${pointIndex}`);
			});
		});
		return all;
	});

	function setOne(key: string, next: boolean): void {
		setChecked((current) => {
			const updated = new Set(current);
			if (next) updated.add(key);
			else updated.delete(key);
			return updated;
		});
	}

	function accept(): void {
		const keys: string[] = [];
		// Section order, not Set order, so the accepted list is deterministic.
		additions.sections.forEach((section, sectionIndex) => {
			section.points.forEach((_point, pointIndex) => {
				const key = `${sectionIndex}:${pointIndex}`;
				if (checked.has(key)) keys.push(key);
			});
		});
		onAccept(keys);
	}

	return (
		<div data-testid="resweep-additions" className="rounded-xl border bg-card p-4">
			<div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Re-sweep additions
			</div>
			<div className="space-y-3">
				{additions.sections.map((section, sectionIndex) => (
					<div key={`${section.id ?? "new"}-${sectionIndex}`}>
						<div className="text-sm font-medium">{section.title}</div>
						<ul className="mt-1 space-y-1">
							{section.points.map((point, pointIndex) => {
								const key = `${sectionIndex}:${pointIndex}`;
								return (
									<li key={key}>
										<label className="flex cursor-pointer items-start gap-2 text-sm">
											<input
												type="checkbox"
												data-testid={`addition-${key}`}
												checked={checked.has(key)}
												onChange={(event) => setOne(key, event.target.checked)}
												className="mt-0.5 size-3.5 shrink-0 accent-primary"
											/>
											<span className="min-w-0">
												{point.text}
												<span className="ml-2 text-xs text-muted-foreground">{point.source}</span>
											</span>
										</label>
									</li>
								);
							})}
						</ul>
					</div>
				))}
			</div>
			<Button
				type="button"
				size="sm"
				className="mt-3"
				data-testid="add-accepted"
				disabled={accepting}
				onClick={accept}
			>
				{accepting ? "Adding…" : "Add accepted"}
			</Button>
			<LeftOutList items={additions.leftOut} readOnly />
		</div>
	);
}