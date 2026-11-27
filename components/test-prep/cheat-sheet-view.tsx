"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { SidebarToggle } from "@/components/sidebar";
import { normalizeCheatSheet } from "@/src/core";
import type { CheatSheet, CheatSheetBuild, CheatSheetSection, TestRecord } from "@/src/core";

/**
 * The revision sheet page (issue #15).
 *
 * One documented page per test, built from the confirmed plan and the
 * material the sweep cached. The page both VIEWS the stored sheet and owns
 * its background build: no sheet yet shows the build action, a build in
 * flight is polled until it succeeds or fails, and a finished sheet renders
 * the paper document with print and rebuild actions.
 *
 * The sheet is a paper document in both app themes — what prints is what was
 * read on screen — so it uses the sheet tokens (globals.css), never the app
 * surface tokens.
 */

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** Locale-independent date for the masthead ("27 Nov 2026") — the server and
 *  the client must agree byte for byte. */
export function sheetDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function errorText(reason: unknown, fallback: string): string {
	return reason instanceof Error && reason.message !== "" ? reason.message : fallback;
}

async function readError(response: Response, fallback: string): Promise<string> {
	const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
	return typeof payload?.error === "string" ? payload.error : fallback;
}

function SectionCard({ section, index }: { section: CheatSheetSection; index: number }) {
	return (
		<section
			data-testid="cheat-sheet-section"
			className="mb-4 break-inside-avoid rounded-xl border bg-[var(--sheet-paper)] p-4 print:mb-3 print:rounded-none print:border-0 print:border-b print:p-0 print:pb-3"
		>
			<div className="flex items-baseline gap-2">
				<span className="font-title text-sm tabular-nums text-[var(--sheet-accent)]">
					{String(index + 1).padStart(2, "0")}
				</span>
				<h2 className="min-w-0 font-title text-xl leading-tight text-[var(--sheet-ink)]">
					{section.title}
				</h2>
			</div>
			{section.idea !== "" && (
				<p className="mt-1 text-base leading-relaxed text-[var(--sheet-ink-soft)]">
					{section.idea}
				</p>
			)}
			{section.facts.length > 0 && (
				<dl className="mt-3 space-y-1.5">
					{section.facts.map((fact, factIndex) => (
						<div
							key={`${section.id}-${factIndex}`}
							className="border-t pt-1.5 first:border-t-0 first:pt-0"
						>
							{fact.label !== "" && (
								<dt className="inline text-sm font-extrabold text-[var(--sheet-ink)]">
									{fact.label}
									{fact.body !== "" && (
										<span className="font-normal text-[var(--sheet-ink-soft)]">: </span>
									)}
								</dt>
							)}
							{fact.body !== "" && (
								<dd className="inline text-sm leading-relaxed text-[var(--sheet-ink-soft)]">
									{fact.body}
								</dd>
							)}
						</div>
					))}
				</dl>
			)}
			{section.formulas.length > 0 && (
				<ul className="mt-3 space-y-1">
					{section.formulas.map((formula, formulaIndex) => (
						<li
							key={`${section.id}-formula-${formulaIndex}`}
							className="rounded-md bg-[var(--sheet-wash)] px-2 py-1 font-mono text-xs text-[var(--sheet-ink)]"
						>
							{formula}
						</li>
					))}
				</ul>
			)}
			{section.trap !== undefined && (
				<p className="sheet-accent-rule mt-3 border-l-2 pl-2 text-sm leading-relaxed text-[var(--sheet-ink)]">
					<span className="font-extrabold">Watch for: </span>
					{section.trap}
				</p>
			)}
			<p className="mt-3 text-xs text-[var(--sheet-ink-soft)]">{section.source}</p>
		</section>
	);
}

/** The document itself — exported pure so render tests can pose a sheet. */
export function CheatSheetArticle({ sheet, title }: { sheet: CheatSheet; title: string }) {
	return (
		<article
			data-testid="cheat-sheet"
			className="cheat-sheet mx-auto w-full max-w-[860px] border bg-[var(--sheet-paper)] px-8 py-8 text-[var(--sheet-ink)] shadow-[var(--sheet-shadow)] sm:px-10 sm:py-10 print:max-w-none print:border-0 print:px-0 print:py-0 print:shadow-none"
		>
			<header className="sheet-accent-rule border-b-2 pb-4">
				<p className="text-sm text-[var(--sheet-ink-soft)]">Cheat sheet</p>
				<h1 className="mt-1 max-w-[28ch] font-title text-3xl leading-tight [overflow-wrap:anywhere]">
					{title}
				</h1>
				{sheet.intro !== "" && (
					<p className="mt-2 max-w-[62ch] text-lg leading-relaxed text-[var(--sheet-ink-soft)]">
						{sheet.intro}
					</p>
				)}
				<p className="mt-3 flex flex-wrap gap-x-3 text-xs text-[var(--sheet-ink-soft)]">
					<span>
						{sheet.sections.length} {sheet.sections.length === 1 ? "section" : "sections"}
					</span>
					<span>Built {sheetDate(sheet.generatedAt)}</span>
				</p>
			</header>
			<div className="mt-5 columns-1 gap-5 sm:columns-2">
				{sheet.sections.map((section, index) => (
					<SectionCard key={section.id} section={section} index={index} />
				))}
			</div>
			<footer className="mt-2 border-t border-[var(--sheet-rule)] pt-3 text-xs text-[var(--sheet-ink-soft)]">
				Built from your plan and the materials Cramsesh read for this test. Blank space is a reminder:
				write the one thing you keep forgetting beside its fact.
			</footer>
		</article>
	);
}

export function CheatSheetView({
	test,
	navigate,
}: {
	test: TestRecord;
	navigate?: (target: string) => void;
}) {
	const [sheet, setSheet] = useState<CheatSheet | null>(() => normalizeCheatSheet(test.cheatSheet));
	const [build, setBuild] = useState<CheatSheetBuild | null>(test.cheatSheetBuild ?? null);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const running = build?.status === "running";
	// The sheet is a snapshot: a plan whose sections changed after the build
	// means the page may describe scope that no longer exists.
	const planChanged =
		sheet !== null &&
		(sheet.sections.length !== test.sections.length ||
			sheet.sections.some(
				(section, index) =>
					section.id !== test.sections[index]?.id || section.title !== test.sections[index]?.title,
			));

	// Refresh once on mount: the server-rendered record may carry a build
	// whose process died (the route closes it), and a build may have finished
	// between the server render and hydration.
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const response = await fetch(`/api/tests/${test.id}/cheat-sheet`);
				if (!response.ok || !alive) return;
				const payload = (await response.json()) as { cheatSheet?: unknown; build?: CheatSheetBuild | null };
				if (!alive) return;
				setSheet(normalizeCheatSheet(payload.cheatSheet));
				setBuild(payload.build ?? null);
			} catch {
				// The rendered record stays the truth on a transient failure.
			}
		})();
		return () => {
			alive = false;
		};
	}, [test.id]);

	// Poll only while a build runs; the first non-running answer tears the
	// interval down.
	useEffect(() => {
		if (!running) return;
		let alive = true;
		const timer = setInterval(() => {
			void (async () => {
				try {
					const response = await fetch(`/api/tests/${test.id}/cheat-sheet`);
					if (!response.ok || !alive) return;
					const payload = (await response.json()) as { cheatSheet?: unknown; build?: CheatSheetBuild | null };
					if (!alive) return;
					setSheet(normalizeCheatSheet(payload.cheatSheet));
					setBuild(payload.build ?? null);
				} catch {
					// Transient poll failure: keep the last good state.
				}
			})();
		}, 2500);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [running, test.id]);

	async function buildSheet(): Promise<void> {
		if (starting || running) return;
		setStarting(true);
		setError(null);
		try {
			const response = await fetch(`/api/tests/${test.id}/cheat-sheet`, { method: "POST" });
			if (!response.ok) throw new Error(await readError(response, "The cheat sheet could not be built."));
			setBuild({ status: "running", startedAt: new Date().toISOString() });
		} catch (reason) {
			setError(errorText(reason, "The cheat sheet could not be built."));
		} finally {
			setStarting(false);
		}
	}

	function go(target: string): void {
		if (navigate) navigate(target);
		else window.location.assign(target);
	}

	function print(): void {
		if (typeof window.print === "function") window.print();
	}

	if (!test.planConfirmed) {
		return (
			<div className="mx-auto w-full max-w-2xl rounded-xl border bg-card p-6">
				<h1 className="font-title text-2xl">Confirm the plan first</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					A cheat sheet is built from your confirmed plan. Confirm it in the chat, then come back.
				</p>
				<Button className="mt-4" size="sm" variant="outline" onClick={() => go(`/tests/${test.id}`)}>
					Back to readiness
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="mx-auto flex w-full max-w-[860px] flex-wrap items-center gap-2 print:hidden">
				<Link
					href={`/tests/${test.id}`}
					className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
				>
					Back to readiness
				</Link>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					{running ? (
						<span className="text-sm text-muted-foreground">
							{sheet ? "Rebuilding…" : "Building…"}
						</span>
					) : (
						sheet && (
							<Button type="button" variant="outline" size="sm" data-testid="rebuild-cheat-sheet" onClick={() => void buildSheet()}>
								Rebuild
							</Button>
						)
					)}
					{sheet && (
						<Button type="button" size="sm" data-testid="print-cheat-sheet" onClick={print}>
							Print / Save as PDF
						</Button>
					)}
				</div>
			</div>

			{error && (
				<p role="alert" className="mx-auto w-full max-w-[860px] text-sm text-destructive print:hidden">
					{error}
				</p>
			)}

			{sheet ? (
				<>
					{!running && build?.status === "error" && build.error && (
						<p
							role="alert"
							data-testid="sheet-rebuild-error"
							className="mx-auto w-full max-w-[860px] text-sm text-destructive print:hidden"
						>
							Rebuild failed: {build.error}
						</p>
					)}
					{planChanged && !running && (
						<p
							data-testid="sheet-stale"
							className="mx-auto w-full max-w-[860px] rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground print:hidden"
						>
							Your plan changed after this sheet was built. Rebuild it so the page matches
							your plan.
						</p>
					)}
					<CheatSheetArticle sheet={sheet} title={test.title} />
				</>
			) : (
				<div className="mx-auto w-full max-w-2xl rounded-xl border bg-card p-6 print:hidden">
					<h1 className="font-title text-2xl">Make a cheat sheet</h1>
					<p className="mt-2 max-w-[58ch] text-sm leading-relaxed text-muted-foreground">
						Your confirmed plan becomes one dense sheet: each section&apos;s core idea, the handful of
						facts worth memorising, formulas, and the trap that section sets. Built from the materials
						already read for this test.
					</p>

					{running ? (
						<div className="mt-4 rounded-lg border border-[var(--sheet-rule)] bg-[var(--sheet-wash)] p-3">
							<p className="text-sm text-[var(--sheet-ink)]">Building your sheet…</p>
							<p className="mt-1 text-sm text-[var(--sheet-ink-soft)]">
								Reading your plan and materials. This usually takes a minute or two; this page updates
								by itself.
							</p>
						</div>
					) : (
						<Button
							className="mt-4"
							size="sm"
							data-testid="build-cheat-sheet"
							disabled={starting}
							onClick={() => void buildSheet()}
						>
							{starting ? "Starting…" : "Build cheat sheet"}
						</Button>
					)}

					{build?.status === "error" && build.error && (
						<p role="alert" className="mt-3 text-sm text-destructive">
							{build.error}
						</p>
					)}

					<p className="mt-4 text-xs text-muted-foreground">
						The sheet uses the strong model from Settings → Models, and material that has been read for
						this test.
					</p>
				</div>
			)}
		</div>
	);
}

/** The routed cheat sheet page body. */
export function CheatSheetPage({ test }: { test: TestRecord }) {
	const router = useRouter();
	return (
		<div className="relative flex h-dvh flex-col">
			<header className="flex h-15 shrink-0 items-center gap-2 border-b border-border px-3 print:hidden">
				<SidebarToggle />
				<Link
					href="/tests"
					className="text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
				>
					Tests
				</Link>
				<span className="min-w-0 truncate text-sm text-muted-foreground">{test.title}</span>
			</header>
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-[920px] px-6 py-8 print:p-0">
					<CheatSheetView test={test} navigate={(target) => router.push(target)} />
				</div>
			</main>
		</div>
	);
}