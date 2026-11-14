/** The file name at the end of a local path — never the full path itself. */
export function photoName(path: string): string {
	const pieces = path.split(/[\\/]/);
	return pieces[pieces.length - 1] || path;
}
