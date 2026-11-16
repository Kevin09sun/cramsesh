/** Desktop profile folder fallback (Task 4): the Cramsesh rename must not
 *  orphan an existing install's sessions, auth or settings. Pure function —
 *  no Electron. path.join keeps the expectations portable to Windows. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { resolveUserDataDir } = require("../electron/profile-dir.cjs") as {
	resolveUserDataDir(appDataDir: string, exists: (candidate: string) => boolean, dev: boolean): string;
};

const AD = "/AD";
const among = (...names: string[]) => (candidate: string) =>
	names.some((name) => candidate === path.join(AD, name));

describe("desktop profile folder", () => {
	it("keeps using the old LearnHarness folder when only it exists", () => {
		assert.equal(resolveUserDataDir(AD, among("LearnHarness"), false), path.join(AD, "LearnHarness"));
	});

	it("uses Cramsesh when only the new folder exists", () => {
		assert.equal(resolveUserDataDir(AD, among("Cramsesh"), false), path.join(AD, "Cramsesh"));
	});

	it("prefers Cramsesh when both folders exist", () => {
		assert.equal(
			resolveUserDataDir(AD, among("LearnHarness", "Cramsesh"), false),
			path.join(AD, "Cramsesh"),
		);
	});

	it("defaults to Cramsesh when neither folder exists", () => {
		assert.equal(resolveUserDataDir(AD, among(), false), path.join(AD, "Cramsesh"));
	});

	it("dev keeps the old LearnHarness-dev profile when only it exists", () => {
		assert.equal(
			resolveUserDataDir(AD, among("LearnHarness-dev"), true),
			path.join(AD, "LearnHarness-dev"),
		);
	});

	it("dev defaults to Cramsesh-dev when neither folder exists", () => {
		assert.equal(resolveUserDataDir(AD, among(), true), path.join(AD, "Cramsesh-dev"));
	});
});