/**
 * The cheat sheet build's server wiring (issue #15): the settings-resolved
 * strong engine, the background launch behind the browser route, and the
 * stale-build close that keeps a dead process from leaving "Building…" on
 * the page forever.
 *
 * Coordination is the record's own `cheatSheetBuild`, not a process-local
 * set: the POST that launches and the GET that polls can live in different
 * module instances under Next dev, but both read the same JSON record. A
 * build that started more than STALE_BUILD_MS ago has no live owner (the
 * model call is bounded), so it is closed as an error the page can retry.
 */

import { runCheatSheet } from "../agent/subagents/cheat-sheet/run-cheat-sheet.ts";
import type { TestRecord } from "../core/test-prep.ts";
import { stores } from "./stores.ts";
import { sweepEngines } from "./sweep-engines.ts";

/** Test seam (the resweepOverride style). Undefined in production. */
export const cheatSheetOverride: { current?: typeof runCheatSheet } = {};

/** A build this old cannot still be inside one bounded model call. */
export const STALE_BUILD_MS = 15 * 60_000;

export const STALE_BUILD_ERROR = "The build stopped before it finished. Try again.";

export const NO_MODEL_ERROR =
	"A cheat sheet needs a strong model. Pick one under Settings → Models, then build it again.";

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const flat = message.replace(/\s+/g, " ").trim();
	return (flat === "" ? "The cheat sheet could not be built." : flat).slice(0, 300);
}

/** Close a build whose process died. Returns the record unchanged when the
 *  build is still plausible. */
export function recoverInterruptedCheatSheet(record: TestRecord): TestRecord {
	const build = record.cheatSheetBuild;
	if (!build || build.status !== "running") return record;
	const started = Date.parse(build.startedAt);
	if (!Number.isNaN(started) && Date.now() - started < STALE_BUILD_MS) return record;
	return stores.testStore.updateCheatSheetBuild(record.id, {
		status: "error",
		error: STALE_BUILD_ERROR,
	});
}

/** The strong engine for the sheet. sweepEngines already applies the
 *  key-presence gate, so a missing merger is an honest "no model" refusal.
 *  Resolved fresh so a settings change lands on the next build. */
function sheetEngine() {
	return sweepEngines().merger;
}

/**
 * Launch a build in the background against the real test store. The route
 * answers 202 immediately; the run owns the record's build state from here.
 * Re-entrancy is the route's 409 gate plus this overwrite-free guard: a
 * running build is never replaced by a second launch.
 */
export function startCheatSheetBuild(testId: string): void {
	const record = stores.testStore.get(testId);
	if (!record) return;
	if (record.cheatSheetBuild?.status === "running") return;

	// The test seam runs without settings or keys, exactly like a stubbed
	// re-sweep; a real launch refuses before writing "running" without a model.
	const runner = cheatSheetOverride.current;
	const engine = runner ? undefined : sheetEngine();
	if (!runner && !engine) {
		stores.testStore.updateCheatSheetBuild(testId, { status: "error", error: NO_MODEL_ERROR });
		return;
	}

	stores.testStore.updateCheatSheetBuild(testId, { status: "running", startedAt: new Date().toISOString() });
	void (runner ?? runCheatSheet)(testId, { store: stores.testStore, engine }).catch((error) => {
		try {
			stores.testStore.updateCheatSheetBuild(testId, { status: "error", error: errorText(error) });
		} catch {
			// The record disappeared mid-build: nothing to report to.
		}
	});
}