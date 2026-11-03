/**
 * The filter and sort builder's model, and how it becomes SQL. Values are always
 * written as quoted literals and identifiers are always quoted, so nothing the
 * user types in a value box can change the shape of the query.
 */

export type Category = "number" | "text" | "bool" | "time" | "json" | "other";

export type Op =
	| "eq"
	| "neq"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "contains"
	| "starts"
	| "ends"
	| "in"
	| "is_null"
	| "not_null"
	| "is_true"
	| "is_false";

export interface Filter {
	c: string;
	op: Op;
	v: string;
}

export interface SortKey {
	c: string;
	d: "asc" | "desc";
}

export interface Builder {
	match: "all" | "any";
	filters: Filter[];
	sorts: SortKey[];
}

export const emptyBuilder: Builder = { match: "all", filters: [], sorts: [] };

export function categoryOf(type: string): Category {
	const t = type.toLowerCase();
	if (/^(bool|boolean)\b/.test(t)) return "bool";
	if (/^(json|jsonb)\b/.test(t)) return "json";
	if (/^(date|time|timestamp|timestamptz|timetz|interval)\b/.test(t)) return "time";
	if (
		/^(smallint|integer|int|bigint|int2|int4|int8|numeric|decimal|real|double|float|float4|float8|money|oid|serial|bigserial)\b/.test(
			t,
		)
	)
		return "number";
	if (/^(text|varchar|character|char|name|citext|uuid|"char")\b/.test(t) || t === "") return "text";
	return "other";
}

export interface OpInfo {
	op: Op;
	label: string;
	/** Whether the operator takes a value. */
	value: boolean;
}

const ops: Record<Op, OpInfo> = {
	eq: { op: "eq", label: "=", value: true },
	neq: { op: "neq", label: "≠", value: true },
	gt: { op: "gt", label: ">", value: true },
	gte: { op: "gte", label: "≥", value: true },
	lt: { op: "lt", label: "<", value: true },
	lte: { op: "lte", label: "≤", value: true },
	contains: { op: "contains", label: "contains", value: true },
	starts: { op: "starts", label: "starts with", value: true },
	ends: { op: "ends", label: "ends with", value: true },
	in: { op: "in", label: "is one of", value: true },
	is_null: { op: "is_null", label: "is null", value: false },
	not_null: { op: "not_null", label: "is not null", value: false },
	is_true: { op: "is_true", label: "is true", value: false },
	is_false: { op: "is_false", label: "is false", value: false },
};

export function opInfo(op: Op): OpInfo {
	return ops[op];
}

/** The operators that make sense for a column type, the most useful first. */
export function opsFor(category: Category): OpInfo[] {
	const pick = (...list: Op[]) => list.map((o) => ops[o]);
	switch (category) {
		case "number":
		case "time":
			return pick("eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null", "not_null");
		case "bool":
			return pick("is_true", "is_false", "is_null", "not_null");
		case "text":
			return pick(
				"contains",
				"eq",
				"neq",
				"starts",
				"ends",
				"in",
				"gt",
				"lt",
				"is_null",
				"not_null",
			);
		case "json":
			return pick("contains", "eq", "is_null", "not_null");
		case "other":
			return pick("eq", "neq", "contains", "in", "is_null", "not_null");
	}
}

/**
 * Only for header clicks in raw SQL mode, where the ORDER BY is text the user owns. Double quotes
 * are standard SQL and mean the same in both adapters; the builder itself is compiled on the server.
 */
export function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/** The builder travels in the URL so a filtered view can be shared and restored. */
export function encodeBuilder(b: Builder): string {
	if (!b.filters.length && !b.sorts.length) return "";
	return JSON.stringify(b);
}

export function decodeBuilder(text: string | null): Builder | null {
	if (!text) return null;
	try {
		const raw = JSON.parse(text) as Partial<Builder>;
		const filters = Array.isArray(raw.filters) ? raw.filters : [];
		const sorts = Array.isArray(raw.sorts) ? raw.sorts : [];
		return {
			match: raw.match === "any" ? "any" : "all",
			filters: filters
				.filter(
					(f): f is Filter => typeof f?.c === "string" && typeof f.op === "string" && f.op in ops,
				)
				.map((f) => ({ c: f.c, op: f.op, v: typeof f.v === "string" ? f.v : "" })),
			sorts: sorts
				.filter((s): s is SortKey => typeof s?.c === "string")
				.map((s) => ({ c: s.c, d: s.d === "desc" ? "desc" : "asc" })),
		};
	} catch {
		return null;
	}
}

/**
 * The applied builder without one filter, found by its column, condition and value, since the draft
 * may have reordered or added rows. Null when that filter was never applied, so nothing reloads.
 */
export function dropFilter(applied: Builder | null, f: Filter): Builder | null {
	const i = applied?.filters.findIndex((x) => x.c === f.c && x.op === f.op && x.v === f.v) ?? -1;
	if (!applied || i < 0) return null;
	return { ...applied, filters: applied.filters.filter((_, k) => k !== i) };
}

/** The applied builder without the sort on one column, or null when it was never applied. */
export function dropSort(applied: Builder | null, column: string): Builder | null {
	if (!applied?.sorts.some((s) => s.c === column)) return null;
	return { ...applied, sorts: applied.sorts.filter((s) => s.c !== column) };
}

/** Header clicks: a plain click sorts by that column alone, shift-click adds or flips it. */
export function toggleSort(sorts: SortKey[], col: string, additive: boolean): SortKey[] {
	const at = sorts.findIndex((s) => s.c === col);
	const current = at >= 0 ? sorts[at] : undefined;
	const next: SortKey | null = !current
		? { c: col, d: "asc" }
		: current.d === "asc"
			? { c: col, d: "desc" }
			: null;
	if (!additive) return next ? [next] : [];
	const rest = sorts.filter((s) => s.c !== col);
	if (!next) return rest;
	if (at < 0) return [...sorts, next];
	return sorts.map((s) => (s.c === col ? next : s));
}
