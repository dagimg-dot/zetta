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

export interface SchemaInfo {
	name: string;
	tables: TableInfo[];
}

export interface Catalog {
	schemas: SchemaInfo[];
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
	rowCount: number;
	truncated: boolean;
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

export function getColumns(schema: string, table: string): Promise<Columns> {
	return request<Columns>(`/api/columns?${query({ schema, table })}`);
}

export function browse(p: BrowseParams): Promise<ResultSet> {
	return request<ResultSet>(`/api/browse?${query({ ...p })}`);
}

export interface RowCount {
	count: number;
	elapsedMs: number;
}

/** Exact row count for a table and filter. Fails with `timeout` past the server's budget. */
export function countRows(p: {
	schema: string;
	table: string;
	q?: string;
	filter?: string;
}): Promise<RowCount> {
	return request<RowCount>(`/api/count?${query({ ...p })}`);
}

export interface CompiledBuilder {
	where: string;
	order: string;
}

/** The SQL the server would run for a builder, with values written out, for display and editing. */
export function compileBuilder(q: string): Promise<CompiledBuilder> {
	return request<CompiledBuilder>(`/api/compile?${query({ q })}`);
}

export function runQuery(sql: string): Promise<ResultSet> {
	return request<ResultSet>("/api/query", {
		method: "POST",
		headers: { "content-type": "text/plain" },
		body: sql,
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

export function getTable(schema: string, table: string): Promise<TableDetail> {
	return request<TableDetail>(`/api/table?${query({ schema, table })}`);
}
