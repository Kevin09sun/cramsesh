// Generate the README banners from the one master mark and the Nunito
// variable font (build/fonts/Nunito[wght].ttf, SIL OFL — see OFL.txt).
//
//   docs/assets/cramsesh_banner_light.{svg,png}  ink wordmark + bright-blue "sesh"
//   docs/assets/cramsesh_banner_dark.{svg,png}   cream wordmark + sunflower "sesh"
//
// 1876×944 (the old banner size, GitHub social-preview friendly), transparent
// background so the PNG sits on either README theme. Build-time only; rerun
// after a mark or banner-copy change: `node scripts/make-banners.mjs`.
//
// resvg's fontdb loads the variable TTF at its default instance, so the
// heavier wordmark is stroked in the same colour (paint-order="stroke") —
// the owner-approved look without shipping a second static face.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const master = readFileSync(path.join(root, "build", "brand", "cramsesh-mark.svg"), "utf8");
const fontFile = path.join(root, "build", "fonts", "Nunito[wght].ttf");

const WIDTH = 1876;
const HEIGHT = 944;
const MARK_SIZE = 336;
const MARK_X = 330;
const MARK_Y = (HEIGHT - MARK_SIZE) / 2;
const TEXT_X = 730;
const WORDMARK_BASELINE = 500;
const TAGLINE_BASELINE = 640;

/** The master's drawing, without its outer <svg> wrapper. */
const markInner = master
	.replace(/^[\s\S]*?<svg\b[^>]*>/, "")
	.replace(/<\/svg>\s*$/, "")
	.trim();

const BANNERS = {
	light: {
		cram: "#1F3A5F",
		sesh: "#3D6FB6",
		tagline: "#1F3A5F",
	},
	dark: {
		cram: "#FBF6EA",
		sesh: "#F2B33D",
		tagline: "#FBF6EA",
	},
};

function bannerSvg({ cram, sesh, tagline }) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <g transform="translate(${MARK_X} ${MARK_Y}) scale(${MARK_SIZE / 1024})">
    ${markInner}
  </g>
  <text x="${TEXT_X}" y="${WORDMARK_BASELINE}" font-family="Nunito" font-size="200" letter-spacing="-3"
        fill="${cram}" stroke="${cram}" stroke-width="14" paint-order="stroke" stroke-linejoin="round">cram<tspan fill="${sesh}" stroke="${sesh}">sesh</tspan></text>
  <text x="${TEXT_X + 8}" y="${TAGLINE_BASELINE}" font-family="Nunito" font-size="62" letter-spacing="1"
        fill="${tagline}" stroke="${tagline}" stroke-width="2" paint-order="stroke" stroke-linejoin="round">AP prep made EZ</text>
</svg>
`;
}

for (const [mode, colours] of Object.entries(BANNERS)) {
	const svg = bannerSvg(colours);
	const base = path.join(root, "docs", "assets", `cramsesh_banner_${mode}`);
	writeFileSync(`${base}.svg`, svg);
	const png = new Resvg(svg, {
		font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: "Nunito" },
	}).render().asPng();
	writeFileSync(`${base}.png`, png);
	console.log(`${path.relative(root, `${base}.png`)}  ${WIDTH}×${HEIGHT} — ${(png.length / 1024).toFixed(1)} KB`);
}