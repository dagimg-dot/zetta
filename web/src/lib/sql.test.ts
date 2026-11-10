import { describe, expect, test } from "bun:test";
import type { Adapter } from "./api";
import {
	changesSchema,
	closest,
	destructive,
	errorRange,
	isWrite,
	safeToRetry,
	statementAt,
	statementRanges,
	statements,
	unknownColumn,
} from "./sql";

describe("did you mean", () => {
	test("finds the column in both databases' messages", () => {
		expect(unknownColumn("no such column: balanc")).toBe("balanc");
		// Builder queries quote names, and SQLite then quotes them back in the message.
		expect(
			unknownColumn('no such column: "balanc" - should this be a string literal in single-quotes?'),
		).toBe("balanc");
		expect(unknownColumn('column "c.balanc" does not exist')).toBe("balanc");
		expect(closest("balanc", ["id", "name", "balance"])).toBe("balance");
		expect(closest("zzz", ["id", "name"])).toBeNull();
	});
});

describe("errorRange", () => {
	test("follows the Postgres caret onto the right line", () => {
		const sql = "select 1;\nselec 2";
		const msg = 'syntax error at or near "selec"\nLINE 2: selec 2\n        ^';
		expect(errorRange(sql, msg)).toEqual([10, 15]);
	});
	test("finds SQLite's near token", () => {
		expect(errorRange("selec 1", 'near "selec": syntax error')).toEqual([0, 5]);
	});
});

describe("isWrite", () => {
	test("flags any statement that changes data, ignoring comments", () => {
		expect(isWrite("select 1", "postgres")).toBe(false);
		expect(isWrite("select 1; update t set x = 1", "postgres")).toBe(true);
		expect(isWrite("-- delete everything\nselect 1", "postgres")).toBe(false);
	});

	test("a keyword or semicolon inside a string is not a statement", () => {
		expect(isWrite("select 'a; delete everything'", "postgres")).toBe(false);
		expect(isWrite('select 1 as "x; drop table t"', "postgres")).toBe(false);
		expect(isWrite("select $q$; delete from t$q$", "postgres")).toBe(false);
		expect(isWrite("select 'it''s'; delete from t", "postgres")).toBe(true);
	});

	test("assigning pragmas, attach and writing CTEs count as writes", () => {
		expect(isWrite("pragma user_version = 5", "postgres")).toBe(true);
		expect(isWrite("pragma table_info(t)", "postgres")).toBe(false);
		expect(isWrite("attach database 'x.db' as x", "postgres")).toBe(true);
		expect(isWrite("with d as (delete from t returning *) select * from d", "postgres")).toBe(true);
		expect(isWrite("with c as (select 1) select * from c", "postgres")).toBe(false);
	});
});

test("statements split on semicolons outside comments and quotes", () => {
	const parts = statements("select 1; /* ; */ select ';'; -- ;\n", "postgres").map((s) => s.trim());
	expect(parts).toEqual(["select 1", "select ''"]);
});

test("only create, drop and alter change the table list", () => {
	expect(changesSchema("create table t (x int)", "postgres")).toBe(true);
	expect(changesSchema("select 1;\n  DROP VIEW v", "postgres")).toBe(true);
	expect(changesSchema("insert into t values (1)", "postgres")).toBe(false);
	expect(changesSchema("select 'create table'", "postgres")).toBe(false);
});

describe("statement at the caret", () => {
	const script = "select 1;\n\nselect 'a; b';\n-- note\nselect 3";
	const at = (needle: string, shift = 0) => script.indexOf(needle) + shift;
	const textAt = (caret: number) => {
		const r = statementAt(script, caret, "postgres");
		return r ? script.slice(r[0], r[1]) : null;
	};

	test("ranges leave out the whitespace and the semicolon", () => {
		expect(statementRanges(script, "postgres").map(([a, b]) => script.slice(a, b))).toEqual([
			"select 1",
			"select 'a; b'",
			"-- note\nselect 3",
		]);
	});

	test("a caret inside a statement, or right after its semicolon, means that statement", () => {
		expect(textAt(0)).toBe("select 1");
		expect(textAt(at("1;", 2))).toBe("select 1");
		expect(textAt(at("'a;", 2))).toBe("select 'a; b'");
		expect(textAt(script.length)).toBe("-- note\nselect 3");
	});

	test("a caret on the blank line between two statements means the one above", () => {
		expect(textAt(at("\n\n", 1))).toBe("select 1");
	});

	test("a comment before a statement belongs to it", () => {
		expect(textAt(at("-- note", 3))).toBe("-- note\nselect 3");
	});

	test("semicolons in strings, quoted names, comments and $tag$ bodies do not split", () => {
		const sql = `select '; x', "a;b" /* ; */ -- ;\n;select $f$ ; $f$`;
		expect(statementRanges(sql, "postgres").length).toBe(2);
	});

	test("a script without semicolons is one statement, and only comments are none", () => {
		expect(statementRanges("select 1\nfrom t", "postgres")).toEqual([[0, 15]]);
		expect(statementAt("-- nothing here", 3, "postgres")).toBeNull();
		expect(statementAt("", 0, "postgres")).toBeNull();
		expect(statementAt("  \n select 1", 0, "postgres")).toEqual([4, 12]);
	});
});

describe("splitting follows each database's rules", () => {
	const texts = (sql: string, dialect: Adapter) =>
		statementRanges(sql, dialect).map(([a, b]) => sql.slice(a, b));

	test("Postgres: $tag$ with digits, E'' escapes and nested comments hide their semicolons", () => {
		expect(texts("select $fn1$ ; $fn1$; select 2", "postgres")).toEqual([
			"select $fn1$ ; $fn1$",
			"select 2",
		]);
		expect(texts("select E'a\\'; b'; select 2", "postgres")).toEqual([
			"select E'a\\'; b'",
			"select 2",
		]);
		expect(texts("select 1 /* a /* ; */ ; */; select 2", "postgres")).toEqual([
			"select 1 /* a /* ; */ ; */",
			"select 2",
		]);
	});

	test("parentheses hide a semicolon from psql but not from sqlite3_complete", () => {
		expect(texts("select (1; 2); select 3", "postgres")).toEqual(["select (1; 2)", "select 3"]);
		expect(texts("select (1; 2); select 3", "sqlite")).toEqual(["select (1", "2)", "select 3"]);
	});

	test("Postgres: words inside parentheses do not make a statement a routine", () => {
		expect(texts("select (create function begin); select 2", "postgres")).toEqual([
			"select (create function begin)",
			"select 2",
		]);
	});

	test("Postgres: a BEGIN ATOMIC body holds its semicolons, CASE ... END included", () => {
		const fn =
			"create or replace function f() returns int language sql begin atomic select 1; select case when true then 2 end; end";
		expect(texts(`${fn}; select 3`, "postgres")).toEqual([fn, "select 3"]);
		const proc = "create procedure p() begin atomic insert into t values (1); end";
		expect(texts(`${proc};select 4`, "postgres")).toEqual([proc, "select 4"]);
	});

	test("a transaction's BEGIN is a statement of its own", () => {
		expect(texts("begin; select 1; commit", "postgres")).toEqual(["begin", "select 1", "commit"]);
		expect(texts("begin; select 1; end", "sqlite")).toEqual(["begin", "select 1", "end"]);
	});

	test("SQLite: a trigger body runs to ; END ;, past CASE ... END", () => {
		const trigger =
			"create temp trigger tr after insert on t begin update t set x = case when 1 then 2 end; insert into u values (1); end";
		expect(texts(`${trigger}; select 1`, "sqlite")).toEqual([trigger, "select 1"]);
	});

	test("SQLite: a trigger opens at CREATE TRIGGER, also after EXPLAIN, before any BEGIN", () => {
		const header = "create trigger tr after insert on t when new.x > 0; begin select 1; end";
		expect(texts(`${header}; select 2`, "sqlite")).toEqual([header, "select 2"]);
		const explained = "explain query plan create trigger tr after insert on t begin select 1; end";
		expect(texts(`${explained}; select 2`, "sqlite")).toEqual([explained, "select 2"]);
		expect(texts("create table trigger_log (x); select 2", "sqlite")).toEqual([
			"create table trigger_log (x)",
			"select 2",
		]);
	});

	test("SQLite: backtick and bracket names hide their semicolons; $tag$ is not a quote", () => {
		expect(texts("select `a;b`, [c;d]; select 2", "sqlite")).toEqual([
			"select `a;b`, [c;d]",
			"select 2",
		]);
		expect(texts("select $a; select 2", "sqlite")).toEqual(["select $a", "select 2"]);
	});
});

describe("statements that can destroy data", () => {
	const brief = (sql: string, dialect: Adapter = "postgres") =>
		destructive(sql, dialect).map((d) => `${d.what} ${d.target}`);

	test("DELETE and UPDATE without WHERE, but not with one", () => {
		expect(brief("delete from orders")).toEqual(["Deletes every row of orders"]);
		expect(brief("update orders set paid = true")).toEqual(["Changes every row of orders"]);
		expect(brief("delete from orders where id = 1")).toEqual([]);
		expect(brief("update orders set paid = true where id = 1")).toEqual([]);
	});

	test("a WHERE inside a subquery does not limit the statement", () => {
		expect(brief("update a set b = (select c from d where e = 1)")).toEqual([
			"Changes every row of a",
		]);
		expect(brief("delete from a returning (select 1 from b where c)")).toEqual([
			"Deletes every row of a",
		]);
	});

	test("keywords inside strings and comments are only text", () => {
		expect(brief("select 'delete from orders'")).toEqual([]);
		expect(brief("-- delete from orders\nselect 1")).toEqual([]);
		expect(brief("/* drop table a */ select 1")).toEqual([]);
		expect(brief("delete from orders -- where id = 1")).toEqual(["Deletes every row of orders"]);
	});

	test("the table is read as the database would read it", () => {
		const table = (sql: string, dialect: Adapter = "postgres") =>
			destructive(sql, dialect)[0]?.table;
		expect(table("delete from Orders")).toEqual({ name: "orders" });
		expect(table("delete from Orders", "sqlite")).toEqual({ name: "Orders" });
		expect(table('delete from "Sales"."Orders"')).toEqual({ schema: "Sales", name: "Orders" });
		expect(table("update only audit.events set a = 1")).toEqual({
			schema: "audit",
			name: "events",
		});
		expect(table("update or replace t set a = 1", "sqlite")).toEqual({ name: "t" });
	});

	test("TRUNCATE names each table and says when it cascades", () => {
		expect(brief("truncate a")).toEqual(["Empties a"]);
		expect(brief("truncate table only a, s.b restart identity")).toEqual([
			"Empties a",
			"Empties s.b",
		]);
		expect(destructive("truncate a cascade", "postgres")[0]?.cascade).toBe(true);
		expect(destructive("truncate a", "postgres")[0]?.cascade).toBe(false);
	});

	test("DROP TABLE names each table with a count to take, and other DROPs say what they are", () => {
		expect(brief("drop table if exists a, b")).toEqual(["Drops table a", "Drops table b"]);
		expect(destructive("drop table a", "postgres")[0]?.table).toEqual({ name: "a" });
		expect(brief("drop view v")).toEqual(["Drops view v"]);
		expect(brief("drop materialized view if exists m")).toEqual(["Drops materialized view m"]);
		expect(brief("drop schema s cascade")).toEqual(["Drops schema s"]);
		expect(destructive("drop schema s cascade", "postgres")[0]).toMatchObject({
			cascade: true,
			table: undefined,
		});
	});

	test("dropping a column counts, dropping a constraint does not", () => {
		expect(brief("alter table t drop column c")).toEqual(["Drops column c of t"]);
		expect(brief("alter table t drop column if exists c, drop column d")).toEqual([
			"Drops column c of t",
			"Drops column d of t",
		]);
		expect(brief("alter table t drop constraint k")).toEqual([]);
		expect(brief("alter table t alter c drop default")).toEqual([]);
	});

	test("COLUMN is optional, so a bare DROP of a name drops that column", () => {
		expect(brief("alter table users drop email")).toEqual(["Drops column email of users"]);
		expect(brief("ALTER TABLE users DROP IF EXISTS email")).toEqual([
			"Drops column email of users",
		]);
		expect(brief('alter table t drop "Note"', "sqlite")).toEqual(['Drops column "Note" of t']);
		expect(brief("alter table t alter c drop not null, alter d drop expression")).toEqual([]);
		expect(brief("alter table t alter c drop identity if exists")).toEqual([]);
	});

	test("a write inside or after a WITH is found", () => {
		expect(brief("with d as (delete from t) select * from d")).toEqual(["Deletes every row of t"]);
		expect(brief("with x as (select 1) update t set a = 1")).toEqual(["Changes every row of t"]);
		expect(brief("with d as (delete from t where a) select 1")).toEqual([]);
	});

	test("EXPLAIN only plans, unless ANALYZE really runs it", () => {
		expect(brief("explain delete from t")).toEqual([]);
		expect(brief("explain delete from t", "sqlite")).toEqual([]);
		expect(brief("explain (analyze false) delete from t")).toEqual([]);
		expect(brief("explain analyze delete from t")).toEqual(["Deletes every row of t"]);
		expect(brief("explain (verbose, analyze) delete from t")).toEqual(["Deletes every row of t"]);
	});

	test("words that only look like a write are left alone", () => {
		for (const sql of [
			"select * from t for update",
			"insert into t values (1) on conflict (id) do update set a = 1",
			"create table t (a int references b (id) on delete cascade on update cascade)",
			"create trigger g after delete on t begin select 1; end",
			"grant delete, update on t to u",
			"select 1",
		])
			expect(brief(sql)).toEqual([]);
	});

	test("every statement of a script is checked, each with its own text", () => {
		const found = destructive(
			"select 1; delete from a; delete from b where c; drop table d",
			"postgres",
		);
		expect(found.map((d) => d.target)).toEqual(["a", "d"]);
		expect(found.map((d) => d.statement)).toEqual(["delete from a", "drop table d"]);
	});
});

describe("running again after a timeout", () => {
	test("one statement left nothing behind, even a write", () => {
		expect(safeToRetry("select pg_sleep(60)", "postgres")).toBe(true);
		expect(safeToRetry("update t set a = 1", "postgres")).toBe(true);
	});

	test("a script of reads is safe", () => {
		expect(safeToRetry("select 1; select 2", "sqlite")).toBe(true);
	});

	test("a script with a write may already have applied part of itself", () => {
		expect(safeToRetry("insert into t values (1); select 2", "sqlite")).toBe(false);
		expect(safeToRetry("select 1; delete from t where a", "postgres")).toBe(false);
	});
});
