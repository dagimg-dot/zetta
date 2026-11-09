import type { Adapter, Column, SchemaInfo, TableKind } from "./api";
import { match, Tier } from "./match";
import { statementSpan } from "./sql";
import {
	commonFunctions,
	postgresColumnName,
	postgresReserved,
	postgresTypeFunctionName,
	postgresUnreserved,
	sqliteFallback,
	sqliteReserved,
} from "./sql-keywords";
import { lex, type Token } from "./sql-lex";

export type CandidateKind = "keyword" | "schema" | "relation" | "column";

export interface Candidate {
	label: string;
	/** What accepting writes, quoted when the database needs it to be. */
	insert: string;
	kind: CandidateKind;
	/** Shown beside the label: a column's type, a table's kind or schema. */
	detail: string;
	/** For a relation, whether it is a view. */
	relationKind?: TableKind;
	/** Among equal matches, lower comes first: what fits here before what merely exists. */
	rank: number;
}

/** What completion reads from the catalog. Columns are fetched per table and may not be here yet. */
export interface CatalogView {
	schemas: readonly SchemaInfo[];
	/** Where unqualified names resolve: public in Postgres, main in SQLite. */
	defaultSchema: string;
	columns(schema: string, table: string): readonly Column[] | undefined;
}

export interface Completion {
	/** The [from, to) range accepting replaces. */
	from: number;
	to: number;
	/** What was typed of the name, without an opening quote. */
	typed: string;
	candidates: Candidate[];
	/** Tables whose columns were wanted but are not loaded yet. */
	missing: { schema: string; table: string }[];
	/** The word typed is probably finished, as an alias or a function's name, so Enter leaves it be. */
	tentative?: boolean;
}

/** A name as the server prints it with quote_ident: bare when that reads back the same, else quoted. */
export function quoteName(name: string, dialect: Adapter): string {
	const lower = name.toLowerCase();
	const bare =
		dialect === "postgres"
			? /^[a-z_][a-z0-9_]*$/.test(name) &&
				!postgresReserved.has(lower) &&
				!postgresColumnName.has(lower) &&
				!postgresTypeFunctionName.has(lower)
			: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !sqliteReserved.has(lower);
	return bare ? name : `"${name.replaceAll('"', '""')}"`;
}

/** A quoted or bare name token as the name it means. */
function unquote(text: string): string {
	const q = text[0];
	if (q === '"' || q === "`")
		return text.slice(1, text.at(-1) === q ? -1 : undefined).replaceAll(q + q, q);
	if (q === "[") return text.slice(1, text.at(-1) === "]" ? -1 : undefined);
	return text;
}

function isKeyword(word: string, dialect: Adapter): boolean {
	const w = word.toLowerCase();
	return dialect === "postgres"
		? postgresReserved.has(w) ||
				postgresColumnName.has(w) ||
				postgresTypeFunctionName.has(w) ||
				postgresUnreserved.has(w)
		: sqliteReserved.has(w) || sqliteFallback.has(w);
}

/** What may follow each clause, as offered keywords. Words a dialect lacks are dropped. */
const follows: Record<string, string> = {
	start:
		"select insert update delete with create alter drop explain begin commit rollback values truncate vacuum analyze copy show set grant revoke pragma attach detach reindex replace",
	select:
		"from distinct as case when then else end and or not null is in like ilike between exists cast over filter",
	from: "where join inner left right full cross natural on using as group order limit offset union except intersect having window lateral",
	where:
		"and or not null is in like ilike glob between exists group order limit offset union except intersect having true false case",
	group: "by having order limit",
	order: "by asc desc nulls first last limit offset",
	limit: "offset",
	set: "where from returning",
	values: "on conflict returning",
	into: "values select default",
	update: "set",
	delete: "from where returning",
	insert: "into",
	with: "as recursive select",
	create:
		"table view index unique schema trigger function or replace temporary temp materialized sequence extension virtual if not exists",
	alter: "table add column drop rename to type set",
	drop: "table view index schema trigger function sequence if exists cascade",
	returning: "",
};
follows.join = follows.from ?? "";
follows.on = follows.where ?? "";
follows.having = follows.where ?? "";
follows.using = follows.from ?? "";

/** The clause a keyword opens, for picking what may follow it. */
const clauseOf: Record<string, string> = {
	select: "select",
	from: "from",
	join: "join",
	on: "on",
	using: "using",
	where: "where",
	group: "group",
	order: "order",
	having: "having",
	limit: "limit",
	offset: "limit",
	set: "set",
	values: "values",
	into: "into",
	update: "update",
	delete: "delete",
	insert: "insert",
	with: "with",
	create: "create",
	alter: "alter",
	drop: "drop",
	returning: "returning",
	union: "select",
	except: "select",
	intersect: "select",
};

/** After these a relation's name comes next. */
const relationWords = new Set(["from", "join", "into", "update", "table"]);

/** Clauses whose expressions name columns. */
const columnClauses = new Set([
	"select",
	"where",
	"on",
	"group",
	"order",
	"having",
	"set",
	"returning",
	"using",
]);

interface Relation {
	schema: string;
	table: string;
	/** The name the statement uses for it: its alias, or its own name. */
	alias: string;
}

const significant = (t: Token) => t.kind !== "space" && t.kind !== "comment";

/** Calls whose FROM is followed by a value, as extract(year from d). */
const valueFromCalls = new Set(["extract", "trim", "substring", "overlay"]);

/** Statements whose own FROM is followed by a file, a role or a cursor. */
const noTableFromStatements = new Set(["copy", "revoke", "fetch", "move"]);

/** What an UPDATE that is not a statement can be followed by, by the word before it. */
const afterInnerUpdate: Record<string, string> = {
	do: "set",
	for: "of nowait skip",
	key: "of nowait skip",
	on: "cascade restrict set no",
};

/** Whether a table comes after the relation word at `i`, which FROM and UPDATE do only sometimes. */
function takesRelation(sig: readonly Token[], i: number, text: string): boolean {
	const lower = (at: number) => {
		const t = sig[at];
		return t ? text.slice(t.start, t.end).toLowerCase() : "";
	};
	const w = lower(i);
	const last = lower(i - 1);
	if (w === "update")
		return i === 0 || ["(", ")", "explain", "analyze", "analyse", "verbose"].includes(last);
	if (w !== "from") return relationWords.has(w);
	if (last === "distinct" && ["is", "not"].includes(lower(i - 2))) return false;
	let depth = 0;
	for (let k = i - 1; k >= 0; k--) {
		const p = lower(k);
		if (p === ")") depth++;
		else if (p === "(") {
			if (depth === 0) return !valueFromCalls.has(lower(k - 1));
			depth--;
		}
	}
	return !noTableFromStatements.has(lower(0));
}

/**
 * The relations a statement reads, from each FROM, JOIN, UPDATE and INTO at its top level, with
 * their aliases. Reads the whole statement, so a FROM after the caret still counts.
 */
function relations(
	text: string,
	tokens: readonly Token[],
	dialect: Adapter,
	catalog: CatalogView,
): Relation[] {
	const out: Relation[] = [];
	const sig = tokens.filter(significant);
	const word = (t: Token | undefined) => (t ? text.slice(t.start, t.end) : "");
	const isName = (t: Token | undefined) =>
		!!t && (t.kind === "name" || (t.kind === "word" && !isKeyword(word(t), dialect)));
	let depth = 0;
	let inFrom = false;
	for (let i = 0; i < sig.length; i++) {
		const t = sig[i];
		if (!t) continue;
		const w = word(t).toLowerCase();
		if (w === "(") depth++;
		else if (w === ")") depth = Math.max(0, depth - 1);
		if (depth > 0 || (t.kind !== "word" && w !== ",")) continue;
		if (relationWords.has(w) && !takesRelation(sig, i, text)) continue;
		if (t.kind === "word" && clauseOf[w] && w !== "join") inFrom = w === "from";
		const startsRelation = relationWords.has(w) || (w === "," && inFrom);
		if (!startsRelation) continue;
		// name [. name] [[as] alias]
		const parts: string[] = [];
		let j = i + 1;
		let n = sig[j];
		if (!isName(n) && !(n && n.kind === "word")) continue;
		while (n && (n.kind === "name" || n.kind === "word")) {
			parts.push(unquote(word(n)));
			j++;
			if (word(sig[j]) !== ".") break;
			j++;
			n = sig[j];
		}
		const [first, second] = parts;
		if (!first) continue;
		let alias = second ?? first;
		let a = sig[j];
		if (a && word(a).toLowerCase() === "as") {
			j++;
			a = sig[j];
		}
		if (isName(a)) alias = unquote(word(a));
		const schema = second ? first : catalog.defaultSchema;
		const table = second ?? first;
		out.push({ schema, table, alias });
	}
	return out;
}

/** The schema and real name of a table the catalog knows, matching names as the database would. */
function findTable(
	catalog: CatalogView,
	schema: string,
	table: string,
): { schema: string; table: string } | null {
	const s =
		catalog.schemas.find((x) => x.name === schema) ??
		catalog.schemas.find((x) => x.name.toLowerCase() === schema.toLowerCase());
	const t =
		s?.tables.find((x) => x.name === table) ??
		s?.tables.find((x) => x.name.toLowerCase() === table.toLowerCase());
	return s && t ? { schema: s.name, table: t.name } : null;
}

/** Whether the next word sits where a table's alias goes: right after a table or subquery being read. */
function followsTable(before: readonly Token[], clause: string, text: string): boolean {
	const word = (at: number) => {
		const t = before[at];
		return t ? text.slice(t.start, t.end).toLowerCase() : "";
	};
	let k = before.length - 1;
	if (word(k) === ")") return clause === "from" || clause === "join";
	const last = before[k];
	if (!last || (last.kind !== "name" && last.kind !== "word")) return false;
	while (word(k - 1) === ".") k -= 2;
	const opener = word(k - 1);
	if (opener === ",") return clause === "from";
	return ["from", "join", "update"].includes(opener) && takesRelation(before, k - 1, text);
}

/** Whether `typed` names a function, which a column that merely begins the same should not replace. */
function isFunction(typed: string, catalog: CatalogView): boolean {
	const name = typed.toLowerCase();
	return (
		commonFunctions.has(name) ||
		catalog.schemas.some((s) => s.functions.some((f) => f.name.toLowerCase() === name))
	);
}

/**
 * What completes the text at `caret`, or null where nothing should: inside a string, comment,
 * number or parameter. `explicit` is a request by key, which also completes with nothing typed.
 */
export function complete(
	text: string,
	caret: number,
	dialect: Adapter,
	catalog: CatalogView,
	explicit: boolean,
): Completion | null {
	const [spanStart, spanEnd] = statementSpan(text, caret, dialect);
	const all = lex(text, dialect);
	const tokens = all.filter((t) => t.start >= spanStart && t.end <= spanEnd);
	const at = tokens.findIndex((t) => t.start < caret && caret <= t.end);
	const here = at >= 0 ? tokens[at] : undefined;

	let from = caret;
	let to = caret;
	let typed = "";
	if (here) {
		if (here.kind === "word") {
			from = here.start;
			typed = text.slice(here.start, caret);
		} else if (here.kind === "name" && (here.open || caret < here.end)) {
			from = here.start;
			to = here.open ? caret : here.end;
			typed = unquote(text.slice(here.start, caret));
		} else if (here.kind !== "space" && here.kind !== "punct" && here.kind !== "operator") {
			return null;
		}
	}
	if (/^\d/.test(typed)) return null;

	const before = tokens.filter((t) => t.end <= from && significant(t));
	const word = (t: Token | undefined) => (t ? text.slice(t.start, t.end) : "");
	const prev = before.at(-1);
	const prevWord = word(prev).toLowerCase();
	const missing: Completion["missing"] = [];
	const candidates: Candidate[] = [];

	const columnsOf = (schema: string, table: string, rank: number, owner: string) => {
		const cols = catalog.columns(schema, table);
		if (!cols) {
			missing.push({ schema, table });
			return;
		}
		for (const c of cols)
			candidates.push({
				label: c.name,
				insert: quoteName(c.name, dialect),
				kind: "column",
				detail: owner ? `${c.type} · ${owner}` : c.type,
				rank,
			});
	};
	const relationsIn = (schema: SchemaInfo, rank: number, qualify: boolean) => {
		for (const t of schema.tables) {
			const name = quoteName(t.name, dialect);
			candidates.push({
				label: qualify ? `${schema.name}.${t.name}` : t.name,
				insert: qualify ? `${quoteName(schema.name, dialect)}.${name}` : name,
				kind: "relation",
				relationKind: t.kind,
				detail: t.kind === "table" ? schema.name : `${t.kind.replace("_", " ")} · ${schema.name}`,
				rank,
			});
		}
	};
	const scope = () => relations(text, tokens, dialect, catalog);

	// After a dot: the columns of a table or alias, or the tables of a schema.
	if (prevWord === ".") {
		const q1 = before.at(-2);
		const q0 = before.at(-3);
		const q00 = before.at(-4);
		if (!q1 || (q1.kind !== "word" && q1.kind !== "name")) return null;
		const name = unquote(word(q1));
		if (q0 && word(q0) === "." && q00) {
			const t = findTable(catalog, unquote(word(q00)), name);
			if (t) columnsOf(t.schema, t.table, 0, "");
		} else {
			const r = scope().find((x) => x.alias.toLowerCase() === name.toLowerCase());
			const t = r
				? findTable(catalog, r.schema, r.table)
				: findTable(catalog, catalog.defaultSchema, name);
			const s = catalog.schemas.find((x) => x.name.toLowerCase() === name.toLowerCase());
			if (t) columnsOf(t.schema, t.table, 0, "");
			if (s) relationsIn(s, 1, false);
		}
		return { from, to, typed, candidates, missing };
	}

	// A new name goes after AS, and a type after a cast; neither can be known.
	if (prevWord === "::" || (prevWord === "as" && prev?.kind === "word")) return null;

	const afterRelationWord = before.length > 0 && takesRelation(before, before.length - 1, text);
	if (!explicit && !typed && !afterRelationWord) return null;

	// The clause the caret is in, at its own parenthesis depth.
	let clause = "start";
	const outer: string[] = [];
	for (const [i, t] of before.entries()) {
		const w = word(t).toLowerCase();
		if (w === "(") {
			outer.push(clause);
			clause = "paren";
		} else if (w === ")") clause = outer.pop() ?? "start";
		else if (
			t.kind === "word" &&
			clauseOf[w] &&
			(!relationWords.has(w) || takesRelation(before, i, text))
		)
			clause = clauseOf[w] ?? clause;
	}
	if (clause === "paren") clause = "select";

	const keywords = (list: string, rank: number) => {
		const upper = typed.length > 0 && typed === typed.toUpperCase() && /[A-Z]/.test(typed);
		for (const k of list.split(" ")) {
			if (!k || !isKeyword(k, dialect)) continue;
			candidates.push({
				label: upper ? k.toUpperCase() : k,
				insert: upper ? k.toUpperCase() : k,
				kind: "keyword",
				detail: "keyword",
				rank,
			});
		}
	};

	if (afterRelationWord || (prevWord === "," && clause === "from")) {
		const home = catalog.schemas.find((s) => s.name === catalog.defaultSchema);
		if (home) relationsIn(home, 0, false);
		for (const s of catalog.schemas) {
			if (s.name === catalog.defaultSchema) continue;
			candidates.push({
				label: s.name,
				insert: quoteName(s.name, dialect),
				kind: "schema",
				detail: "schema",
				rank: 1,
			});
			relationsIn(s, 2, true);
		}
		return { from, to, typed, candidates, missing };
	}

	if (prevWord === "update") {
		keywords(afterInnerUpdate[word(before.at(-2)).toLowerCase()] ?? "", 0);
		return { from, to, typed, candidates, missing };
	}

	// INSERT INTO t ( names t's columns.
	const open = before.at(-1)?.kind === "punct" && prevWord === "(" ? before.length - 1 : -1;
	const intoTable =
		open >= 2 && word(before[open - 2]).toLowerCase() === "into" ? before[open - 1] : undefined;
	if (intoTable && (intoTable.kind === "word" || intoTable.kind === "name")) {
		const t = findTable(catalog, catalog.defaultSchema, unquote(word(intoTable)));
		if (t) columnsOf(t.schema, t.table, 0, "");
		return { from, to, typed, candidates, missing };
	}

	if (before.length === 0) {
		keywords(follows.start ?? "", 0);
		return { from, to, typed, candidates, missing };
	}

	if (followsTable(before, clause, text)) {
		// An alias is any word at all, so a clause is offered only once two letters rule most out.
		if (!explicit && typed.length < 2) return null;
		keywords(follows[clause] ?? "", 0);
		const begun = typed.toLowerCase();
		return {
			from,
			to,
			typed,
			candidates: candidates.filter((c) => c.label.toLowerCase().startsWith(begun)),
			missing,
			tentative: true,
		};
	}

	// Right after a finished expression, the next word is more often a keyword than a column.
	const ended =
		!!prev &&
		(prev.kind === "name" ||
			prev.kind === "number" ||
			prev.kind === "string" ||
			prevWord === ")" ||
			prevWord === "*" ||
			(prev.kind === "word" && !isKeyword(prevWord, dialect)));
	if (columnClauses.has(clause)) {
		const rels = scope();
		for (const r of rels) {
			const t = findTable(catalog, r.schema, r.table);
			if (t) columnsOf(t.schema, t.table, ended ? 2 : 0, rels.length > 1 ? r.alias : "");
			if (r.alias !== r.table)
				candidates.push({
					label: r.alias,
					insert: quoteName(r.alias, dialect),
					kind: "relation",
					detail: `alias · ${r.table}`,
					rank: ended ? 3 : 1,
				});
		}
	}
	keywords(follows[clause] ?? "", ended ? 0 : 3);
	return { from, to, typed, candidates, missing, tentative: isFunction(typed, catalog) };
}

export interface Ranked extends Candidate {
	tier: Tier;
	/** The label's matched [start, end) ranges, for drawing in bold. */
	ranges: [number, number][];
}

/**
 * The candidates that match `typed`, best first: by how well they match, then by `rank`, then
 * shorter, then in the order they came, as columns in table order. At most `limit`, since nobody
 * scrolls past the first screenful.
 */
export function rank(candidates: readonly Candidate[], typed: string, limit = 100): Ranked[] {
	const seen = new Set<string>();
	const out: (Ranked & { cost: number; index: number })[] = [];
	for (const [index, c] of candidates.entries()) {
		const key = `${c.kind}:${c.label}:${c.detail}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const m = match(typed, c.label);
		if (m) out.push({ ...c, tier: m.tier, ranges: m.ranges, cost: m.cost, index });
	}
	out.sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.cost - b.cost || a.index - b.index);
	return out.slice(0, limit);
}

/**
 * Whether Enter takes `pick` instead of starting a new line. Enter also ends lines, so with no
 * choice made in the list it takes only a name that continues what was typed. `current` is the
 * text accepting would replace; `moved` is a choice made with the keys, and `explicit` a list
 * asked for by key.
 */
export function enterAccepts(
	c: Completion,
	pick: Ranked,
	current: string,
	how: { moved: boolean; explicit: boolean },
): boolean {
	if (pick.insert === current) return false;
	if (how.moved) return true;
	if (pick.tier > Tier.Prefix || pick.insert.toLowerCase() === current.toLowerCase()) return false;
	return how.explicit || (!c.tentative && c.typed !== "");
}
