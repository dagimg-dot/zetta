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

export function runQuery(sql: string): Promise<ResultSet> {
	return request<ResultSet>("/api/query", {
		method: "POST",
		headers: { "content-type": "text/plain" },
		body: sql,
	});
}
