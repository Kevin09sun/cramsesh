/**
 * SHARED SWEEP FOLDER VALIDATION (test folder picker, 2026-11-21): resolve
 * and check the folder a materials sweep reads. `sweep_materials` and the
 * test-folder route run this one validation, so a folder the picker accepts is
 * exactly a folder the tool accepts. The error strings are the tool's
 * historical refusals, kept verbatim.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { comparisonPath, resolvePolicy } from "./file-access.ts";
import { resolveSourcePath } from "./fs-shared.ts";

/** Same path, case-insensitively on Windows (where drive casing varies). */
function samePath(a: string, b: string): boolean {
	const left = comparisonPath(a);
	const right = comparisonPath(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Resolve the learner's attached materials folder and refuse one a sweep
 *  must never read: empty (which would resolve to the home directory), the
 *  home folder or a drive/filesystem root, and anything that is not a
 *  directory we can list. A failure carries the refusal message the tool
 *  returns to the model. */
export async function resolveSweepFolder(
	input: string,
): Promise<{ ok: true; folder: string } | { ok: false; error: string }> {
	// Empty input would resolve to the home directory (ls's default) — a
	// first sweep must never read the learner's entire home.
	if (!input.trim()) {
		return { ok: false, error: "folder is required — pass the folder the learner attached" };
	}

	// Same resolution/denial as ls (resolveSourcePath), then the directory
	// must actually be readable.
	try {
		const folder = resolveSourcePath(input, resolvePolicy());
		// Home or a drive/filesystem root is the same mistake with a
		// non-empty string: refuse it with the same guidance.
		if (samePath(folder, os.homedir()) || samePath(folder, path.parse(folder).root)) {
			return { ok: false, error: "that is your whole home folder / drive — pass the folder with the test materials" };
		}
		const stat = await fs.stat(folder);
		if (!stat.isDirectory()) throw new Error("not a directory");
		await fs.readdir(folder);
		return { ok: true, folder };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `folder not found or not a readable directory: ${input} (${reason})` };
	}
}