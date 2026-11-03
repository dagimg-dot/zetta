import { formatBytes, plural } from "./format";
import { categoryOf } from "./query";

/** What a cell holds, for inline markers in the grid and the inspector. */
export type ValueKind = "null" | "empty" | "blank" | "blob" | "json" | "multiline" | "text";

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
	if (v === "") return "empty";
	if (v.trim() === "") return "blank";
	if (isBlob(v, type)) return "blob";
	if (parseJson(v) !== undefined) return "json";
	if (v.includes("\n")) return "multiline";
	return "text";
}

const isSpace = (ch: string | undefined) => ch !== undefined && ch !== "\n" && /\s/.test(ch);

/**
 * Splits off the spaces and tabs a value starts and ends with, which a cell would otherwise hide.
 * Line breaks are not included: they already draw as ↵.
 */
export function edges(v: string): { lead: string; body: string; trail: string } {
	let a = 0;
	while (isSpace(v[a])) a++;
	let b = v.length;
	while (b > a && isSpace(v[b - 1])) b--;
	return { lead: v.slice(0, a), body: v.slice(a, b), trail: v.slice(b) };
}

/**
 * The muted mark a value draws as instead of its text: NULL, empty and whitespace-only text, and
 * blobs. Null for a value whose text is shown. Blobs, empty text and text of only spaces would
 * otherwise look alike, or like nothing.
 */
export function markOf(v: string | null, type = ""): string | null {
	if (v === null) return "NULL";
	if (v === "") return "empty";
	if (v.trim() === "") return `blank · ${plural([...v].length, "char")}`;
	if (isBlob(v, type)) return `blob · ${formatBytes(blobBytes(v))}`;
	return null;
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
