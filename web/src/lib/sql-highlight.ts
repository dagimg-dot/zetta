import type { Adapter } from "./api";
import {
	postgresColumnName,
	postgresReserved,
	postgresTypeFunctionName,
	postgresUnreserved,
	sqliteFallback,
	sqliteReserved,
} from "./sql-keywords";
import { lex, type Token } from "./sql-lex";

/**
 * Unreserved keywords that begin a statement or a clause and are seldom anyone's column name.
 * The rest, such as name, type, data, key and value, stay plain, since they mostly are names.
 */
const clauseWords = new Set(
	`abort action add after alter always analyze asc attach before begin by call cascade cast
	checkpoint close cluster commit conflict copy cross current_date current_time current_timestamp
	database deallocate declare deferred delete desc detach discard do drop each exclusive execute
	explain extension fetch first following for full function generated glob if ignore immediate
	index indexed inherits initially inner insert instead last left like listen load lock
	materialized matched merge move natural no nothing notify nulls of ordinality outer over
	partition pragma preceding prepare privileges procedure raise recursive refresh regexp reindex
	release rename replace reset restrict return returns revoke right rollback row rows savepoint
	schema sequence set show stdin stdout stored temp temporary transaction trigger truncate
	unbounded unlisten update vacuum view virtual window within without`.split(/\s+/),
);

/** Words that are keywords wherever they stand, and words that are only where a clause starts. */
const keywords: Record<Adapter, { always: Set<string>; clause: Set<string> }> = {
	postgres: {
		always: new Set([...postgresReserved, ...postgresColumnName, ...postgresTypeFunctionName]),
		clause: new Set([...postgresUnreserved].filter((w) => clauseWords.has(w))),
	},
	sqlite: {
		always: sqliteReserved,
		clause: new Set([...sqliteFallback].filter((w) => clauseWords.has(w))),
	},
};

/** The class each token kind is drawn with; words are decided by `wordClass`. */
const kindClass: Partial<Record<Token["kind"], string>> = {
	comment: "tk-c",
	string: "tk-s",
	name: "tk-q",
	number: "tk-n",
	param: "tk-p",
};

/** The text of the nearest token on `step`'s side of `i` that is not space or a comment. */
function neighbour(text: string, tokens: readonly Token[], i: number, step: 1 | -1): string {
	for (let j = i + step; j >= 0 && j < tokens.length; j += step) {
		const t = tokens[j];
		if (t && t.kind !== "space" && t.kind !== "comment") return text.slice(t.start, t.end);
	}
	return "";
}

/**
 * A word is a keyword when the database reserves it, or when it is a clause word that is not
 * called like a function. Next to a dot it is part of a qualified name either way.
 */
function wordClass(text: string, tokens: readonly Token[], i: number, dialect: Adapter): string {
	const t = tokens[i];
	if (!t) return "";
	const word = text.slice(t.start, t.end).toLowerCase();
	const { always, clause } = keywords[dialect];
	if (!always.has(word) && !clause.has(word)) return "";
	const before = neighbour(text, tokens, i, -1);
	const after = neighbour(text, tokens, i, 1);
	if (before === "." || after === ".") return "";
	if (!always.has(word) && after === "(") return "";
	return "tk-k";
}

/** Text made safe to place in HTML. */
export function escapeHtml(s: string): string {
	return /[&<>]/.test(s) ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : s;
}

export interface Marks {
	/** A [start, end) range drawn as an error. */
	error?: readonly [number, number] | null;
}

/**
 * `text` as HTML, one string per line, with each token that has a colour in a tk-* span. A token
 * that spans lines is cut at each newline, so every line stands alone. Ends with an empty line
 * when `text` ends in a newline, as a textarea does.
 */
export function highlightLines(text: string, dialect: Adapter, marks: Marks = {}): string[] {
	const tokens = lex(text, dialect);
	const lines: string[] = [];
	let line = "";
	const [errA, errB] = marks.error ?? [-1, -1];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) continue;
		let cls = t.kind === "word" ? wordClass(text, tokens, i, dialect) : (kindClass[t.kind] ?? "");
		if (t.kind !== "space" && t.start < errB && t.end > errA)
			cls = cls ? `${cls} tk-err` : "tk-err";
		const piece = text.slice(t.start, t.end);
		if (piece.indexOf("\n") < 0) {
			line += cls ? `<span class="${cls}">${escapeHtml(piece)}</span>` : escapeHtml(piece);
			continue;
		}
		const parts = piece.split("\n");
		for (let p = 0; p < parts.length; p++) {
			if (p > 0) {
				lines.push(line);
				line = "";
			}
			const part = parts[p] ?? "";
			if (!part) continue;
			line += cls ? `<span class="${cls}">${escapeHtml(part)}</span>` : escapeHtml(part);
		}
	}
	lines.push(line);
	return lines;
}

/** `text` as one block of highlighted HTML. */
export function highlightHtml(text: string, dialect: Adapter): string {
	return highlightLines(text, dialect).join("\n");
}
