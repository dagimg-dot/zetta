/**
 * The filter and sort builder's model, and how it becomes SQL. Values are always
 * written as quoted literals and identifiers are always quoted, so nothing the
 * user types in a value box can change the shape of the query.
 */

export type Dialect = "postgres" | "sqlite";
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
		/^(smallint|integer|int|bigint|int2|int4|int8|numeric|decimal|real|double|float|money|oid|serial|bigserial)\b/.test(
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

export function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function likePattern(value: string, before: string, after: string): string {
	const escaped = value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
	return quoteLiteral(before + escaped + after);
}

/** One condition as SQL, or null while it is incomplete. */
export function compileFilter(f: Filter, dialect: Dialect): string | null {
	if (!f.c) return null;
	const col = quoteIdent(f.c);
	const info = ops[f.op];
	if (info.value && f.v === "") return null;
	const like = dialect === "postgres" ? "ILIKE" : "LIKE";
	// Text matching works on any column type once it is cast to text.
	const asText = dialect === "postgres" ? `${col}::text` : col;
	switch (f.op) {
		case "eq":
			return `${col} = ${quoteLiteral(f.v)}`;
		case "neq":
			return `${col} <> ${quoteLiteral(f.v)}`;
		case "gt":
			return `${col} > ${quoteLiteral(f.v)}`;
		case "gte":
			return `${col} >= ${quoteLiteral(f.v)}`;
		case "lt":
			return `${col} < ${quoteLiteral(f.v)}`;
		case "lte":
			return `${col} <= ${quoteLiteral(f.v)}`;
		case "contains":
			return `${asText} ${like} ${likePattern(f.v, "%", "%")} ESCAPE '\\'`;
		case "starts":
			return `${asText} ${like} ${likePattern(f.v, "", "%")} ESCAPE '\\'`;
		case "ends":
			return `${asText} ${like} ${likePattern(f.v, "%", "")} ESCAPE '\\'`;
		case "in": {
			const items = f.v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			return items.length ? `${col} IN (${items.map(quoteLiteral).join(", ")})` : null;
		}
		case "is_null":
			return `${col} IS NULL`;
		case "not_null":
			return `${col} IS NOT NULL`;
		case "is_true":
			return dialect === "postgres" ? `${col} IS TRUE` : `${col} = 1`;
		case "is_false":
			return dialect === "postgres" ? `${col} IS FALSE` : `${col} = 0`;
	}
}

export function compileWhere(b: Builder, dialect: Dialect): string {
	const parts = b.filters
		.map((f) => compileFilter(f, dialect))
		.filter((p): p is string => p !== null);
	if (parts.length <= 1) return parts[0] ?? "";
	return parts.map((p) => `(${p})`).join(b.match === "all" ? " AND " : " OR ");
}

export function compileOrder(b: Builder): string {
	return b.sorts
		.filter((s) => s.c)
		.map((s) => `${quoteIdent(s.c)} ${s.d}`)
		.join(", ");
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
