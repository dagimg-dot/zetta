/** What a cell holds, for inline markers in the grid and the inspector. */
export type ValueKind = "null" | "blob" | "json" | "multiline" | "text";

const numericTypes = [
	"integer",
	"bigint",
	"smallint",
	"numeric",
	"real",
	"double precision",
	"int",
	"float",
	"decimal",
	"money",
	"oid",
];

export function isNumericType(type: string): boolean {
	const t = type.toLowerCase();
	return numericTypes.some((n) => t.startsWith(n));
}

/** Postgres bytea and SQLite blobs both arrive as `\x` followed by hex. */
export function isBlob(v: string): boolean {
	return v.length >= 2 && v[0] === "\\" && v[1] === "x" && /^\\x[0-9a-f]*$/i.test(v);
}

export function blobBytes(v: string): number {
	return (v.length - 2) / 2;
}

export function parseJson(v: string): unknown | undefined {
	const c = v.trimStart()[0];
	if (c !== "{" && c !== "[") return undefined;
	try {
		return JSON.parse(v);
	} catch {
		return undefined;
	}
}

export function kindOf(v: string | null): ValueKind {
	if (v === null) return "null";
	if (isBlob(v)) return "blob";
	if (parseJson(v) !== undefined) return "json";
	if (v.includes("\n")) return "multiline";
	return "text";
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** `ab12cd34` as `ab12 cd34 …`, sixteen bytes to a line. */
export function hexDump(v: string): string {
	const hex = v.slice(2);
	const lines: string[] = [];
	for (let i = 0; i < hex.length; i += 32) {
		const line = hex.slice(i, i + 32).match(/.{1,4}/g) ?? [];
		lines.push(`${(i / 2).toString(16).padStart(6, "0")}  ${line.join(" ")}`);
	}
	return lines.join("\n");
}

/** Edit distance, for "did you mean" on unknown column names. */
export function distance(a: string, b: string): number {
	const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0] ?? 0;
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const up = prev[j] ?? 0;
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + cost);
			diag = up;
		}
	}
	return prev[b.length] ?? 0;
}

export function closest(word: string, candidates: readonly string[]): string | null {
	let best: string | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	for (const c of candidates) {
		const d = distance(word.toLowerCase(), c.toLowerCase());
		if (d < bestD) {
			bestD = d;
			best = c;
		}
	}
	return best !== null && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

/** The column name in "no such column: x" (SQLite) or 'column "x" does not exist' (Postgres). */
export function unknownColumn(message: string): string | null {
	const m =
		/no such column: ([\w.]+)/.exec(message) ?? /column "([^"]+)" does not exist/.exec(message);
	const name = m?.[1];
	if (!name) return null;
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1) : name;
}

/**
 * Where in `sql` an error points: Postgres prints "LINE n:" and a caret, SQLite says `near "x"`.
 * Returns a [start, end) range or null.
 */
export function errorRange(sql: string, message: string): [number, number] | null {
	const pg = /LINE (\d+): (.*)\n(\s*)\^/.exec(message);
	if (pg) {
		const line = Number(pg[1]) - 1;
		const prefix = `LINE ${pg[1]}: `.length;
		const col = (pg[3]?.length ?? 0) - prefix;
		const lines = sql.split("\n");
		let at = 0;
		for (let i = 0; i < line && i < lines.length; i++) at += (lines[i]?.length ?? 0) + 1;
		at += Math.max(0, col);
		const word = /^\S+/.exec(sql.slice(at))?.[0] ?? "";
		return [at, at + Math.max(1, word.length)];
	}
	const lite = /near "([^"]+)"/.exec(message);
	if (lite?.[1]) {
		const at = sql.indexOf(lite[1]);
		if (at >= 0) return [at, at + lite[1].length];
	}
	return null;
}

const writeVerbs =
	/^\s*(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|vacuum|reindex)\b/i;

/** True when any statement in `sql` changes data or schema. Comments are ignored. */
export function isWrite(sql: string): boolean {
	const clean = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
	return clean.split(";").some((s) => writeVerbs.test(s));
}
