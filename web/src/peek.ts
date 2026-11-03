import type { BrowseParams } from "./api";
import { encodeBuilder } from "./query";

/** The row a foreign key value points to: its table, the key column there, and the value. */
export interface PeekTarget {
	schema: string;
	table: string;
	column: string;
	value: string;
}

/**
 * Fetches the referenced row through the ordinary browse endpoint. Two rows, not one, so a key
 * that is not unique, which SQLite allows, shows as such instead of passing for the only match.
 */
export function peekParams(t: PeekTarget): BrowseParams {
	return {
		schema: t.schema,
		table: t.table,
		q: encodeBuilder({ match: "all", filters: [{ c: t.column, op: "eq", v: t.value }], sorts: [] }),
		limit: 2,
	};
}

/** Past this many characters a value in the peek is cut, as the grid cuts its tooltips. */
const CLIP_AT = 400;

export function clip(v: string): string {
	return v.length > CLIP_AT ? `${v.slice(0, CLIP_AT)}…` : v;
}
