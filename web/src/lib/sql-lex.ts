import type { Adapter } from "./api";

/**
 * What a token is. Keywords and unquoted names are both `word`: which one a word is depends on
 * where it stands, so that is left to whoever reads the tokens.
 */
export type TokenKind =
	| "space"
	| "comment"
	| "word"
	/** A quoted name: "x", U&"x", and in SQLite also `x` and [x]. */
	| "name"
	/** A string, bit string, blob or $tag$ body. */
	| "string"
	| "number"
	/** $1 in Postgres; ?, ?1, :a, @a, #a and $a in SQLite. */
	| "param"
	| "operator"
	/** ( ) [ ] , ; . and Postgres :: := and .., and any character the database does not accept. */
	| "punct";

export interface Token {
	kind: TokenKind;
	start: number;
	end: number;
	/** The text ran out before the closing quote or comment end. */
	open?: true;
}

export interface LexOptions {
	/** Postgres standard_conforming_strings. Off, a backslash escapes in plain '...' strings too. */
	standardStrings?: boolean;
}

let last: { text: string; dialect: Adapter; standard: boolean; tokens: Token[] } | null = null;

/**
 * Splits `text` into tokens that cover it end to end, by the lexical rules of `dialect`. A comment,
 * string or quoted name that spans lines is one token, so the lexer holds no state between tokens
 * and can start again at any token's start. The last result is kept, since the editor, the
 * splitter and the highlighter all ask for the same text on each keystroke: do not change it.
 */
export function lex(text: string, dialect: Adapter, options: LexOptions = {}): readonly Token[] {
	const standard = options.standardStrings ?? true;
	if (last && last.text === text && last.dialect === dialect && last.standard === standard) {
		return last.tokens;
	}
	const scan = dialect === "postgres" ? postgresToken : sqliteToken;
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const t = scan(text, i, standard);
		tokens.push(t);
		i = t.end;
	}
	last = { text, dialect, standard, tokens };
	return tokens;
}

const code = (text: string, i: number) => text.charCodeAt(i);
/** Space, tab, newline, vertical tab, form feed and carriage return. */
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isOctal = (c: number) => c >= 48 && c <= 55;
const isBinary = (c: number) => c === 48 || c === 49;
/** A name's first character. Both databases take any non-ASCII character as a letter. */
const isLetter = (c: number) =>
	(c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
/** The rest of a name, which in both databases may also hold digits and `$`. */
const isNamePart = (c: number) => isLetter(c) || isDigit(c) || c === 36;

function token(kind: TokenKind, start: number, end: number, open = false): Token {
	return open ? { kind, start, end, open } : { kind, start, end };
}

function spaceEnd(text: string, i: number): number {
	while (i < text.length && isSpace(code(text, i))) i++;
	return i;
}

/** A `--` comment runs to the end of the line, which in Postgres a carriage return also ends. */
function lineCommentEnd(text: string, i: number, carriageReturn: boolean): number {
	let j = i + 2;
	while (j < text.length) {
		const c = code(text, j);
		if (c === 10 || (carriageReturn && c === 13)) break;
		j++;
	}
	return j;
}

/** A quoted run that ends at `close`, where `close` twice is one literal `close`. */
function quoted(text: string, kind: TokenKind, start: number, from: number, close: string): Token {
	let i = from;
	while (i < text.length) {
		if (text[i] === close) {
			if (text[i + 1] !== close) return token(kind, start, i + 1);
			i += 2;
		} else i++;
	}
	return token(kind, start, text.length, true);
}

function wordEnd(text: string, i: number): number {
	while (i < text.length && isNamePart(code(text, i))) i++;
	return i;
}

/** `(_?digit)*` from scan.l: digits, each allowed one `_` before it. */
function separatedDigitsEnd(text: string, i: number, ok: (c: number) => boolean): number {
	for (;;) {
		if (ok(code(text, i))) i++;
		else if (code(text, i) === 95 && ok(code(text, i + 1))) i += 2;
		else return i;
	}
}

/** How scan.l reads a string body: xq doubles quotes, xe also takes backslash escapes, xb and xh do neither. */
type PgStringMode = "standard" | "escape" | "bits";

/** Where the closing quote of a string body that starts at `i` is, or -1 when it has none. */
function pgStringClose(text: string, i: number, mode: PgStringMode): number {
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\" && mode === "escape") i += 2;
		else if (ch === "'") {
			if (mode !== "bits" && text[i + 1] === "'") i += 2;
			else return i;
		} else i++;
	}
	return -1;
}

/**
 * Where scan.l's quotecontinue picks a string up again after its closing quote: whitespace that
 * holds a newline, with -- comments allowed, then another quote. -1 when it does not. This follows
 * the server; psql reads a line at a time and cannot see a continuation on the next line.
 */
function pgContinuation(text: string, i: number): number {
	let newline = false;
	while (i < text.length) {
		const c = code(text, i);
		if (c === 10 || c === 13) {
			newline = true;
			i++;
		} else if (isSpace(c)) i++;
		else if (text.startsWith("--", i)) i = lineCommentEnd(text, i, true);
		else break;
	}
	return newline && text[i] === "'" ? i : -1;
}

/** A Postgres string whose body starts at `from`, with every continuation in the same mode. */
function pgString(text: string, start: number, from: number, mode: PgStringMode): Token {
	let i = from;
	for (;;) {
		const close = pgStringClose(text, i, mode);
		if (close < 0) return token("string", start, text.length, true);
		const more = pgContinuation(text, close + 1);
		if (more < 0) return token("string", start, close + 1);
		i = more + 1;
	}
}

/**
 * A Postgres number by scan.l: 0x1F, 0o17 and 0b101, else 12, 1.5, 1., .5 and 1e-3, with one `_`
 * allowed before any digit. Letters right after it are trailing junk that the server rejects as
 * part of the same token, as in 123abc; `1..10` stops before the range's `..`.
 */
function pgNumber(text: string, start: number): Token {
	const radix = text[start] === "0" ? (text[start + 1] ?? "").toLowerCase() : "";
	const ok = radix === "x" ? isHex : radix === "o" ? isOctal : radix === "b" ? isBinary : null;
	let i = ok ? separatedDigitsEnd(text, start + 2, ok) : start + 2;
	if (!ok || i === start + 2) {
		i = isDigit(code(text, start)) ? separatedDigitsEnd(text, start + 1, isDigit) : start;
		if (text[i] === "." && text[i + 1] !== ".") {
			i++;
			if (isDigit(code(text, i))) i = separatedDigitsEnd(text, i + 1, isDigit);
		}
		if (text[i] === "e" || text[i] === "E") {
			const sign = text[i + 1] === "+" || text[i + 1] === "-";
			const at = sign ? i + 2 : i + 1;
			if (isDigit(code(text, at))) i = separatedDigitsEnd(text, at + 1, isDigit);
			// realfail: 1e+ with no digits is one bad token.
			else if (sign) return token("number", start, at);
		}
	}
	if (isLetter(code(text, i))) i = wordEnd(text, i);
	return token("number", start, i);
}

const pgOperatorChars = "+-*/<>=~!@#%^&|`?";
/** An operator may end in + or - only when it also holds one of these. */
const pgOperatorSigns = "~!@#%^&|`?";

/** Postgres operators, by scan.l: a run of operator characters, cut before -- and /* and trimmed of a trailing + or -. */
function pgOperator(text: string, start: number): Token {
	let i = start;
	while (i < text.length && pgOperatorChars.includes(text[i] ?? "")) {
		if (i > start && (text.startsWith("--", i) || text.startsWith("/*", i))) break;
		i++;
	}
	const op = text.slice(start, i);
	if (op.length > 1 && ![...op].some((ch) => pgOperatorSigns.includes(ch))) {
		while (i - start > 1 && (text[i - 1] === "+" || text[i - 1] === "-")) i--;
	}
	return token("operator", start, i);
}

/** The `$tag$` that starts at `i`: a name that does not start with a digit and holds no `$`. */
function dollarTag(text: string, i: number): string | null {
	let j = i + 1;
	if (j < text.length && isLetter(code(text, j))) {
		j++;
		while (j < text.length && (isLetter(code(text, j)) || isDigit(code(text, j)))) j++;
	}
	return text[j] === "$" ? text.slice(i, j + 1) : null;
}

function postgresToken(text: string, i: number, standard: boolean): Token {
	const c = code(text, i);
	const ch = text[i] ?? "";
	const next = text[i + 1] ?? "";
	if (isSpace(c)) return token("space", i, spaceEnd(text, i));
	if (ch === "-" && next === "-") return token("comment", i, lineCommentEnd(text, i, true));
	if (ch === "/" && next === "*") {
		// Postgres comments nest.
		let depth = 0;
		let j = i;
		while (j < text.length) {
			if (text.startsWith("/*", j)) {
				depth++;
				j += 2;
			} else if (text.startsWith("*/", j)) {
				depth--;
				j += 2;
				if (depth === 0) return token("comment", i, j);
			} else j++;
		}
		return token("comment", i, text.length, true);
	}
	if (ch === '"') return quoted(text, "name", i, i + 1, '"');
	if (ch === "'") return pgString(text, i, i + 1, standard ? "standard" : "escape");
	const lower = ch.toLowerCase();
	// N'...' is the word NCHAR's N followed by an ordinary string, so it needs no case here.
	if (next === "'") {
		if (lower === "e") return pgString(text, i, i + 2, "escape");
		if (lower === "b" || lower === "x") return pgString(text, i, i + 2, "bits");
	}
	if (lower === "u" && next === "&") {
		const q = text[i + 2];
		if (q === "'") return pgString(text, i, i + 3, "standard");
		if (q === '"') return quoted(text, "name", i, i + 3, '"');
	}
	if (ch === "$") {
		if (isDigit(code(text, i + 1))) {
			let end = i + 2;
			while (isDigit(code(text, end))) end++;
			// param_junk: $1abc is one bad token.
			if (isLetter(code(text, end))) end = wordEnd(text, end);
			return token("param", i, end);
		}
		const tag = dollarTag(text, i);
		if (tag) {
			const close = text.indexOf(tag, i + tag.length);
			return close < 0
				? token("string", i, text.length, true)
				: token("string", i, close + tag.length);
		}
		return token("punct", i, i + 1);
	}
	if (ch === "." && next === ".") return token("punct", i, i + 2);
	if (isDigit(c) || (ch === "." && isDigit(code(text, i + 1)))) return pgNumber(text, i);
	if (isLetter(c)) return token("word", i, wordEnd(text, i));
	if (ch === ":" && (next === ":" || next === "=")) return token("punct", i, i + 2);
	if (pgOperatorChars.includes(ch)) return pgOperator(text, i);
	return token("punct", i, i + 1);
}

/** Digits and `_` separators, which tokenize.c allows anywhere in a run. */
function sqliteDigitsEnd(text: string, i: number, ok: (c: number) => boolean): number {
	while (i < text.length && (ok(code(text, i)) || code(text, i) === 95)) i++;
	return i;
}

/**
 * A SQLite number by tokenize.c: 0x1F, else 12, 1.5, 1., .5 and 1e-3. Name characters right after
 * it make one illegal token, as in 123abc.
 */
function sqliteNumber(text: string, start: number): Token {
	let i: number;
	if (
		text[start] === "0" &&
		(text[start + 1] === "x" || text[start + 1] === "X") &&
		isHex(code(text, start + 2))
	) {
		i = sqliteDigitsEnd(text, start + 3, isHex);
	} else {
		i = sqliteDigitsEnd(text, start, isDigit);
		if (text[i] === ".") i = sqliteDigitsEnd(text, i + 1, isDigit);
		const e = text[i] === "e" || text[i] === "E";
		const sign = text[i + 1] === "+" || text[i + 1] === "-";
		if (e && (isDigit(code(text, i + 1)) || (sign && isDigit(code(text, i + 2))))) {
			i = sqliteDigitsEnd(text, i + 2, isDigit);
		}
	}
	while (i < text.length && isNamePart(code(text, i))) i++;
	return token("number", start, i);
}

/** SQLite's multi-character operators, longest first. */
const sqliteOperators = ["->>", "||", "->", "<=", ">=", "==", "!=", "<>", "<<", ">>"];

function sqliteToken(text: string, i: number): Token {
	const c = code(text, i);
	const ch = text[i] ?? "";
	const next = text[i + 1] ?? "";
	// A vertical tab may follow other space but not start it.
	if (isSpace(c) && c !== 11) return token("space", i, spaceEnd(text, i));
	if (ch === "-" && next === "-") return token("comment", i, lineCommentEnd(text, i, false));
	// "/*" at the very end is a slash and a star.
	if (ch === "/" && next === "*" && i + 2 < text.length) {
		// SQLite comments do not nest.
		const close = text.indexOf("*/", i + 2);
		return close < 0 ? token("comment", i, text.length, true) : token("comment", i, close + 2);
	}
	if (ch === '"') return quoted(text, "name", i, i + 1, '"');
	if (ch === "`") return quoted(text, "name", i, i + 1, "`");
	if (ch === "[") {
		const close = text.indexOf("]", i + 1);
		return close < 0 ? token("name", i, text.length, true) : token("name", i, close + 1);
	}
	if (ch === "'") return quoted(text, "string", i, i + 1, "'");
	if ((ch === "x" || ch === "X") && next === "'") {
		// A blob holds an even number of hex digits; anything else runs to the next quote.
		let j = i + 2;
		while (isHex(code(text, j))) j++;
		if (text[j] !== "'" || (j - i) % 2 === 1) while (j < text.length && text[j] !== "'") j++;
		return j < text.length ? token("string", i, j + 1) : token("string", i, text.length, true);
	}
	if (ch === "?") {
		let end = i + 1;
		while (isDigit(code(text, end))) end++;
		return token("param", i, end);
	}
	if ("$@#:".includes(ch) && isNamePart(code(text, i + 1)))
		return token("param", i, wordEnd(text, i + 1));
	if (isDigit(c) || (ch === "." && isDigit(code(text, i + 1)))) return sqliteNumber(text, i);
	if (isLetter(c)) return token("word", i, wordEnd(text, i));
	for (const op of sqliteOperators)
		if (text.startsWith(op, i)) return token("operator", i, i + op.length);
	if ("+-*/%&|~<>=!".includes(ch)) return token("operator", i, i + 1);
	return token("punct", i, i + 1);
}
