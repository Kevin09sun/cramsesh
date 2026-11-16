/**
 * Cramsesh README (Task 6): the repo front page leads with the product,
 * carries the verbatim tagline and the plan-mandated credit, points desktop
 * downloads at the owner's releases, states the licence, keeps upstream-only
 * links out, and references only brand assets that actually exist.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");

describe("Cramsesh README", () => {
	it("uses the product name, tagline, credit, downloads and licence", () => {
		for (const text of [
			"AP prep made EZ",
			"Built on LearnHarness by Amos Blomqvist",
			"https://github.com/amosblomqvist/learnharness",
			"https://github.com/Kevin09sun/cramsesh/releases",
			"AGPL-3.0",
		]) {
			assert.ok(readme.includes(text), `README contains ${JSON.stringify(text)}`);
		}
	});

	it("links no upstream-only site, Discord invite or retired banner", () => {
		for (const forbidden of ["learnharness.ai", "discord.gg", "lh_banner"]) {
			assert.ok(!readme.includes(forbidden), `README does not contain ${JSON.stringify(forbidden)}`);
		}
	});

	it("references the new banners and screenshots, and every asset path exists", () => {
		for (const asset of [
			"docs/assets/cramsesh_banner_light.png",
			"docs/assets/cramsesh_banner_dark.png",
			"docs/assets/teaching-session.png",
			"docs/assets/knowledge-graph.png",
		]) {
			assert.ok(readme.includes(asset), `README references ${asset}`);
		}
		const referenced = new Set(readme.match(/docs\/assets\/[A-Za-z0-9._-]+/g) ?? []);
		assert.ok(referenced.size > 0, "README references at least one docs/assets file");
		for (const asset of referenced) {
			assert.ok(existsSync(join(root, asset)), `${asset} exists`);
		}
	});
});
