// Regenerate build/icon.icns from the Cramsesh master mark
// (build/brand/cramsesh-mark.svg) as PNG-backed ICNS entries.
//
//   node scripts/make-icns.mjs
//
// macOS packaging uses build/icon.icon (the Icon Composer document) for the
// Liquid Glass asset; scripts/after-pack.cjs swaps THIS icns in as the
// fallback so pre-Tahoe installs get the full-resolution mark instead of
// actool's 256px cap. Mac builds are disabled for 1.0.0, but the icon file
// is kept regenerated so the job can return by uncommenting it.
//
// Entry types (ICNS spec): 128/256/512/1024 px primary sizes and the
// 16/32/128/256 px @2x legacy sizes as PNG.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(path.join(root, "build", "brand", "cramsesh-mark.svg"), "utf8");

const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render(size, size).asPng();

const ENTRIES = [
	["ic07", 128],
	["ic08", 256],
	["ic09", 512],
	["ic10", 1024],
	["ic11", 32],
	["ic12", 64],
	["ic13", 256],
	["ic14", 512],
];

const chunks = ENTRIES.map(([type, size]) => {
	const png = render(size);
	const header = Buffer.alloc(8);
	header.write(type, 0, 4, "ascii");
	header.writeUInt32BE(8 + png.length, 4);
	return Buffer.concat([header, png]);
});
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(8 + body.length, 4);
const icns = Buffer.concat([header, body]);

const out = path.join(root, "build", "icon.icns");
writeFileSync(out, icns);
console.log(`build/icon.icns  ${ENTRIES.map(([, size]) => size).join("/")} — ${(icns.length / 1024).toFixed(1)} KB`);
