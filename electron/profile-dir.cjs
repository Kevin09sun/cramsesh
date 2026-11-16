"use strict";

/**
 * Desktop profile folder (Cramsesh rebrand, 2026-11-16).
 *
 * The app's name — and so Electron's default userData folder — became
 * "Cramsesh" in 1.0.0 (it was "LearnHarness"). Existing installs must keep
 * their sessions, auth and settings: when the new folder does not exist but
 * the old one does, keep using the old one. Nothing is moved or copied.
 *
 * The old names live ONLY in this file; tests/brand-copy.test.ts allowlists
 * them here and nowhere else.
 */
const path = require("node:path");

const PRODUCT_NAME = "Cramsesh";
const LEGACY_NAME = "LearnHarness";

/**
 * @param {string} appDataDir  Electron's appData directory.
 * @param {(candidate: string) => boolean} exists  Folder existence probe.
 * @param {boolean} dev  Dev shell (LH_DEV_URL) gets its own "-dev" profile.
 * @returns {string} the userData directory to use.
 */
function resolveUserDataDir(appDataDir, exists, dev) {
	const preferred = path.join(appDataDir, dev ? `${PRODUCT_NAME}-dev` : PRODUCT_NAME);
	const legacy = path.join(appDataDir, dev ? `${LEGACY_NAME}-dev` : LEGACY_NAME);
	if (!exists(preferred) && exists(legacy)) return legacy;
	return preferred;
}

module.exports = { resolveUserDataDir };