import { createSignal } from "solid-js";

export type Tab = "data" | "sql";
export type Pane = "rows" | "structure" | "indexes" | "relationships" | "triggers" | "ddl";

const panes: readonly Pane[] = ["rows", "structure", "indexes", "relationships", "triggers", "ddl"];

/** Page sizes the rows view offers; anything else in the URL falls back to the default. */
export const pageSizes = [50, 100, 250, 500, 1000] as const;
export const defaultPageSize = 100;

export interface View {
	schema: string | null;
	table: string | null;
	tab: Tab;
	pane: Pane;
	/** The filter and sort builder, as JSON (see query.ts). Wins over filter/order. */
	q: string;
	/** Raw SQL, used when the builder is not. */
	filter: string;
	order: string;
	offset: number;
	limit: number;
	/** Columns hidden in the rows view, by name, one `hide` parameter each. */
	hide: string[];
}

export function parse(search: string): View {
	const p = new URLSearchParams(search);
	const offset = Number.parseInt(p.get("offset") ?? "", 10);
	const limit = Number.parseInt(p.get("limit") ?? "", 10);
	return {
		schema: p.get("schema"),
		table: p.get("table"),
		tab: p.get("tab") === "sql" ? "sql" : "data",
		pane: panes.find((x) => x === p.get("view")) ?? "rows",
		q: p.get("q") ?? "",
		filter: p.get("filter") ?? "",
		order: p.get("order") ?? "",
		offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
		limit: pageSizes.find((n) => n === limit) ?? defaultPageSize,
		hide: [...new Set(p.getAll("hide").filter(Boolean))],
	};
}

export function serialize(v: View): string {
	const p = new URLSearchParams();
	if (v.schema !== null) p.set("schema", v.schema);
	if (v.table !== null) p.set("table", v.table);
	if (v.tab !== "data") p.set("tab", v.tab);
	if (v.pane !== "rows") p.set("view", v.pane);
	if (v.q) p.set("q", v.q);
	if (v.filter) p.set("filter", v.filter);
	if (v.order) p.set("order", v.order);
	if (v.offset) p.set("offset", String(v.offset));
	if (v.limit !== defaultPageSize) p.set("limit", String(v.limit));
	for (const name of v.hide) p.append("hide", name);
	const s = p.toString();
	return s ? `?${s}` : location.pathname;
}

const [view, setViewSignal] = createSignal<View>(parse(location.search));

addEventListener("popstate", () => setViewSignal(parse(location.search)));

/** Drops `?token=` and other unknown params once the cookie is set, so the token leaves the address bar and history. */
history.replaceState(null, "", serialize(view()));

export { view };

export function setView(patch: Partial<View>, mode: "push" | "replace" = "replace"): void {
	const next = { ...view(), ...patch };
	const url = serialize(next);
	if (mode === "push") history.pushState(null, "", url);
	else history.replaceState(null, "", url);
	setViewSignal(next);
}

/** Opens a table, keeping the current pane so you can compare, say, indexes across tables. */
export function openTable(schema: string, table: string): void {
	const cur = view();
	if (cur.schema === schema && cur.table === table && cur.tab === "data") return;
	const same = cur.schema === schema && cur.table === table;
	setView(
		same
			? { tab: "data" }
			: { schema, table, tab: "data", q: "", filter: "", order: "", offset: 0, hide: [] },
		same ? "replace" : "push",
	);
}

/** Opens a table's rows already filtered, for following a foreign key either way. */
export function openRowsWhere(
	schema: string,
	table: string,
	column: string,
	value: string | null,
): void {
	const q = JSON.stringify({
		match: "all",
		filters: [{ c: column, op: value === null ? "is_null" : "eq", v: value ?? "" }],
		sorts: [],
	});
	setView(
		{ schema, table, tab: "data", pane: "rows", q, filter: "", order: "", offset: 0, hide: [] },
		"push",
	);
}
