/**
 * Cramsesh brand copy (Task 3): no user-visible "LearnHarness" survives in
 * app, component, server or Electron source. Hidden protocol identifiers are
 * explicitly allowed (they are the keep-unchanged list from the plan); the
 * credit URL is allowed wherever it appears. The root metadata names the
 * product Cramsesh with the verbatim tagline.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["app", "components", "src", "electron"];
const EXTENSIONS = new Set([".ts", ".tsx", ".cjs", ".mjs"]);
const BRAND = /learn ?harness/i;

type Hit = { file: string; line: number; value: string };

function sourceFiles(directory: string, found: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) sourceFiles(full, found);
		else if (EXTENSIONS.has(extname(entry.name))) found.push(full);
	}
	return found;
}

/** Every string, template chunk and JSX text node that mentions the old brand.
 *  The TypeScript AST is used so comments are never scanned. */
function brandMentions(file: string, relativePath: string): Hit[] {
	const text = readFileSync(file, "utf8");
	const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	const hits: Hit[] = [];
	const collect = (node: ts.Node, value: string) => {
		if (!BRAND.test(value)) return;
		hits.push({ file: relativePath, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, value });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isStringLiteral(node)) collect(node, node.text);
		else if (ts.isNoSubstitutionTemplateLiteral(node)) collect(node, node.text);
		else if (ts.isTemplateExpression(node)) {
			collect(node.head, node.head.text);
			for (const span of node.templateSpans) collect(span.literal, span.literal.text);
		} else if (ts.isJsxText(node)) collect(node, node.text.trim());
		ts.forEachChild(node, visit);
	};
	visit(source);
	return hits;
}

/** The plan's keep-unchanged identifiers (and the credit URL) are not copy.
 *  Only the kept spelling is removed before the remainder is checked, so a
 *  caption that merely shares a literal with an identifier (the path picker's
 *  `LearnHarnessFileDialog`) is still flagged. */
function allowed(relativePath: string, value: string): boolean {
	if (value === "learnharness") return true; // MCP bridge name, ChatGPT namespace, opencode client
	if (value.startsWith("x-learnharness-")) return true; // x-learnharness-* headers
	if (value === "application/x-learnharness-source") return true; // source-tree drag type
	if (value === "__learnharness_custom_provider_binding") return true; // custom-provider auth binding
	if (value === "LearnHarness" && /^electron\/[^/]*profile-dir[^/]*$/.test(relativePath)) return true; // Task 4 profile fallback
	const rest = value
		.replaceAll("github.com/amosblomqvist/learnharness", "") // credit URL
		.replaceAll("LearnHarnessFileDialog", ""); // PowerShell dialog class name
	return !BRAND.test(rest);
}

describe("Cramsesh copy", () => {
	it("no user-visible LearnHarness survives outside the kept identifiers", () => {
		const leftovers: string[] = [];
		for (const directory of ROOTS) {
			for (const file of sourceFiles(join(root, directory))) {
				const relativePath = relative(root, file).split(sep).join("/");
				for (const hit of brandMentions(file, relativePath)) {
					if (allowed(relativePath, hit.value)) continue;
					leftovers.push(`${hit.file}:${hit.line}: ${JSON.stringify(hit.value)}`);
				}
			}
		}
		assert.deepEqual(leftovers, [], `user-visible LearnHarness copy:\n${leftovers.join("\n")}`);
	});

	it("root metadata names the product Cramsesh with the verbatim tagline", () => {
		const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
		const exported = layout.match(/export const metadata: Metadata = \{([\s\S]*?)\n\};/);
		assert.ok(exported, "app/layout.tsx exports a static metadata object");
		assert.ok(exported[1]!.includes('title: "Cramsesh"'), "metadata.title is Cramsesh");
		assert.ok(
			exported[1]!.includes('description: "AP prep made EZ — a study buddy that teaches, quizzes, and checks your thinking."'),
			"metadata.description is the verbatim tagline",
		);
	});
});