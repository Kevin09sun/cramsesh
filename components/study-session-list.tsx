"use client";

import Link from "next/link";

import { SessionRenameInput, useSessionContextMenu } from "@/components/session-context-menu";
import { timeAgo } from "@/components/sidebar";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ChatSummary } from "@/src/core";

/**
 * Study boxes (2026-11-17): Tests and AP sessions leave the sidebar and live
 * on their test or course page. StudySessionList is that page's Sessions
 * block — one row per session (newest first, as the caller hands them), each
 * linking to its chat with a relative age, plus the page's New session
 * button. The list pages' "+ New" header links live here too.
 *
 * Right-click a row (or the Menu key / Shift+F10 on a focused row) for the
 * sidebar's session menu — Rename / Export as Markdown / Delete (owner,
 * 2026-11-17). The page is server-rendered, so a rename or delete calls
 * onSessionsChanged (the page wrapper's router.refresh()) to refetch it;
 * deleting a session from its box never navigates away.
 */

export function StudySessionList({
	sessions,
	newSession,
	onSessionsChanged,
}: {
	sessions: ReadonlyArray<Pick<ChatSummary, "id" | "title" | "updatedAt">>;
	newSession: { label: string; onClick: () => void; disabled?: boolean; testId: string };
	/** After a rename or delete from the row menu — the page refetches. */
	onSessionsChanged?: () => void;
}) {
	const { openContext, renamingId, commitRename, cancelRename, menu } = useSessionContextMenu({
		onRenamed: () => onSessionsChanged?.(),
		onDeleted: () => onSessionsChanged?.(),
	});
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
							{renamingId === session.id ? (
								<div
									data-testid="study-session-rename-row"
									className="flex items-center justify-between gap-3 rounded-md bg-accent px-2 py-1.5"
								>
									<SessionRenameInput
										title={session.title}
										onCommit={(next) => void commitRename(session.id, next)}
										onCancel={cancelRename}
										className="lh-input min-w-0 flex-1 truncate border-0 border-b border-border bg-transparent px-0 text-sm text-foreground outline-none"
									/>
									<span className="shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>
										{timeAgo(session.updatedAt)}
									</span>
								</div>
							) : (
								<Link
									href={`/chat/${session.id}`}
									data-testid={`study-session-${session.id}`}
									onContextMenu={(e) => openContext(e, session)}
									className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
								>
									<span className="min-w-0 truncate text-sm">{session.title}</span>
									<span className="shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>
										{timeAgo(session.updatedAt)}
									</span>
								</Link>
							)}
						</li>
					))}
				</ul>
			)}
			{menu}
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
