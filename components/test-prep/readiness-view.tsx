"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { FilePickerBusy, PICKER_BUSY_NOTICE, requestNativePaths } from "@/components/attach-files-button";
import { SidebarToggle } from "@/components/sidebar";
import { SessionStarter } from "@/components/start-session";
import { StudySessionList } from "@/components/study-session-list";
import { CoverageLine } from "@/components/test-prep/coverage-line";
import { LeftOutList } from "@/components/test-prep/left-out-list";
import { PlanEditor } from "@/components/test-prep/plan-editor";
import { ResweepAdditionsCard } from "@/components/test-prep/resweep-additions-card";
import { Button } from "@/components/ui/button";
import { readiness, readinessPercent, formatStudySpan } from "@/src/core";
import type { ChatSummary, LeftOutItem, PlanDraftSection, PointStatus, TestRecord } from "@/src/core";

/**
 * The readiness view (test prep, 2026-11-10) — option B of the approved
 * mockup: the test's name, one overall "Ready: N%" (the shared count-based
 * rule, never a rounded-up score), and one bar per section showing its
 * solid/total counts. Opening a section reveals its points and each one's
 * status badge.
 *
 * Two actions live here. "Edit plan" reuses PlanEditor on the confirmed
 * plan: a save always confirms (confirm:true through PUT /api/tests/[id]/plan)
 * so the learner never loses the ability to answer. "Continue where I left
 * off" creates the next testprep sitting through the ordinary new-session
 * flow — POST /api/chats {kind:"testprep", testId}, then navigate — with
 * "Continue." as its first message, delivered the normal way.
 */

const STATUS_LABEL: Record<PointStatus, string> = {
	solid: "Solid",
	gap: "Gap",
	"fixed-recheck": "Re-check next time",
	unchecked: "Not checked yet",
};

/** The existing status register (answered-card / practice-cards): green for
 *  right, red for a gap, amber for fixed-but-unverified, muted for untried.
 *  The /15 fills read correctly in both themes. */
const STATUS_CLASS: Record<PointStatus, string> = {
	solid: "bg-green-500/15 text-green-500",
	gap: "bg-red-500/15 text-red-500",
	"fixed-recheck": "bg-amber-500/15 text-amber-500",
	unchecked: "bg-muted text-muted-foreground",
};

function toDraft(sections: TestRecord["sections"]): PlanDraftSection[] {
	return sections.map((section) => ({
		id: section.id,
		title: section.title,
		points: section.points.map((point) => ({ id: point.id, text: point.text, source: point.source })),
	}));
}

function errorText(reason: unknown, fallback: string): string {
	return reason instanceof Error && reason.message !== "" ? reason.message : fallback;
}

/** Create the next sitting for an existing test. The opening message is
 *  the ordinary first message ("Continue."), stashed and delivered by the
 *  chat page exactly like a Teach/Practice draft send. */
export async function continueSession(
	testId: string,
	fetchLike: typeof fetch,
	starter = new SessionStarter(),
): Promise<string> {
	return starter.start({ title: "Continue.", kind: "testprep", testId }, fetchLike);
}

export function ReadinessView({
	test: initialTest,
	sessions,
	navigate,
	onSessionsChanged,
}: {
	test: TestRecord;
	/** This test's sessions, newest first (sessionsForTest over listChats). */
	sessions: ChatSummary[];
	/** Where to go after starting the next sitting. Production supplies the
	 *  app router; the shell seam keeps the view renderable without one. */
	navigate?: (target: string) => void;
	/** After a session is renamed or deleted from the Sessions block —
	 *  production refreshes the server-rendered page (router.refresh()). */
	onSessionsChanged?: () => void;
}) {
	const [test, setTest] = useState<TestRecord>(initialTest);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [starting, setStarting] = useState(false);
	const [accepting, setAccepting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The test prop only gains `folder` when the page reloads. A folder chosen
	// here is followed locally from the moment its sweep launch is accepted.
	const [chosenFolder, setChosenFolder] = useState<string | null>(null);
	const [choosing, setChoosing] = useState(false);

	const ready = readiness(test);
	const totals = ready.sections.reduce(
		(acc, section) => ({ solid: acc.solid + section.solid, total: acc.total + section.total }),
		{ solid: 0, total: 0 },
	);
	const percent = readinessPercent(totals.solid, totals.total);
	// The test's study time is the sum of its sittings (issue #16) — each
	// session's own clock wrote its per-day log; this is the same fold the
	// session rows show, one level up.
	const studyMs = sessions.reduce((sum, session) => sum + (session.timeMs ?? 0), 0);

	const sweep = test.sweep;
	const pendingAdditions = test.pendingAdditions;
	const sweepRunning = sweep?.status === "running";
	const folder = chosenFolder ?? test.folder;
	const resweepDisabled = !folder || pendingAdditions !== undefined || sweepRunning;
	// Re-sweep folder only renders once a folder is known, so the only
	// remaining reason to disable it is the additions review.
	const resweepTitle = pendingAdditions !== undefined ? "Review the new items first" : undefined;

	// A re-sweep is background work: poll its progress only while it runs, and
	// let the first non-running answer tear the interval down.
	useEffect(() => {
		if (!sweepRunning) return;
		let alive = true;
		const timer = setInterval(() => {
			void (async () => {
				try {
					const response = await fetch(`/api/tests/${test.id}/sweep`);
					if (!response.ok || !alive) return;
					const payload = (await response.json()) as {
						sweep?: TestRecord["sweep"] | null;
						pendingAdditions?: TestRecord["pendingAdditions"] | null;
					};
					if (!alive) return;
					setTest((current) => ({
						...current,
						sweep: payload.sweep ?? undefined,
						pendingAdditions: payload.pendingAdditions ?? undefined,
					}));
				} catch {
					// Transient poll failure: keep the last good record.
				}
			})();
		}, 2000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [sweepRunning, test.id]);

	const go = navigate ?? ((target: string) => window.location.assign(target));

	function toggleSection(id: string): void {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	async function save(sections: PlanDraftSection[]): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			const response = await fetch(`/api/tests/${test.id}/plan`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				// A readiness edit is always a confirmed plan: the learner is
				// refining scope mid-course, never re-proposing from scratch.
				body: JSON.stringify({ sections, confirm: true }),
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as {
					problems?: unknown;
					error?: unknown;
				} | null;
				const problems = Array.isArray(payload?.problems)
					? payload.problems.filter((problem): problem is string => typeof problem === "string")
					: [];
				throw new Error(
					problems.length > 0
						? problems.join(" ")
						: typeof payload?.error === "string"
							? payload.error
							: "The plan could not be saved.",
				);
			}
			setTest((await response.json()) as TestRecord);
			setEditing(false);
		} catch (reason) {
			setError(errorText(reason, "The plan could not be saved."));
		} finally {
			setSaving(false);
		}
	}

	async function start(): Promise<void> {
		if (starting) return;
		setStarting(true);
		setError(null);
		try {
			go(await continueSession(test.id, fetch));
		} catch {
			setStarting(false);
			setError(OPENING_PROMPT_FAILURE);
		}
	}

	/** Pull the sweep view (progress + pending additions) after a launch or
	 *  during a poll, so the header and review card track the background run. */
	async function refreshSweep(): Promise<void> {
		const response = await fetch(`/api/tests/${test.id}/sweep`);
		if (!response.ok) return;
		const payload = (await response.json()) as {
			sweep?: TestRecord["sweep"] | null;
			pendingAdditions?: TestRecord["pendingAdditions"] | null;
		};
		setTest((current) => ({
			...current,
			sweep: payload.sweep ?? undefined,
			pendingAdditions: payload.pendingAdditions ?? undefined,
		}));
	}

	/** Start a re-sweep, optionally offering a folder for a test that has none.
	 *  Resolves true when the launch was accepted; errors (including the
	 *  route's own message) land in the page's error line. */
	async function resweep(folderOverride?: string): Promise<boolean> {
		if (folderOverride === undefined && resweepDisabled) return false;
		setError(null);
		try {
			const response = await fetch(
				`/api/tests/${test.id}/sweep`,
				folderOverride === undefined
					? { method: "POST" }
					: {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ folder: folderOverride }),
						},
			);
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
				throw new Error(
					typeof payload?.error === "string" ? payload.error : "The re-sweep could not start.",
				);
			}
			await refreshSweep();
			return true;
		} catch (reason) {
			setError(errorText(reason, "The re-sweep could not start."));
			return false;
		}
	}

	/** Choose the materials folder a test with none needs. The desktop bridge
	 *  opens its native dialog; a browser asks the server for one. A cancelled
	 *  pick is a no-op; an accepted launch records the folder locally so the
	 *  header switches to the ordinary Re-sweep folder action. */
	async function chooseFolder(): Promise<void> {
		if (choosing) return;
		setChoosing(true);
		setError(null);
		try {
			let path: string | null;
			const choose = window.lh?.chooseAttachmentFolder;
			if (choose) {
				path = await choose();
			} else {
				const paths = await requestNativePaths("folder");
				if (paths === null) {
					setError("The folder picker is not available on this system.");
					return;
				}
				path = paths[0] ?? null;
			}
			if (path === null) return; // Native cancellation changes nothing.
			if (await resweep(path)) setChosenFolder(path);
		} catch (reason) {
			setError(reason instanceof FilePickerBusy ? PICKER_BUSY_NOTICE : "Could not choose a folder. Try again.");
		} finally {
			setChoosing(false);
		}
	}

	async function acceptAdditions(accepted: string[]): Promise<void> {
		setAccepting(true);
		setError(null);
		try {
			const response = await fetch(`/api/tests/${test.id}/additions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ accepted }),
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
				throw new Error(
					typeof payload?.error === "string" ? payload.error : "The additions could not be saved.",
				);
			}
			setTest((await response.json()) as TestRecord);
		} catch (reason) {
			setError(errorText(reason, "The additions could not be saved."));
		} finally {
			setAccepting(false);
		}
	}

	async function promote(item: LeftOutItem): Promise<void> {
		setError(null);
		try {
			const response = await fetch(`/api/tests/${test.id}/left-out`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ itemId: item.id }),
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
				throw new Error(
					typeof payload?.error === "string" ? payload.error : "The item could not be promoted.",
				);
			}
			setTest((await response.json()) as TestRecord);
		} catch (reason) {
			setError(errorText(reason, "The item could not be promoted."));
		}
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h1 className="font-title text-3xl tracking-tight">{test.title}</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Ready:{" "}
						<span className="text-lg font-semibold tabular-nums text-foreground">{percent}%</span>
						{totals.total > 0 && (
							<span>
								{" "}
								· {totals.solid}/{totals.total} points solid
							</span>
						)}
						{studyMs > 0 && (
							<span data-testid="test-study-time"> · {formatStudySpan(studyMs)} studied</span>
						)}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						data-testid="edit-plan"
						disabled={starting}
						onClick={() => {
							setError(null);
							setEditing((current) => !current);
						}}
					>
						{editing ? "Close editor" : "Edit plan"}
					</Button>
					{folder ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							data-testid="resweep-folder"
							disabled={resweepDisabled}
							title={resweepTitle}
							onClick={() => void resweep()}
						>
							{sweepRunning ? (sweep?.activity ?? "Re-sweeping…") : "Re-sweep folder"}
						</Button>
					) : (
						<Button
							type="button"
							variant="outline"
							size="sm"
							data-testid="choose-folder"
							disabled={choosing}
							onClick={() => void chooseFolder()}
						>
							Choose folder…
						</Button>
					)}
					{test.planConfirmed ? (
						<Button
							type="button"
							size="sm"
							data-testid="continue-test"
							disabled={starting}
							onClick={() => void start()}
						>
							{starting ? "Starting…" : "Continue where I left off"}
						</Button>
					) : (
						<p className="self-center text-sm text-muted-foreground">
							Plan awaiting review — confirm it in the chat.
						</p>
					)}
				</div>
			</div>

			{sweep?.coverage && (
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<CoverageLine coverage={sweep.coverage} />
					{sweep.coverage.lastResweep && (
						<p data-testid="last-resweep" className="text-xs text-muted-foreground">
							Last re-sweep: +{sweep.coverage.lastResweep.files} files
						</p>
					)}
				</div>
			)}

			{sweep?.status === "error" && sweep.error && (
				<p role="alert" data-testid="sweep-error" className="text-sm text-destructive">
					{sweep.error}
				</p>
			)}

			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}

			{pendingAdditions && (
				<ResweepAdditionsCard
					additions={pendingAdditions}
					onAccept={(accepted) => void acceptAdditions(accepted)}
					accepting={accepting}
				/>
			)}

			{editing && (
				<div className="rounded-xl border bg-card p-4">
					<div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Edit plan
					</div>
					<PlanEditor
						initial={toDraft(test.sections)}
						onSave={save}
						saving={saving}
						submitLabel="Save plan"
					/>
				</div>
			)}

			<div data-testid="readiness-sections" className="space-y-3">
				{ready.sections.map((section) => {
					const open = expanded.has(section.id);
					const sectionPercent = readinessPercent(section.solid, section.total);
					// readiness() carries the counts; the points (with their
					// statuses) live on the record, matched by the shared id.
					const points = test.sections.find((entry) => entry.id === section.id)?.points ?? [];
					return (
						<div key={section.id} className="rounded-xl border bg-card p-4">
							<button
								type="button"
								data-testid={`readiness-section-${section.id}`}
								aria-expanded={open}
								onClick={() => toggleSection(section.id)}
								className="flex w-full cursor-pointer items-center justify-between gap-3 text-left"
							>
								<span className="text-sm font-medium">{section.title}</span>
								<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
									{section.solid}/{section.total}
								</span>
							</button>
							<div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
								<div
									className="h-full rounded-full bg-green-500 transition-[width]"
									style={{ width: `${sectionPercent}%` }}
								/>
							</div>
							{open &&
								(points.length === 0 ? (
									<p className="mt-3 text-sm text-muted-foreground">
										This section has no points yet.
									</p>
								) : (
									<ul className="mt-3 space-y-2">
										{points.map((point) => (
											<li key={point.id} className="flex items-start justify-between gap-3">
												<span className="min-w-0 text-sm">{point.text}</span>
												<span
													data-testid="point-status"
													className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_CLASS[point.status]}`}
												>
													{STATUS_LABEL[point.status]}
												</span>
											</li>
										))}
									</ul>
								))}
						</div>
					);
				})}
			</div>

			{test.sections.length === 0 && (
				<p className="text-sm text-muted-foreground">
					No plan yet — the agent proposes one in your first sitting.
				</p>
			)}

			<LeftOutList items={test.leftOut ?? []} onPromote={(item) => void promote(item)} />

			<StudySessionList
				sessions={sessions}
				onSessionsChanged={onSessionsChanged}
				newSession={{
					label: "New session",
					testId: "new-test-session",
					disabled: starting,
					onClick: () => void start(),
				}}
			/>
		</div>
	);
}

/** The routed readiness page body: the app router is the only Next coupling,
 *  kept out of ReadinessView so the view renders in tests and previews. */
export function ReadinessPage({ test, sessions }: { test: TestRecord; sessions: ChatSummary[] }) {
	const router = useRouter();
	return (
		<div className="relative flex h-dvh flex-col">
			<header className="flex h-15 shrink-0 items-center gap-2 border-b border-border px-3">
				<SidebarToggle />
				<Link
					href="/tests"
					className="text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
				>
					Tests
				</Link>
			</header>
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-3xl px-6 py-8">
					<ReadinessView
						test={test}
						sessions={sessions}
						navigate={(target) => router.push(target)}
						onSessionsChanged={() => router.refresh()}
					/>
				</div>
			</main>
		</div>
	);
}