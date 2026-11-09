import { createSignal } from "solid-js";
import { type Catalog, type Column, type FunctionInfo, getColumns, getFunctions } from "../lib/api";
import type { CatalogView } from "../lib/sql-complete";
import { dialect } from "./dialect";

/** The tables of the connected database, as the sidebar shows them. */
const [catalog, setCatalogSignal] = createSignal<Catalog | undefined>();
/** Moves on whenever columns arrive, so whatever read them can read again. */
const [columnsVersion, setColumnsVersion] = createSignal(0);
const columns = new Map<string, readonly Column[]>();
const loading = new Set<string>();
let functions: readonly FunctionInfo[] = [];
let functionsAsked = false;

const key = (schema: string, table: string) => `${schema}\u0000${table}`;

/** A new catalog, after connecting or after DDL, also forgets every table's columns. */
export function setCatalog(next: Catalog | undefined): void {
	setCatalogSignal(next);
	columns.clear();
	loading.clear();
	functions = [];
	functionsAsked = false;
	setColumnsVersion((v) => v + 1);
}

/** Fetches a table's columns once. A failed fetch counts as none, so it is not retried on every key. */
export function loadColumns(schema: string, table: string): void {
	const k = key(schema, table);
	if (columns.has(k) || loading.has(k)) return;
	loading.add(k);
	const settle = (cols: readonly Column[]) => {
		if (!loading.delete(k)) return;
		columns.set(k, cols);
		setColumnsVersion((v) => v + 1);
	};
	getColumns(schema, table).then(
		(r) => settle(r.columns),
		() => settle([]),
	);
}

/** Fetches what expressions can call, once per catalog. A failed fetch counts as none. */
export function loadFunctions(): void {
	if (functionsAsked) return;
	functionsAsked = true;
	getFunctions().then(
		(r) => {
			functions = r.functions;
			setColumnsVersion((v) => v + 1);
		},
		() => {},
	);
}

/** The catalog as completion reads it. Tracks both the tables and the columns loaded so far. */
export function catalogView(): CatalogView {
	columnsVersion();
	return {
		schemas: catalog()?.schemas ?? [],
		defaultSchema: dialect() === "postgres" ? "public" : "main",
		columns: (schema, table) => columns.get(key(schema, table)),
		functions: () => functions,
	};
}
