// Holds the statement splitter in src/lib/sql.ts against the real thing: psql for Postgres and
// sqlite3_complete (through Python's sqlite3 module) for SQLite. Needs psql, python3 and a server:
//   ZETTA_TEST_PG_URL=postgres://... bun run oracle
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../src/lib/api";
import { statementRanges } from "../src/lib/sql";
import { lex } from "../src/lib/sql-lex";

const url = process.env.ZETTA_TEST_PG_URL;
if (!url) throw new Error("set ZETTA_TEST_PG_URL to a Postgres the oracle may run statements on");

/** A statement as its significant tokens without a final semicolon, so whitespace and comments do not count. */
function shape(text: string, dialect: Adapter): string {
	const toks = lex(text, dialect)
		.filter((t) => t.kind !== "space" && t.kind !== "comment")
		.map((t) => text.slice(t.start, t.end));
	while (toks.at(-1) === ";") toks.pop();
	return toks.join(" ");
}

function ours(sql: string, dialect: Adapter): string[] {
	return statementRanges(sql, dialect)
		.map(([a, b]) => shape(sql.slice(a, b), dialect))
		.filter(Boolean);
}

const dir = mkdtempSync(join(tmpdir(), "zetta-split-"));

/** What psql sends for `sql`, read back from its query log. */
function psql(sql: string, n: number): string[] {
	const file = join(dir, `${n}.sql`);
	const log = join(dir, `${n}.log`);
	writeFileSync(file, sql);
	writeFileSync(log, "");
	const args = [
		"-X",
		"-q",
		"-v",
		"ON_ERROR_STOP=0",
		"-o",
		"/dev/null",
		"-L",
		log,
		"-f",
		file,
		url ?? "",
	];
	spawnSync("psql", args, { stdio: "ignore" });
	return readFileSync(log, "utf8")
		.split("/******** QUERY *********/\n")
		.slice(1)
		.map((p) => shape(p.slice(0, p.indexOf("\n/************************/")), "postgres"))
		.filter(Boolean);
}

/** Each statement is the shortest prefix that sqlite3_complete accepts. */
const splitWithSqlite = `
import json, sqlite3, sys
text = sys.stdin.read()
out, start = [], 0
for i, ch in enumerate(text):
    if ch == ";" and sqlite3.complete_statement(text[start:i + 1]):
        out.append(text[start:i + 1]); start = i + 1
if text[start:].strip(): out.append(text[start:])
print(json.dumps(out))
`;

function sqlite(sql: string): string[] {
	const r = spawnSync("python3", ["-I", "-c", splitWithSqlite], { input: sql });
	if (r.status !== 0) throw new Error(`python3 failed: ${r.stderr}`);
	return (JSON.parse(r.stdout.toString()) as string[])
		.map((s) => shape(s, "sqlite"))
		.filter(Boolean);
}

/** What the server returns for `sql` sent whole, unsplit, as one simple query. */
function server(sql: string): string {
	const r = spawnSync("psql", ["-X", "-At", "-c", sql, url ?? ""]);
	return r.stdout.toString().trim();
}

const pgCases = [
	"select 1; select 2",
	"select $fn1$ ; $fn1$; select 2",
	"select $a$ $b$ ; $b$ $a$; select 2",
	"select E'a\\'; b'; select 2",
	"select 1 /* a /* ; */ ; */; select 2",
	"select (1; 2); select 3",
	"create or replace function f() returns int language sql begin atomic select 1; select case when true then 2 end; end; select 3",
	"create procedure p() begin atomic insert into t values (1); end;select 4",
	"begin; select 1; commit",
	"select 'a'\n'b;c'; select 2",
	"select 'a' -- c\n'b;c'; select 2",
	"select B'1''0'; select 2",
	"select U&'d\\0061t;'; select U&\"a;b\"",
	'select "a;b""c"; select 2',
	"select 1 -- ;\r; select 2",
	"select 1..2; select 2",
	"select f(a := 1); select 2",
	"select (create function begin); select 2",
	"create function g() returns int as $$ begin return 1; end $$ language plpgsql; select 5",
	"select 1 =-1; select 2 <--1\n; select 3",
	"select 123abc; select 2",
	"select 'unterminated; select 2",
	"select /* open ; select 2",
];

const sqliteCases = [
	"select 1; select 2",
	"select `a;b`, [c;d]; select 2",
	"select (1; 2); select 3",
	"create temp trigger tr after insert on t begin update t set x = case when 1 then 2 end; insert into u values (1); end; select 1",
	"create trigger tr after insert on t when new.x > 0; begin select 1; end; select 2",
	"explain query plan create trigger tr after insert on t begin select 1; end; select 2",
	"create table trigger_log (x); select 2",
	"begin; select 1; end",
	"select 'it''s;'; select 2",
	"select x'ab;'; select 2",
	"select 1 /* ; */; select 2 -- ;\n; select 3",
	"select $a; select 2",
	'select "a""b;"; select 2',
	"select 'open; select 2",
	"create trigger t2 after delete on t begin select 1; END ; select 2",
];

// Scripts built at random, from a fixed seed, out of pieces that hide or carry semicolons.
let seed = 42;
const rand = (n: number) => {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed % n;
};
const pgPieces = [
	"select 1",
	"select 'a;b'",
	"select E'x\\';y'",
	"select $$;$$",
	"select $q1$;$q1$",
	"select 1 /* ; /* ; */ ; */",
	"select (1;2)",
	"select 'a'\n'b;'",
	'select "a;b"',
	"select B'1''0'",
	"begin",
	"commit",
	"create function f() returns int language sql begin atomic select 1; select case when true then 1 end; end",
	"select case when true then 1 end",
	"select 1 -- ;\n",
];
const sqlitePieces = [
	"select 1",
	"select 'a;b'",
	"select `a;b`",
	"select [a;b]",
	"select (1;2)",
	"select x'0a'",
	'select "a;b"',
	"begin",
	"end",
	"create trigger t after insert on x begin select 1; select case when 1 then 2 end; end",
	"explain create trigger t after insert on x begin select 1; end",
	"select 1 -- ;\n",
	"select 1 /* ; */",
];
const separators = [";", "; ", ";\n", " ;\n\n", "; -- c\n", "; /* ; */ "];
function script(pieces: string[]): string {
	return Array.from({ length: 2 + rand(5) }, () => pieces[rand(pieces.length)] ?? "")
		.map((p) => p + (separators[rand(separators.length)] ?? ";"))
		.join("");
}
for (let i = 0; i < 150; i++) pgCases.push(script(pgPieces));
for (let i = 0; i < 300; i++) sqliteCases.push(script(sqlitePieces));

let failures = 0;
function report(name: string, sql: string, want: unknown, got: unknown): void {
	if (JSON.stringify(want) === JSON.stringify(got)) return;
	failures++;
	console.log(
		`\n[${name}] ${JSON.stringify(sql)}\n  real: ${JSON.stringify(want)}\n  ours: ${JSON.stringify(got)}`,
	);
}

for (const [i, sql] of pgCases.entries()) report("psql", sql, psql(sql, i), ours(sql, "postgres"));
for (const sql of sqliteCases) report("sqlite3_complete", sql, sqlite(sql), ours(sql, "sqlite"));

// psql reads a line at a time, so it splits an E'' string continued on the next line where the
// server does not. zetta sends text straight to the server, so here the server is the judge.
const continued = "select E'a'\n'\\'; still'";
report("server", continued, "a'; still", server(continued));
report(
	"server split",
	continued,
	["select E'a'\n'\\'; still'"],
	statementRanges(continued, "postgres").map(([a, b]) => continued.slice(a, b)),
);

rmSync(dir, { recursive: true });
console.log(
	`${pgCases.length} psql scripts, ${sqliteCases.length} SQLite scripts, ${failures} differ`,
);
if (failures > 0) process.exit(1);
