import { expect, test } from "bun:test";
import { initialMode, insertSql, quoteLiteral } from "./insert";

const t = { schema: "public", table: "users" };

const col = { type: "text", default: null, nullable: false, primaryKey: false };

test("a column starts on its default, then null, then a value it must be given", () => {
	expect(initialMode({ ...col, default: "nextval('s')", primaryKey: true }, true)).toBe("default");
	expect(initialMode({ ...col, nullable: true }, false)).toBe("null");
	expect(initialMode(col, false)).toBe("value");
	expect(initialMode({ ...col, nullable: true, primaryKey: true }, true)).toBe("value");
});

test("a lone integer key numbers itself, a key in a composite does not", () => {
	const key = { ...col, type: "INTEGER", primaryKey: true };
	expect(initialMode(key, true)).toBe("default");
	expect(initialMode({ ...key, type: "bigint" }, true)).toBe("default");
	expect(initialMode(key, false)).toBe("value");
});

test("quotes inside a value are doubled", () => {
	expect(quoteLiteral("it's", "postgres")).toBe("'it''s'");
	expect(quoteLiteral("it's", "sqlite")).toBe("'it''s'");
});

test("a backslash takes the escape form on Postgres only", () => {
	expect(quoteLiteral("a\\b'c", "postgres")).toBe("E'a\\\\b''c'");
	expect(quoteLiteral("a\\b", "sqlite")).toBe("'a\\b'");
});

test("columns left to their default are not named", () => {
	const sql = insertSql(
		t,
		[
			{ name: "id", field: { mode: "default", value: "" } },
			{ name: "name", field: { mode: "value", value: "Ada" } },
			{ name: "Note", field: { mode: "null", value: "ignored" } },
		],
		"postgres",
	);
	expect(sql).toBe(`insert into "public"."users" ("name", "Note")\nvalues ('Ada', null)`);
});

test("an empty value is an empty string, not null", () => {
	expect(insertSql(t, [{ name: "a", field: { mode: "value", value: "" } }], "sqlite")).toBe(
		`insert into "public"."users" ("a")\nvalues ('')`,
	);
});

test("a row of defaults takes default values", () => {
	expect(insertSql(t, [{ name: "id", field: { mode: "default", value: "" } }], "sqlite")).toBe(
		`insert into "public"."users" default values`,
	);
	expect(insertSql(t, [], "postgres", true)).toBe(
		`insert into "public"."users" default values\nreturning *`,
	);
});

test("names that need quoting cannot break out", () => {
	const sql = insertSql(
		{ schema: 'we"ird', table: "t" },
		[{ name: 'a"b', field: { mode: "value", value: "1" } }],
		"postgres",
		true,
	);
	expect(sql).toBe(`insert into "we""ird"."t" ("a""b")\nvalues ('1')\nreturning *`);
});
