import type { ResultSet } from "./api";

/** Past this many characters of cells a page is not worth holding on to for a return visit. */
const MAX_REMEMBERED_CHARS = 2_000_000;

/** Whether two results show the same thing; how long each took does not count. */
export function sameResult(a: ResultSet, b: ResultSet): boolean {
	if (a.rows.length !== b.rows.length || a.columns.length !== b.columns.length) return false;
	if (a.truncated !== b.truncated || a.rowCount !== b.rowCount) return false;
	for (let c = 0; c < a.columns.length; c++) {
		if (a.columns[c]?.name !== b.columns[c]?.name || a.columns[c]?.type !== b.columns[c]?.type)
			return false;
	}
	for (let r = 0; r < a.rows.length; r++) {
		const x = a.rows[r] ?? [];
		const y = b.rows[r] ?? [];
		if (x.length !== y.length) return false;
		for (let c = 0; c < x.length; c++) if (x[c] !== y[c]) return false;
	}
	return true;
}

export function smallResult(r: ResultSet): boolean {
	let chars = 0;
	for (const row of r.rows) {
		for (const cell of row) chars += cell?.length ?? 0;
		if (chars > MAX_REMEMBERED_CHARS) return false;
	}
	return true;
}
