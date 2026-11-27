/**
 * The sweep cache, read side (cheat sheet, issue #15).
 *
 * A sweep caches each file's transcript under `data/tests/<id>/sweep/`,
 * named by content hash and prefixed with one metadata line:
 *
 *   <!-- sweep-cache: {"rel":"notes.pdf","pages":12,"visionPages":2,"unreadable":[]} -->
 *   <!-- source: notes.pdf p. 1 -->
 *   …
 *
 * The cheat sheet writer only needs the marked segments, so this module
 * keeps the header pattern and the marker split pure and in one place.
 */

/** The sweep orchestrator writes this header; accept CRLF too. */
export const SWEEP_CACHE_META = /^<!-- sweep-cache: (\{.*\}) -->\r?\n/;

const MARKER = /^<!--\s*source:\s*(.+?)\s*-->$/;

export interface MaterialSegment {
	/** The `<!-- source: … -->` label; "" for text before the first marker. */
	source: string;
	text: string;
}

/** Split cached transcripts into marked segments, dropping empty ones. A
 *  document without markers is one unnamed segment. */
export function splitMaterialMarkers(material: readonly string[]): MaterialSegment[] {
	const segments: MaterialSegment[] = [];
	for (const document of material) {
		let source = "";
		let lines: string[] = [];
		const flush = (): void => {
			const text = lines.join("\n").trim();
			if (text !== "") segments.push({ source, text });
			lines = [];
		};
		for (const line of document.split("\n")) {
			const match = MARKER.exec(line.trim());
			if (match) {
				flush();
				source = match[1]!.trim();
			} else {
				lines.push(line);
			}
		}
		flush();
	}
	return segments;
}