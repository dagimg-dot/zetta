import type { TableInfo, TableKind } from "./api";

const viewKinds: ReadonlySet<TableKind> = new Set(["view", "materialized_view"]);

export interface Relations {
	tables: TableInfo[];
	views: TableInfo[];
}

/** Separates a schema's views from what is used as a table, foreign tables included. */
export function splitViews(relations: readonly TableInfo[]): Relations {
	const out: Relations = { tables: [], views: [] };
	for (const r of relations) (viewKinds.has(r.kind) ? out.views : out.tables).push(r);
	return out;
}

/** Views start folded, unless the schema has nothing else to show or one of them is open. */
export function viewsStartOpen(relations: Relations, open: string | null): boolean {
	return relations.tables.length === 0 || relations.views.some((v) => v.name === open);
}
