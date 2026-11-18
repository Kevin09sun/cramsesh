"use client";

import Link from "next/link";

import { timeAgo } from "@/components/sidebar";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ChatSummary } from "@/src/core";

/**
 * Study boxes (2026-11-17): Tests and AP sessions leave the sidebar and live
 * on their test or course page. StudySessionList is that page's Sessions
 * block — one row per session (newest first, as the caller hands them), each
 * linking to its chat with a relative age, plus the page's New session
 * button. The list pages' "+ New" header links live here too.
 */

export function StudySessionList({
	sessions,
	newSession,
}: {
	sessions: ReadonlyArray<Pick<ChatSummary, "id" | "title" | "updatedAt">>;
	newSession: { label: string; onClick: () => void; disabled?: boolean; testId: string };
}) {
	return (
		<div data-testid="study-sessions" className="rounded-xl border bg-card p-4">
			<div className="mb-2 flex items-center justify-between gap-2">
				<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sessions</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					data-testid={newSession.testId}
					disabled={newSession.disabled}
					onClick={newSession.onClick}
				>
					{newSession.label}
				</Button>
			</div>
			{sessions.length === 0 ? (
				<p className="text-sm text-muted-foreground">No sessions yet.</p>
			) : (
				<ul className="space-y-1">
					{sessions.map((session) => (
						<li key={session.id}>
							<Link
								href={`/chat/${session.id}`}
								data-testid={`study-session-${session.id}`}
								className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
							>
								<span className="min-w-0 truncate text-sm">{session.title}</span>
								<span className="shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>
									{timeAgo(session.updatedAt)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function BoxNewLink({ href, testId, label }: { href: string; testId: string; label: string }) {
	return (
		<Link href={href} data-testid={testId} className={buttonVariants({ variant: "outline", size: "sm" })}>
			{label}
		</Link>
	);
}

/** The /tests header's "+ New test": a new Test prep session. */
export function NewTestLink() {
	return <BoxNewLink href="/chat/new?mode=testprep" testId="new-test" label="+ New test" />;
}

/** The /ap header's "+ New course": a new AP session. */
export function NewCourseLink() {
	return <BoxNewLink href="/chat/new?mode=ap" testId="new-course" label="+ New course" />;
}
