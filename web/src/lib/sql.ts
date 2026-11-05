import type { Adapter } from "./api";
import { lex, type Token } from "./sql-lex";

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
export function changesSchema(sql: string, dialect: Adapter): boolean {
	return statements(sql, dialect).some((s) => /^\s*(create|drop|alter)\b/i.test(s));
}

interface Segment {
	/** Where it starts in `sql`, just after the previous semicolon. */
	start: number;
	/** Where its semicolon is, or the end of `sql`. */
	end: number;
	/** The text without comments, with each string literal and quoted name emptied. */
	clean: string;
}

/** What a token adds to a segment's clean text. */
function cleanText(sql: string, t: Token): string {
	switch (t.kind) {
		case "comment":
			return sql.startsWith("--", t.start) ? "" : " ";
		case "string":
			return "''";
		case "name":
			return '""';
		default:
			return sql.slice(t.start, t.end);
	}
}

/** Reads a statement's tokens in order and says which semicolon ends it. */
interface Splitter {
	/** True when `t`, whose text is `text`, is a semicolon that ends the statement. */
	ends(t: Token, text: string): boolean;
}

/**
 * psql's rule (psqlscan.l): a semicolon ends a statement outside parentheses, and outside the
 * BEGIN ... END body of a CREATE [OR REPLACE] FUNCTION or PROCEDURE, where CASE also opens a block.
 * Words inside parentheses count for neither.
 */
function psqlSplitter(): Splitter {
	let depth = 0;
	let body = 0;
	let lead: string[] = [];
	return {
		ends(t, text) {
			if (t.kind === "punct") {
				if (text === "(") depth++;
				else if (text === ")") depth = Math.max(0, depth - 1);
				else if (text === ";" && depth === 0 && body === 0) {
					lead = [];
					return true;
				}
			} else if (t.kind === "word" && depth === 0) {
				const word = text.toLowerCase();
				if (lead.length < 4) lead.push(word);
				if (isRoutine(lead)) {
					if (word === "begin") body++;
					else if (word === "case" && body > 0) body++;
					else if (word === "end" && body > 0) body--;
				}
			}
			return false;
		},
	};
}

/** CREATE [OR REPLACE] FUNCTION or PROCEDURE. */
function isRoutine(lead: string[]): boolean {
	const [a, b, c, d] = lead;
	const kind = b === "or" && c === "replace" ? d : b;
	return a === "create" && (kind === "function" || kind === "procedure");
}

/** complete.c's token classes, in the column order of `sqliteStates`. */
const Lite = {
	Semi: 0,
	Space: 1,
	Other: 2,
	Explain: 3,
	Create: 4,
	Temp: 5,
	Trigger: 6,
	End: 7,
} as const;

/**
 * sqlite3_complete's state machine (complete.c), by state then token class. States: 0 nothing,
 * 1 start, 2 normal, 3 explain, 4 create, 5 trigger, 6 semicolon in a trigger, 7 END after it. A
 * semicolon ends a statement when it moves to state 1, so inside CREATE [TEMP] TRIGGER only
 * `; END ;` does. Parentheses do not count.
 */
const sqliteStates = [
	[1, 0, 2, 3, 4, 2, 2, 2],
	[1, 1, 2, 3, 4, 2, 2, 2],
	[1, 2, 2, 2, 2, 2, 2, 2],
	[1, 3, 3, 2, 4, 2, 2, 2],
	[1, 4, 2, 2, 2, 4, 5, 2],
	[6, 5, 5, 5, 5, 5, 5, 5],
	[6, 6, 5, 5, 5, 5, 5, 7],
	[1, 7, 5, 5, 5, 5, 5, 5],
];

const sqliteWords: Record<string, number> = {
	explain: Lite.Explain,
	create: Lite.Create,
	temp: Lite.Temp,
	temporary: Lite.Temp,
	trigger: Lite.Trigger,
	end: Lite.End,
};

function sqliteSplitter(): Splitter {
	let state = 0;
	return {
		ends(t, text) {
			let kind: number = Lite.Other;
			if (t.kind === "space" || t.kind === "comment") kind = Lite.Space;
			else if (t.kind === "punct" && text === ";") kind = Lite.Semi;
			else if (t.kind === "word") kind = sqliteWords[text.toLowerCase()] ?? Lite.Other;
			state = sqliteStates[state]?.[kind] ?? 2;
			return kind === Lite.Semi && state === 1;
		},
	};
}

let lastSplit: { sql: string; dialect: Adapter; segments: Segment[] } | null = null;

/**
 * Cuts `sql` at each semicolon that ends a statement, by the rules of psql or the sqlite3 shell.
 * The last result is kept, since several callers split the same text on each keystroke.
 */
function segments(sql: string, dialect: Adapter): Segment[] {
	if (lastSplit && lastSplit.sql === sql && lastSplit.dialect === dialect)
		return lastSplit.segments;
	const out: Segment[] = [];
	const splitter = dialect === "postgres" ? psqlSplitter() : sqliteSplitter();
	let start = 0;
	let clean = "";
	for (const t of lex(sql, dialect)) {
		if (splitter.ends(t, sql.slice(t.start, t.end))) {
			out.push({ start, end: t.start, clean });
			start = t.end;
			clean = "";
		} else clean += cleanText(sql, t);
	}
	out.push({ start, end: sql.length, clean });
	lastSplit = { sql, dialect, segments: out };
	return out;
}

/**
 * The statements in `sql`, without comments, with each string literal and quoted name emptied, so
 * a keyword or semicolon inside one does not count.
 */
export function statements(sql: string, dialect: Adapter): string[] {
	return segments(sql, dialect)
		.map((s) => s.clean)
		.filter((s) => s.trim());
}

/**
 * Where each statement is in `sql`, as [start, end) without the surrounding whitespace or the
 * semicolon. Comments before a statement belong to it; a stretch of only comments is not one.
 */
export function statementRanges(sql: string, dialect: Adapter): [number, number][] {
	const out: [number, number][] = [];
	for (const s of segments(sql, dialect)) {
		if (!s.clean.trim()) continue;
		let a = s.start;
		let b = s.end;
		while (a < b && /\s/.test(sql[a] ?? "")) a++;
		while (b > a && /\s/.test(sql[b - 1] ?? "")) b--;
		out.push([a, b]);
	}
	return out;
}

/**
 * The statement a caret at `at` means: the one it is in or right after, so a caret on a blank line
 * between two statements means the one above. Before the first statement, it means the first.
 */
export function statementAt(sql: string, at: number, dialect: Adapter): [number, number] | null {
	const ranges = statementRanges(sql, dialect);
	let pick = ranges[0] ?? null;
	for (const r of ranges) if (r[0] <= at) pick = r;
	return pick;
}

const writeVerbs =
	/^\s*(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|vacuum|reindex|attach|detach|merge|copy)\b/i;

/** True when any statement in `sql` changes data or schema. */
export function isWrite(sql: string, dialect: Adapter): boolean {
	return statements(sql, dialect).some(
		(s) =>
			writeVerbs.test(s) ||
			// A pragma that assigns changes the database; one that reads does not.
			/^\s*pragma\b[^=]*=/i.test(s) ||
			// A CTE can end in a write.
			(/^\s*with\b/i.test(s) && /\b(insert|update|delete|merge)\b/i.test(s)),
	);
}
