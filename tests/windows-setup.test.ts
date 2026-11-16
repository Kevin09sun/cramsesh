/** Windows setup maps the repo URL to the private learning-data repo. After
 *  the repo rename the origin ends in /cramsesh (or still /learnharness on an
 *  unrenamed checkout); both must clone learnharness-data.git. Reads the real
 *  script and executes its -replace with the JS RegExp engine. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const setup = readFileSync(
	fileURLToPath(new URL("../scripts/windows/setup.ps1", import.meta.url)),
	"utf8",
);

function dataRepoUrl(repoUrl: string): string {
	const line = setup.split(/\r?\n/).find((candidate) => candidate.includes("-replace"));
	assert.ok(line, "setup.ps1 maps the repo URL with -replace");
	const parts = line!.match(/-replace\s+'([^']+)'\s*,\s*'([^']+)'/);
	assert.ok(parts, "setup.ps1 has a quoted -replace pattern and replacement");
	return repoUrl.replace(new RegExp(parts![1]!), parts![2]!);
}

describe("Windows setup data repo", () => {
	it("maps both the renamed and the old repo URL to learnharness-data.git", () => {
		const expected = "https://github.com/Kevin09sun/learnharness-data.git";
		for (const url of [
			"https://github.com/Kevin09sun/cramsesh.git",
			"https://github.com/Kevin09sun/cramsesh",
			"https://github.com/Kevin09sun/learnharness.git",
			"https://github.com/Kevin09sun/learnharness",
		]) {
			assert.equal(dataRepoUrl(url), expected, url);
		}
	});
});