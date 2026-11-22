/**
 * SHARED SWEEP FOLDER VALIDATION (test folder picker, 2026-11-21): the folder
 * validation `sweep_materials` runs, extracted so the test-folder route can
 * reuse it. The keys are the tool's historical error strings — the picker must
 * refuse exactly what the tool refuses, word for word.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { resolvePolicy } from "../src/agent/tools/file-access.ts";
import { resolveSourcePath } from "../src/agent/tools/fs-shared.ts";
import { resolveSweepFolder } from "../src/agent/tools/sweep-folder.ts";

const REQUIRED = "folder is required — pass the folder the learner attached";
const HOME_OR_ROOT = "that is your whole home folder / drive — pass the folder with the test materials";

describe("resolveSweepFolder", () => {
	it("resolves a readable directory", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sweep-folder-"));
		try {
			const result = await resolveSweepFolder(dir);
			assert.deepEqual(result, { ok: true, folder: resolveSourcePath(dir, resolvePolicy()) });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses an empty or whitespace folder — it would resolve to home", async () => {
		for (const input of ["", "   "]) {
			const result = await resolveSweepFolder(input);
			assert.equal(result.ok, false, `"${input}" must be refused`);
			if (!result.ok) assert.equal(result.error, REQUIRED);
		}
	});

	it("refuses the home folder", async () => {
		const result = await resolveSweepFolder(os.homedir());
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, HOME_OR_ROOT);
	});

	it("refuses a drive / filesystem root", async () => {
		const root = path.parse(os.tmpdir()).root;
		const result = await resolveSweepFolder(root);
		assert.equal(result.ok, false, `${root} must be refused`);
		if (!result.ok) assert.equal(result.error, HOME_OR_ROOT);
	});

	it("refuses a missing folder", async () => {
		const missing = path.join(os.tmpdir(), `lh-sweep-folder-missing-${process.pid}-${Date.now()}`);
		const result = await resolveSweepFolder(missing);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /^folder not found or not a readable directory: /);
	});

	it("refuses a file path that is not a directory", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sweep-folder-file-"));
		const file = path.join(dir, "notes.txt");
		fs.writeFileSync(file, "not a folder");
		try {
			const result = await resolveSweepFolder(file);
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, /^folder not found or not a readable directory: /);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});