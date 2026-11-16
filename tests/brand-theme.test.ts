/**
 * Cramsesh brand theme (Task 1): the warm palette in both modes, its
 * contrast floor, Nunito as the one UI/prose/title family, the retired
 * "session names in serif" switch, and old appearance records still
 * applying cleanly once that switch is ignored.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { appearanceVars, resolveAppearance } from "../components/settings/appearance.tsx";
import { AppearanceSection } from "../components/settings/appearance-section.tsx";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

/** The declarations of one CSS block, keyed by property name. */
function block(selector: string): Record<string, string> {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const start = css.search(new RegExp(`^${escaped} \\{`, "m"));
	assert.ok(start >= 0, `${selector} block exists`);
	const body = css.slice(start, css.indexOf("\n}", start));
	return Object.fromEntries([...body.matchAll(/^\s*(--[\w-]+|color-scheme):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!]));
}

/** WCAG relative-luminance contrast for #rrggbb. */
function lum(hex: string): number {
	const [r, g, b] = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

const TOKENS = [
	"--background",
	"--foreground",
	"--card",
	"--popover",
	"--primary",
	"--primary-foreground",
	"--secondary",
	"--muted",
	"--muted-foreground",
	"--accent",
	"--border",
	"--input",
	"--ring",
] as const;

describe("Cramsesh palette", () => {
	it("light and dark tokens use the Cramsesh palette", () => {
		const light = block(".light");
		const root = block(":root");
		const dark = block(".dark");

		assert.equal(light["--background"], "#fbf6ea", "light page is cream");
		assert.equal(light["--primary"], "#3d6fb6", "light primary is bright blue");
		for (const selector of [":root", ".dark"] as const) {
			const tokens = selector === ":root" ? root : dark;
			assert.equal(tokens["--background"], "#14213a", `${selector} page is ink blue`);
			assert.equal(tokens["--primary"], "#f2b33d", `${selector} primary is sunflower`);
		}
		for (const token of TOKENS) {
			assert.ok(token in light, `${token} declared in .light`);
			assert.ok(token in root, `${token} declared in :root`);
			assert.ok(token in dark, `${token} declared in .dark`);
		}

		// :root is the dark default and .dark mirrors it — one dark palette,
		// declared twice so the Tailwind variant and the page agree.
		for (const [token, value] of Object.entries(dark)) {
			assert.equal(root[token], value, `${token} is identical in :root and .dark`);
		}
	});

	it("token pairs meet contrast", () => {
		for (const [mode, tokens] of [
			["light", block(".light")],
			[":root", block(":root")],
		] as const) {
			assert.ok(contrast(tokens["--foreground"]!, tokens["--background"]!) >= 4.5, `${mode} body text on page`);
			assert.ok(contrast(tokens["--foreground"]!, tokens["--card"]!) >= 4.5, `${mode} body text on cards`);
			assert.ok(
				contrast(tokens["--muted-foreground"]!, tokens["--background"]!) >= 4.5,
				`${mode} muted text on page`,
			);
			assert.ok(
				contrast(tokens["--muted-foreground"]!, tokens["--card"]!) >= 4.5,
				`${mode} muted text on cards`,
			);
			assert.ok(
				contrast(tokens["--primary-foreground"]!, tokens["--primary"]!) >= 4.5,
				`${mode} primary button label`,
			);
			assert.ok(
				contrast(tokens["--accent-foreground"]!, tokens["--accent"]!) >= 4.5,
				`${mode} accent label`,
			);
			assert.ok(contrast(tokens["--ring"]!, tokens["--background"]!) >= 3, `${mode} focus ring`);
		}
	});
});

describe("Cramsesh type", () => {
	it("fonts are Nunito", () => {
		assert.match(layout, /import\s*\{[^}]*\bNunito\b[^}]*\}\s*from\s*["']next\/font\/google["']/);
		assert.doesNotMatch(layout, /JetBrains_Mono|Source_Sans_3/, "the old UI/prose faces are gone");
		assert.ok(layout.includes("--font-nunito"), "the next/font variable is wired");

		assert.ok(!css.includes("lh-cmu"), "the bundled CMU face is gone");
		assert.match(css, /--font-ui:\s*var\(--font-nunito\)/, "UI reads Nunito");
		assert.match(css, /--font-prose:\s*var\(--font-nunito\)/, "prose reads Nunito");
		assert.match(css, /--font-title:\s*var\(--font-nunito\)/, "titles read Nunito");
		assert.match(css, /--font-sans:\s*var\(--font-nunito\)/, "Tailwind's sans alias reads Nunito");

		const mono = css.match(/--font-mono:\s*([^;]+);/)?.[1] ?? "";
		assert.match(mono, /monospace/, "code stays monospace");
		assert.doesNotMatch(mono, /nunito/i, "code does not become Nunito");
	});
});

describe("retired session-name serif switch", () => {
	it("old appearance records still apply", () => {
		const vars = appearanceVars(
			resolveAppearance({ sessionNameSerif: true, background: "#222222", fontFamily: "Georgia" }),
		);
		assert.equal("--font-title" in vars, false, "the toggle no longer rewrites the title font");
		assert.equal(vars["--background"], "#222222", "the saved background still applies");
		assert.match(vars["--font-prose"]!, /^"Georgia"/, "the saved reading font still applies");
		assert.match(vars["--font-prose"]!, /var\(--font-nunito\)/, "its fallback is Nunito");
	});

	it("serif switch is gone", () => {
		const html = renderToStaticMarkup(
			React.createElement(AppearanceSection, { appearance: undefined, onSectionChange: () => {} }),
		);
		assert.ok(!html.includes('data-testid="row-session-serif"'), "no serif row");
		assert.ok(!html.includes("Session names in serif"), "no serif label");
	});
});