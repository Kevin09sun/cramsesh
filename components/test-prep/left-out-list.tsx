"use client";

import { ChevronRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { LeftOutItem } from "@/src/core";

/**
 * The material the sweep judged to be noise (Task 10), kept visible and
 * recoverable: a collapsed "Left out (N)" list under the plan editor. Every
 * row shows its text, why the merger set it aside, and where it came from;
 * Promote hands the item back to the plan's draft.
 *
 * Reused by Task 11's readiness page, which passes a read-only variant (the
 * Promote button is hidden). An empty list renders nothing at all.
 */
export function LeftOutList({
	items,
	onPromote,
	defaultOpen = false,
	readOnly = false,
}: {
	items: LeftOutItem[];
	/** Required unless readOnly; a read-only list (the re-sweep review card)
	 *  has nothing to promote. */
	onPromote?: (item: LeftOutItem) => void;
	defaultOpen?: boolean;
	readOnly?: boolean;
}) {
	if (items.length === 0) return null;

	return (
		<Collapsible defaultOpen={defaultOpen} className="mt-3 rounded-lg border bg-background/50">
			<CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 p-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
				<ChevronRightIcon className="size-3.5" aria-hidden="true" />
				Left out ({items.length})
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="space-y-2 border-t px-3 py-2">
					{items.map((item) => (
						<li key={item.id} className="flex items-start justify-between gap-2">
							<div className="min-w-0">
								<div className="text-sm">{item.text}</div>
								<div className="text-xs text-muted-foreground">
									{item.reason} · {item.source}
								</div>
							</div>
							{!readOnly && onPromote && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									data-testid="promote-left-out"
									aria-label={`Promote ${item.text}`}
									onClick={() => onPromote(item)}
								>
									Promote
								</Button>
							)}
						</li>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}