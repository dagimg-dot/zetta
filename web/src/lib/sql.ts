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

interface Segment {
	/** Where it starts in `sql`, just after the previous semicolon. */
	start: number;
	/** Where its semicolon is, or the end of `sql`. */
	end: number;
	/** The text without comments, with each string literal and quoted name emptied. */
	clean: string;
}

const tagAt = /\$[A-Za-z_]*\$/y;

/** The Postgres `$tag$` that starts at `i`, if one does. */
function dollarTag(sql: string, i: number): string | null {
	tagAt.lastIndex = i;
	return tagAt.exec(sql)?.[0] ?? null;
}

/** Cuts `sql` at each semicolon that is not inside a comment, string, quoted name or $tag$ body. */
function segments(sql: string): Segment[] {
	const out: Segment[] = [];
	let start = 0;
	let cur = "";
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i] ?? "";
		const rest = sql.slice(i, i + 2);
		if (rest === "--") {
			const end = sql.indexOf("\n", i);
			i = end < 0 ? sql.length : end;
		} else if (rest === "/*") {
			const end = sql.indexOf("*/", i + 2);
			i = end < 0 ? sql.length : end + 2;
			cur += " ";
		} else if (ch === "'" || ch === '"') {
			let j = i + 1;
			while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
			i = j + 1;
			cur += `${ch}${ch}`;
		} else if (ch === "$" && dollarTag(sql, i)) {
			const tag = dollarTag(sql, i) ?? "$$";
			const end = sql.indexOf(tag, i + tag.length);
			i = end < 0 ? sql.length : end + tag.length;
			cur += "''";
		} else if (ch === ";") {
			out.push({ start, end: i, clean: cur });
			cur = "";
			i++;
			start = i;
		} else {
			cur += ch;
			i++;
		}
	}
	out.push({ start, end: Math.min(i, sql.length), clean: cur });
	return out;
}

/**
 * The statements in `sql`, without comments, with each string literal and quoted name emptied, so
 * a keyword or semicolon inside one does not count. Handles '', "" and Postgres $tag$ quoting.
 */
export function statements(sql: string): string[] {
	return segments(sql)
		.map((s) => s.clean)
		.filter((s) => s.trim());
}

/**
 * Where each statement is in `sql`, as [start, end) without the surrounding whitespace or the
 * semicolon. Comments before a statement belong to it; a stretch of only comments is not one.
 */
export function statementRanges(sql: string): [number, number][] {
	const out: [number, number][] = [];
	for (const s of segments(sql)) {
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
export function statementAt(sql: string, at: number): [number, number] | null {
	const ranges = statementRanges(sql);
	let pick = ranges[0] ?? null;
	for (const r of ranges) if (r[0] <= at) pick = r;
	return pick;
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
