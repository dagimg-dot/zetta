import type { TableKind } from "./api";

export function formatMs(ms: number): string {
	return `${ms < 10 ? ms.toFixed(1) : Math.round(ms).toLocaleString()} ms`;
}

export function plural(n: number, word: string): string {
	return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * A result's row count. An inexact one is one row past the limit, so the limit is what it is
 * known to exceed: 5,001 reads as "5,000+".
 */
export function rowTotal(rowCount: number, exact: boolean): string {
	return exact ? rowCount.toLocaleString() : `${(rowCount - 1).toLocaleString()}+`;
}

const nouns: Record<TableKind, string> = {
	table: "table",
	view: "view",
	materialized_view: "materialized view",
	foreign_table: "foreign table",
};

/** What to call the relation in a sentence, so a view is not called a table. */
export function kindNoun(kind: TableKind): string {
	return nouns[kind];
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
