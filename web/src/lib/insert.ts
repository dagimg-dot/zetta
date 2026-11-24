import type { Adapter, Column } from "./api";
import { quoteIdent } from "./query";

/** What a column gets in a new row: the text typed for it, NULL, or the column's default. */
export type FieldMode = "value" | "null" | "default";

export interface Field {
	mode: FieldMode;
	value: string;
}

/**
 * The mode a column starts in: its default when it has one, NULL when it may be empty, and a value
 * otherwise, so an untouched form asks only for what the table cannot fill in itself. A lone
 * integer key with no default is an identity column or SQLite's rowid, which number themselves.
 */
export function initialMode(
	c: Pick<Column, "type" | "default" | "nullable" | "primaryKey">,
	soleKey: boolean,
): FieldMode {
	if (c.default !== null) return "default";
	if (soleKey && c.primaryKey && /int/i.test(c.type)) return "default";
	if (c.nullable && !c.primaryKey) return "null";
	return "value";
}

/**
 * Text as a string literal the database coerces to the column's type. Postgres reads backslashes
 * literally only while `standard_conforming_strings` is on, so text with one uses the escape form,
 * which reads them the same way whatever that setting is.
 */
export function quoteLiteral(text: string, dialect: Adapter): string {
	const quoted = text.replaceAll("'", "''");
	if (dialect === "postgres" && text.includes("\\")) return `E'${quoted.replaceAll("\\", "\\\\")}'`;
	return `'${quoted}'`;
}

/**
 * One INSERT for a row. Columns left to their default are not named, and a row with none named
 * takes DEFAULT VALUES. With `returning` the database sends the row back as stored.
 */
export function insertSql(
	target: { schema: string; table: string },
	columns: readonly { name: string; field: Field }[],
	dialect: Adapter,
	returning = false,
): string {
	const named = columns.filter((c) => c.field.mode !== "default");
	const into = `insert into ${quoteIdent(target.schema)}.${quoteIdent(target.table)}`;
	const tail = returning ? "\nreturning *" : "";
	if (!named.length) return `${into} default values${tail}`;
	const names = named.map((c) => quoteIdent(c.name)).join(", ");
	const values = named
		.map((c) => (c.field.mode === "null" ? "null" : quoteLiteral(c.field.value, dialect)))
		.join(", ");
	return `${into} (${names})\nvalues (${values})${tail}`;
}
