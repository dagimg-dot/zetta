import { createSignal } from "solid-js";

export type Tab = "data" | "sql";

export interface View {
	schema: string | null;
	table: string | null;
	tab: Tab;
	filter: string;
	order: string;
	offset: number;
}

function parse(search: string): View {
	const p = new URLSearchParams(search);
	const offset = Number.parseInt(p.get("offset") ?? "", 10);
	return {
		schema: p.get("schema"),
		table: p.get("table"),
		tab: p.get("tab") === "sql" ? "sql" : "data",
		filter: p.get("filter") ?? "",
		order: p.get("order") ?? "",
		offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
	};
}

function serialize(v: View): string {
	const p = new URLSearchParams();
	if (v.schema !== null) p.set("schema", v.schema);
	if (v.table !== null) p.set("table", v.table);
	if (v.tab !== "data") p.set("tab", v.tab);
	if (v.filter) p.set("filter", v.filter);
	if (v.order) p.set("order", v.order);
	if (v.offset) p.set("offset", String(v.offset));
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

export function openTable(schema: string, table: string): void {
	const cur = view();
	if (cur.schema === schema && cur.table === table && cur.tab === "data") return;
	const same = cur.schema === schema && cur.table === table;
	setView(
		same ? { tab: "data" } : { schema, table, tab: "data", filter: "", order: "", offset: 0 },
		same ? "replace" : "push",
	);
}
