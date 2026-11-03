import type { Adapter, Catalog } from "./api";
import { quoteIdent } from "./query";

/**
 * Words either database reserves, so a table named like one has to be quoted. Quoting a word that
 * did not need it is harmless, so the list errs on the long side.
 */
const reserved = new Set(
	`add all alter analyse analyze and any array as asc asymmetric authorization autoincrement
	between binary both case cast check collate collation column commit concurrently constraint create
	cross current_catalog current_date current_role current_schema current_time current_timestamp
	current_user default deferrable delete desc distinct do drop else end escape except exists false
	fetch for foreign freeze from full grant group having if ilike in index initially inner insert
	intersect into is isnull join lateral leading left like limit localtime localtimestamp natural
	not notnull null offset on only or order outer overlaps placing primary references returning
	right select session_user set similar some symmetric system_user table tablesample then to
	trailing transaction true union unique update user using values variadic verbose when where
	window with`.split(/\s+/),
);

/** A name as it can be written in SQL: bare when it is a plain lowercase word, quoted otherwise. */
export function sqlName(name: string): string {
	return /^[a-z_][a-z0-9_]*$/.test(name) && !reserved.has(name) ? name : quoteIdent(name);
}

/** The schema an unqualified name finds without a search path. */
const homeSchema: Record<Adapter, string> = { postgres: "public", sqlite: "main" };

/**
 * A first query for an empty editor, on a table that exists: the one open in the Data tab, or the
 * first table in the default schema, or the first one anywhere. Null when there are no tables.
 */
export function starterSql(
	catalog: Catalog | undefined,
	adapter: Adapter | undefined,
	open: { schema: string | null; table: string | null },
): string | null {
	if (!catalog || !adapter) return null;
	const home = homeSchema[adapter];
	const all = catalog.schemas.flatMap((s) => s.tables.map((t) => ({ schema: s.name, ...t })));
	const pick =
		all.find((t) => t.schema === open.schema && t.name === open.table) ??
		all.find((t) => t.schema === home && t.kind === "table") ??
		all.find((t) => t.kind === "table") ??
		all[0];
	if (!pick) return null;
	const name =
		pick.schema === home ? sqlName(pick.name) : `${sqlName(pick.schema)}.${sqlName(pick.name)}`;
	return `select * from ${name} limit 10`;
}
