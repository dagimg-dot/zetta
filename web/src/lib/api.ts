export type Adapter = "postgres" | "sqlite";

export interface Meta {
	name: string;
	version: string;
	adapter: Adapter;
	database: string;
	readOnly: boolean;
	capabilities: { schemas: boolean; approxRows: boolean };
}

export type TableKind = "table" | "view" | "materialized_view" | "foreign_table";

export interface TableInfo {
	name: string;
	kind: TableKind;
	approxRows: number | null;
}

export type FunctionKind = "function" | "procedure" | "aggregate" | "window";

export interface FunctionInfo {
	name: string;
	kind: FunctionKind;
	/** The arguments that tell overloads apart, as text. Empty for none. */
	arguments: string;
	/** Null for a procedure. */
	returns: string | null;
}

export interface SchemaInfo {
	name: string;
	tables: TableInfo[];
	functions: FunctionInfo[];
}

export interface Catalog {
	schemas: SchemaInfo[];
}

/** What an expression can call by bare name, overloads adjacent. */
export interface Functions {
	functions: FunctionInfo[];
}

export interface Column {
	name: string;
	type: string;
	nullable: boolean;
	primaryKey: boolean;
	default: string | null;
}

export interface Columns {
	columns: Column[];
}

export interface ResultColumn {
	name: string;
	type: string;
}

export interface ResultSet {
	columns: ResultColumn[];
	rows: (string | null)[][];
	/** A lower bound when `rowCountExact` is false: reading stopped one row past the limit. */
	rowCount: number;
	rowCountExact: boolean;
	truncated: boolean;
	/** What stopped `rows` short of `rowCount`, when `truncated` is set. */
	truncatedBy: "rows" | "bytes";
	command: string;
	elapsedMs: number;
}

export type ErrorCode =
	| "unauthorized"
	| "not_found"
	| "bad_request"
	| "db_error"
	| "read_only"
	| "connect_failed"
	| "too_large"
	| "timeout"
	| "internal";

export class ApiError extends Error {
	constructor(
		readonly code: ErrorCode | "network",
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export interface BrowseParams {
	schema: string;
	table: string;
	/** The builder as JSON (see query.ts); the server compiles it. Never sent with filter or order. */
	q?: string;
	filter?: string;
	order?: string;
	limit?: number;
	offset?: number;
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

export function onUnauthorized(fn: Listener): () => void {
	unauthorizedListeners.add(fn);
	return () => unauthorizedListeners.delete(fn);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, { credentials: "same-origin", ...init });
	} catch (e) {
		throw new ApiError("network", e instanceof Error ? e.message : String(e), 0);
	}
	const body: unknown = await res.json().catch(() => null);
	if (res.ok) return body as T;
	const err = body as { error?: string; message?: string } | null;
	const failure = new ApiError(
		(err?.error as ErrorCode | undefined) ?? "internal",
		err?.message || err?.error || `${res.status} ${res.statusText}`,
		res.status,
	);
	if (res.status === 401) for (const fn of unauthorizedListeners) fn();
	throw failure;
}

function query(params: Record<string, string | number | undefined>): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== "") q.set(k, String(v));
	}
	return q.toString();
}

export function getMeta(): Promise<Meta> {
	return request<Meta>("/api/meta");
}

export function getCatalog(): Promise<Catalog> {
	return request<Catalog>("/api/catalog");
}

export function getFunctions(): Promise<Functions> {
	return request<Functions>("/api/functions");
}

export function getColumns(schema: string, table: string): Promise<Columns> {
	return request<Columns>(`/api/columns?${query({ schema, table })}`);
}

export function browse(p: BrowseParams, signal?: AbortSignal): Promise<ResultSet> {
	return request<ResultSet>(`/api/browse?${query({ ...p })}`, { signal });
}

export interface RowCount {
	count: number;
	elapsedMs: number;
}

/** Exact row count for a table and filter. Fails with `timeout` past the server's budget. */
export function countRows(
	p: {
		schema: string;
		table: string;
		q?: string;
		filter?: string;
	},
	signal?: AbortSignal,
): Promise<RowCount> {
	return request<RowCount>(`/api/count?${query({ ...p })}`, { signal });
}

export interface CompiledBuilder {
	where: string;
	order: string;
}

/** The SQL the server would run for a builder, with values written out, for display and editing. */
export function compileBuilder(q: string, signal?: AbortSignal): Promise<CompiledBuilder> {
	return request<CompiledBuilder>(`/api/compile?${query({ q })}`, { signal });
}

/** Runs caller SQL. With `exact` every row is read to count it, however long that takes. */
export function runQuery(sql: string, exact: boolean, signal?: AbortSignal): Promise<ResultSet> {
	return request<ResultSet>(exact ? "/api/query?count=exact" : "/api/query", {
		method: "POST",
		headers: { "content-type": "text/plain" },
		body: sql,
		signal,
	});
}

export type ConstraintKind = "primary_key" | "unique" | "check" | "foreign_key" | "exclusion";
export type RefAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

export interface DetailColumn extends Column {
	comment: string | null;
}

export interface Constraint {
	name: string;
	kind: ConstraintKind;
	columns: string[];
	definition: string;
}

export interface IndexInfo {
	name: string;
	columns: string[];
	unique: boolean;
	primary: boolean;
	method: string;
	predicate: string | null;
	definition: string | null;
	sizeBytes: number | null;
	scans: number | null;
}

export interface ForeignKey {
	name: string | null;
	columns: string[];
	refSchema: string;
	refTable: string;
	refColumns: string[];
	onUpdate: RefAction;
	onDelete: RefAction;
}

export interface Reference {
	name: string | null;
	schema: string;
	table: string;
	columns: string[];
	refColumns: string[];
	onUpdate: RefAction;
	onDelete: RefAction;
}

export interface Trigger {
	name: string;
	timing: "BEFORE" | "AFTER" | "INSTEAD OF";
	events: string[];
	level: "ROW" | "STATEMENT";
	function: string | null;
	definition: string;
	enabled: boolean;
}

export interface TableDetail {
	schema: string;
	name: string;
	kind: TableKind;
	approxRows: number | null;
	sizeBytes: { total: number; table: number; indexes: number } | null;
	comment: string | null;
	columns: DetailColumn[];
	constraints: Constraint[];
	indexes: IndexInfo[];
	foreignKeys: ForeignKey[];
	referencedBy: Reference[];
	triggers: Trigger[];
	ddl: string;
}

export interface FunctionDetail extends FunctionInfo {
	schema: string;
	/** The full argument list, with modes and defaults. */
	signature: string;
	language: string;
	volatility: "immutable" | "stable" | "volatile";
	strict: boolean;
	securityDefiner: boolean;
	owner: string;
	comment: string | null;
	/** Null for an aggregate, which no single statement creates. */
	definition: string | null;
	/** A statement that calls it, or null when only the database can, as with a trigger function. */
	call: string | null;
}

export function getFunction(
	schema: string,
	name: string,
	args: string,
	signal?: AbortSignal,
): Promise<FunctionDetail> {
	return request<FunctionDetail>(`/api/function?${query({ schema, name, args })}`, { signal });
}

export function getTable(
	schema: string,
	table: string,
	signal?: AbortSignal,
): Promise<TableDetail> {
	return request<TableDetail>(`/api/table?${query({ schema, table })}`, { signal });
}
