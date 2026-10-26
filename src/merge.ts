import { diff3Merge } from "node-diff3";

// Extensions we try to merge line-by-line. Anything else (images, PDFs, ...)
// gets "keep both" as two separate files instead.
const TEXT_EXTENSIONS = new Set([
	"md", "txt", "canvas", "base", "json", "csv", "tsv", "css", "js", "ts",
	"yaml", "yml", "html", "xml", "svg", "tex", "bib", "org", "py", "sh",
]);

export function isTextPath(path: string): boolean {
	const name = path.split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return name === ".gitignore";
	return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Decode as UTF-8, or return null if the bytes are not valid text. */
export function decodeText(data: Uint8Array): string | null {
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
		return text.includes("\0") ? null : text;
	} catch {
		return null;
	}
}

/**
 * Three-way line merge, like `git merge` does for a single file.
 * Edits to different parts of the file combine cleanly. Where both sides
 * changed the same lines, both versions are kept between git-style markers
 * so nothing is lost and the spot is easy to search for.
 */
export function merge3(
	ours: string,
	base: string,
	theirs: string,
	oursLabel: string,
	theirsLabel: string,
): { text: string; conflict: boolean } {
	const regions = diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"), {
		excludeFalseConflicts: true,
	});
	const out: string[] = [];
	let conflict = false;
	for (const region of regions) {
		if (region.ok) {
			out.push(...region.ok);
		} else if (region.conflict) {
			conflict = true;
			out.push(`<<<<<<< ${oursLabel}`, ...region.conflict.a, "=======", ...region.conflict.b, `>>>>>>> ${theirsLabel}`);
		}
	}
	return { text: out.join("\n"), conflict };
}
