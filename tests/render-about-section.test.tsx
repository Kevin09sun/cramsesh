/**
 * About section (Task 5): the product mark/name/version, the tagline, and
 * the upstream credit, licence and source links. The second test pins the
 * Settings-dialog wiring — About is the last section and its content is
 * reachable by clicking the nav.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AboutSection } from "../components/settings/about-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });

const HOMEPAGE = "https://github.com/Kevin09sun/cramsesh";
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

async function click(element: HTMLElement | null) {
	assert.ok(element, "missing click target");
	await act(async () => { element.click(); });
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); }); host.remove();
	}
	globalThis.fetch = originalFetch;
});

describe("AboutSection", () => {
	const html = renderToStaticMarkup(<AboutSection version="1.0.0" homepage={HOMEPAGE} />);

	it("names the product, its version and the verbatim tagline", () => {
		assert.ok(html.includes("Cramsesh"), "product name");
		assert.ok(html.includes("Version 1.0.0"), "version");
		assert.ok(html.includes("AP prep made EZ"), "tagline");
	});

	it("credits LearnHarness and links the licence and source", () => {
		assert.ok(html.includes("Built on LearnHarness by Amos Blomqvist"), "credit");
		const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(hrefs, [
			"https://github.com/amosblomqvist/learnharness",
			`${HOMEPAGE}/blob/main/LICENSE`,
			HOMEPAGE,
		]);
		const anchors = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
		assert.equal(anchors.length, 3, "credit, licence and source links");
		for (const tag of anchors) {
			assert.ok(tag.includes('target="_blank"'), `opens in a new tab: ${tag}`);
			assert.ok(/rel="[^"]*noreferrer/.test(tag), `no referrer leak: ${tag}`);
		}
	});
});

describe("Settings dialog", () => {
	it("lists About last and opens the About section", async () => {
		globalThis.fetch = async () => Response.json({ settings: { version: 1 } });
		const host = await mount(<SettingsDialogBody initialSection="general" onClose={() => {}} />);
		const nav = q(host, "settings-nav")!;
		const buttons = [...nav.querySelectorAll("button")];
		assert.equal(buttons.at(-1)?.textContent, "About", "About is the last nav entry");
		assert.equal(q(host, "section-about"), null, "General is the landing section");
		await click(q(host, "settings-nav-about"));
		assert.ok(q(host, "section-about"), "clicking About shows it");
		assert.ok(q(host, "section-about")!.textContent!.includes("AP prep made EZ"));
	});
});