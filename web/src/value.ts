import { categoryOf } from "./query";

/** What a cell holds, for inline markers in the grid and the inspector. */
export type ValueKind = "null" | "blob" | "json" | "multiline" | "text";

/** Numbers are right-aligned. Types like interval or int4range only start like numbers. */
export function isNumericType(type: string): boolean {
	return categoryOf(type) === "number";
}

/**
 * Postgres bytea and SQLite blobs both arrive as `\x` followed by hex. A declared type decides
 * when there is one, so text that happens to look like that stays text; an untyped column, such
 * as a SQLite expression, goes by the value alone.
 */
export function isBlob(v: string, type = ""): boolean {
	if (type && !/blob|bytea|binary/i.test(type)) return false;
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

export function kindOf(v: string | null, type = ""): ValueKind {
	if (v === null) return "null";
	if (isBlob(v, type)) return "blob";
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
		/no such column: "?([\w.]+)/.exec(message) ?? /column "([^"]+)" does not exist/.exec(message);
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

/** True when a statement in `sql` creates, drops, alters or renames something. */
export function changesSchema(sql: string): boolean {
	return statements(sql).some((s) => /^\s*(create|drop|alter)\b/i.test(s));
}

/**
 * The statements in `sql`, without comments, with each string literal and quoted name emptied, so
 * a keyword or semicolon inside one does not count. Handles '', "" and Postgres $tag$ quoting.
 */
export function statements(sql: string): string[] {
	const out: string[] = [];
	let cur = "";
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i] ?? "";
		const rest = sql.slice(i);
		if (rest.startsWith("--")) {
			const end = sql.indexOf("\n", i);
			i = end < 0 ? sql.length : end;
		} else if (rest.startsWith("/*")) {
			const end = sql.indexOf("*/", i + 2);
			i = end < 0 ? sql.length : end + 2;
			cur += " ";
		} else if (ch === "'" || ch === '"') {
			let j = i + 1;
			while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
			i = j + 1;
			cur += `${ch}${ch}`;
		} else if (ch === "$" && /^\$[A-Za-z_]*\$/.test(rest)) {
			const tag = /^\$[A-Za-z_]*\$/.exec(rest)?.[0] ?? "$$";
			const end = sql.indexOf(tag, i + tag.length);
			i = end < 0 ? sql.length : end + tag.length;
			cur += "''";
		} else if (ch === ";") {
			out.push(cur);
			cur = "";
			i++;
		} else {
			cur += ch;
			i++;
		}
	}
	out.push(cur);
	return out.filter((s) => s.trim());
}

const writeVerbs =
	/^\s*(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|vacuum|reindex|attach|detach|merge|copy)\b/i;

/** True when any statement in `sql` changes data or schema. */
export function isWrite(sql: string): boolean {
	return statements(sql).some(
		(s) =>
			writeVerbs.test(s) ||
			// A pragma that assigns changes the database; one that reads does not.
			/^\s*pragma\b[^=]*=/i.test(s) ||
			// A CTE can end in a write.
			(/^\s*with\b/i.test(s) && /\b(insert|update|delete|merge)\b/i.test(s)),
	);
}
