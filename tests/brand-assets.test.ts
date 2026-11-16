/**
 * Cramsesh brand assets (Task 2): ONE master mark — the late-night mug on
 * bright blue — feeds the browser tab icon, the in-app sidebar mark and the
 * desktop icon set. These pins prove the packaged icons were regenerated
 * from that master rather than left as the old LearnHarness artwork.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarHomeLink } from "../components/sidebar.tsx";

const read = (relative: string): Buffer => readFileSync(new URL(`../${relative}`, import.meta.url));
const master = read("build/brand/cramsesh-mark.svg").toString("utf8");

/** The ICO directory's sizes, with 0 decoded as 256. */
function icoSizes(ico: Buffer): number[] {
	const count = ico.readUInt16LE(4);
	return Array.from({ length: count }, (_, i) => {
		const byte = ico.readUInt8(6 + i * 16);
		return byte === 0 ? 256 : byte;
	});
}

describe("Cramsesh mark", () => {
	it("master mark uses the palette", () => {
		for (const colour of ["#3D6FB6", "#F2B33D", "#FBF6EA"]) {
			assert.ok(master.includes(colour), `master uses ${colour}`);
		}
		assert.ok(!master.includes("#949494"), "the old harness grey is gone");
		assert.ok(!master.includes("rgb(148,148,148)"), "the old harness grey is gone (rgb form)");
	});

	it("icons are regenerated from the master", () => {
		const png = read("build/icon.png");
		// PNG signature + IHDR: width/height are the first two big-endian u32s
		// after the 8-byte signature, the 4-byte length and "IHDR".
		assert.equal(png.toString("ascii", 12, 16), "IHDR", "icon.png is a PNG");
		assert.equal(png.readUInt32BE(16), 512, "icon.png is 512 wide");
		assert.equal(png.readUInt32BE(20), 512, "icon.png is 512 tall");

		assert.deepEqual(icoSizes(read("build/icon.ico")), [16, 24, 32, 48, 64, 128, 256], "icon.ico sizes");

		const icns = read("build/icon.icns");
		assert.equal(icns.toString("ascii", 0, 4), "icns", "icns magic");
		assert.ok(icns.indexOf("ic10") >= 0, "icns carries the 1024 entry");

		// The controller's ruling: icon.png must be byte-for-byte what the
		// master renders to with the same resvg options make-icons uses.
		const rendered = new Resvg(master, { fitTo: { mode: "width", value: 512 } }).render().asPng();
		assert.deepEqual(png, rendered, "build/icon.png is the master rendered at 512");
	});

	it("app icon exists", () => {
		assert.equal(read("app/icon.svg").toString("utf8"), master, "app/icon.svg is the master");
	});
});

describe("sidebar mark", () => {
	it("shows the Cramsesh mark on the Home link", () => {
		const html = renderToStaticMarkup(React.createElement(SidebarHomeLink));
		const home = html.match(/<a[^>]*aria-label="Home"[^>]*>([\s\S]*?)<\/a>/);
		assert.ok(home, "the Home link renders");
		assert.match(home![1]!, /<svg/, "the link carries the mark");
		assert.match(home![1]!, /#3D6FB6/, "the mark is on the bright-blue square");
	});
});
