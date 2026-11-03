/**
 * Copying rows out of the grid. Each format is a row in `formats`, and that one table drives the
 * "Copy as" and "Save as" menus, Ctrl+C and the tests. Writers are pure: they take rows already cut
 * down to the selected rows and visible columns.
 */

import { type Category, categoryOf } from "../../lib/query";

export interface Rows {
	columns: { name: string; type: string }[];
	rows: (string | null)[][];
}

export type FormatId = "json" | "jsonl" | "csv" | "tsv" | "markdown";

export interface Format {
	id: FormatId;
	label: string;
	ext: string;
	mime: string;
	write: (t: Rows) => string;
}

/** Cuts a result down to the given rows and columns, in that order. */
export function pick(t: Rows, rows: readonly number[], cols: readonly number[]): Rows {
	return {
		columns: cols.flatMap((c) => t.columns[c] ?? []),
		rows: rows.flatMap((r) => {
			const row = t.rows[r];
			return row ? [cols.map((c) => row[c] ?? null)] : [];
		}),
	};
}

const jsonNumber = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** Drops whitespace outside strings, so embedded JSON stays on one line without being reparsed. */
function compact(json: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < json.length; i++) {
		const ch = json[i] as string;
		if (inString) {
			out += ch;
			if (ch === "\\") out += json[++i] ?? "";
			else if (ch === '"') inString = false;
		} else if (ch === '"') {
			out += ch;
			inString = true;
		} else if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") {
			out += ch;
		}
	}
	return out;
}

function isJson(v: string): boolean {
	try {
		JSON.parse(v);
		return true;
	} catch {
		return false;
	}
}

/**
 * One value as JSON text. Numbers are written as the database sent them, never through `Number`,
 * so a bigint or numeric past 2^53 keeps every digit. Anything that does not fit its column's
 * category, like NaN or a money string, falls back to a JSON string.
 */
export function jsonValue(v: string | null, category: Category): string {
	if (v === null) return "null";
	switch (category) {
		case "number":
			if (jsonNumber.test(v)) return v;
			break;
		case "bool":
			if (v === "t" || v === "true" || v === "1") return "true";
			if (v === "f" || v === "false" || v === "0") return "false";
			break;
		case "json":
			if (isJson(v)) return compact(v);
			break;
	}
	return JSON.stringify(v);
}

/**
 * Keys for each column; a repeated name, as from a join, gets a suffix so no value is lost. The
 * suffix skips names already taken, so a real column called `a_2` keeps its own value.
 */
function keys(t: Rows): string[] {
	const taken = new Set(t.columns.map((c) => c.name));
	const used = new Set<string>();
	return t.columns.map((c) => {
		let key = c.name;
		for (let n = 2; used.has(key); n++) {
			const next = `${c.name}_${n}`;
			if (!taken.has(next)) key = next;
		}
		used.add(key);
		return JSON.stringify(key);
	});
}

/** Each row as `[key, value]` pairs of JSON text. */
function objects(t: Rows): [string, string][][] {
	const k = keys(t);
	const cats = t.columns.map((c) => categoryOf(c.type));
	return t.rows.map((row) => row.map((v, i) => [k[i] ?? '""', jsonValue(v, cats[i] ?? "other")]));
}

function json(t: Rows): string {
	const object = (fields: [string, string][], pad: string) =>
		fields.length
			? `{\n${fields.map(([k, v]) => `${pad}  ${k}: ${v}`).join(",\n")}\n${pad}}`
			: "{}";
	const rows = objects(t);
	if (rows.length === 0) return "[]";
	if (rows.length === 1) return object(rows[0] ?? [], "");
	return `[\n${rows.map((f) => `  ${object(f, "  ")}`).join(",\n")}\n]`;
}

function jsonl(t: Rows): string {
	return objects(t)
		.map((fields) => `{${fields.map(([k, v]) => `${k}:${v}`).join(",")}}`)
		.join("\n");
}

function quoted(v: string, special: RegExp): string {
	return special.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/**
 * RFC 4180 with a header. NULL is an empty field and an empty string is `""`, the same split
 * Postgres `COPY ... CSV` makes, so the two survive a round trip.
 */
function csv(t: Rows): string {
	const field = (v: string | null) => (v === null ? "" : v === "" ? '""' : quoted(v, /[",\r\n]/));
	return [t.columns.map((c) => quoted(c.name, /[",\r\n]/)), ...t.rows.map((r) => r.map(field))]
		.map((r) => r.join(","))
		.join("\n");
}

/** What spreadsheets paste into cells: a tab or line break inside a value has to be quoted. */
function tsv(t: Rows): string {
	const field = (v: string | null) => (v === null ? "" : quoted(v, /[\t"\r\n]/));
	return [t.columns.map((c) => field(c.name)), ...t.rows.map((r) => r.map(field))]
		.map((r) => r.join("\t"))
		.join("\n");
}

function markdown(t: Rows): string {
	const cell = (v: string | null) =>
		v === null
			? "NULL"
			: v.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
	const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
	const rule = t.columns.map((c) => (categoryOf(c.type) === "number" ? "---:" : "---"));
	return [
		line(t.columns.map((c) => cell(c.name))),
		line(rule),
		...t.rows.map((r) => line(r.map(cell))),
	].join("\n");
}

export const formats: readonly Format[] = [
	{ id: "json", label: "JSON", ext: "json", mime: "application/json", write: json },
	{ id: "jsonl", label: "JSON lines", ext: "jsonl", mime: "application/x-ndjson", write: jsonl },
	{ id: "csv", label: "CSV", ext: "csv", mime: "text/csv", write: csv },
	{ id: "tsv", label: "TSV", ext: "tsv", mime: "text/tab-separated-values", write: tsv },
	{ id: "markdown", label: "Markdown table", ext: "md", mime: "text/markdown", write: markdown },
];

export function format(id: FormatId): Format {
	return formats.find((f) => f.id === id) as Format;
}

function escapeHtml(v: string): string {
	return v
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** The HTML half of a rich copy, so a paste into Sheets, Excel or Docs lands in cells. */
export function htmlTable(t: Rows): string {
	const cell = (tag: string, v: string | null) =>
		`<${tag}>${v === null ? "" : escapeHtml(v).replace(/\r?\n/g, "<br>")}</${tag}>`;
	const head = t.columns.map((c) => cell("th", c.name)).join("");
	const body = t.rows.map((r) => `<tr>${r.map((v) => cell("td", v)).join("")}</tr>`).join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** A file name from a grid label such as `public.users`. */
export function fileName(label: string, f: Format): string {
	const base = label.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "rows";
	return `${base}.${f.ext}`;
}
