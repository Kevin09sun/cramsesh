/**
 * The sweep's server wiring (test material sweep, 2026-11-20): the
 * settings-resolved reader/extractor/merger engines and the re-sweep launch
 * seam used by the browser route.
 *
 * `resolveEngine` + `retentionForSlot` are the app's one role→engine
 * resolution (BYOK: role override → slot → nothing), shared with the chat
 * composition root so the sweep runs exactly the models a job would.
 *
 * Key-presence gate (provider-key interlude, 2026-09-25), mirrored from the
 * sweep job runner: a missing extractor or merger key drops that engine (the
 * orchestrator records the honest "models not configured" error); a missing
 * reader key drops only the reader (pages still transcribe, carrying
 * "(vision failed)").
 */

import type { ModelRole } from "../../config.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runSweep, type SweepDeps } from "../agent/subagents/sweep/run-sweep.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { ROLE_SLOT, type ModelSlotName } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

/** Test seam (runner.ts's override style): a test scripts the re-sweep
 *  launch without touching a folder or a model. Undefined in production. */
export const resweepOverride: { current?: typeof runSweep } = {};

/** The settings-resolved engine for one role — the chain (role override →
 *  slot → NOTHING) may end empty, and undefined flows through to the
 *  orchestrator's refusal gates; read FRESH so a settings PUT lands. */
export function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec, true, undefined, retentionForSlot(ROLE_SLOT[role])) : undefined;
}

/** Slot policy is independent of model overrides. Read fresh per operation. */
export function retentionForSlot(slot: ModelSlotName) {
	return () => stores.settingsStore.readSettings()?.models?.[slot]?.cacheRetention;
}

/** The reader, extractor and merger a sweep runs on. An engine whose
 *  provider key is gone is not an engine: the key-presence gate the job
 *  runner applies, applied here. A construction failure (a configured model
 *  missing from the catalog throws synchronously in piEngineForSpec) also
 *  drops that engine, so the orchestrator records its own honest
 *  "models not configured" error instead of the launch 500ing with no
 *  sweep record. `resolve` is the test seam. */
export function sweepEngines(
	resolve: (role: ModelRole) => PiEngine | undefined = resolveEngine,
): SweepDeps["engines"] {
	const pick = (role: ModelRole): PiEngine | undefined => {
		try {
			return resolve(role);
		} catch {
			return undefined;
		}
	};
	const reader = pick("sweepReader");
	const extractor = pick("sweepExtractor");
	const merger = pick("sweepMerger");
	return {
		...(reader && providerKeyPresent(reader.model.provider) ? { reader } : {}),
		...(extractor && providerKeyPresent(extractor.model.provider) ? { extractor } : {}),
		...(merger && providerKeyPresent(merger.model.provider) ? { merger } : {}),
	};
}

/** Launch a re-sweep in the background against the real test store. The
 *  route answers 202 immediately; the orchestrator owns the record's fate
 *  (a missing engine or failed stage lands on the sweep record). */
export function startResweep(testId: string): void {
	void (resweepOverride.current ?? runSweep)(testId, "resweep", {
		store: stores.testStore,
		engines: sweepEngines(),
	}).catch((error) => console.error(`[sweep ${testId}] re-sweep failed:`, error));
}