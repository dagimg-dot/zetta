import { describe, expect, test } from "bun:test";
import type { Catalog, TableKind } from "./api";
import { sqlName, starterSql } from "./starter";

const catalog = (schemas: Record<string, [string, TableKind][]>): Catalog => ({
	schemas: Object.entries(schemas).map(([name, tables]) => ({
		name,
		tables: tables.map(([t, kind]) => ({ name: t, kind, approxRows: null })),
	})),
});

const none = { schema: null, table: null };

describe("starter query", () => {
	test("uses the table open in the Data tab", () => {
		const c = catalog({ public: [["users", "table"]], audit: [["log", "table"]] });
		expect(starterSql(c, "postgres", { schema: "audit", table: "log" })).toBe(
			"select * from audit.log limit 10",
		);
	});

	test("otherwise the first table in the default schema, before views and other schemas", () => {
		const c = catalog({
			audit: [["log", "table"]],
			public: [
				["v", "view"],
				["users", "table"],
			],
		});
		expect(starterSql(c, "postgres", none)).toBe("select * from users limit 10");
		const lite = catalog({ main: [["notes", "table"]] });
		expect(starterSql(lite, "sqlite", none)).toBe("select * from notes limit 10");
	});

	test("falls back to any table, and to nothing when there are none", () => {
		expect(starterSql(catalog({ auth: [["users", "table"]] }), "postgres", none)).toBe(
			"select * from auth.users limit 10",
		);
		expect(starterSql(catalog({ public: [] }), "postgres", none)).toBeNull();
		expect(starterSql(undefined, "postgres", none)).toBeNull();
	});
});

test("names are quoted when they are not plain lowercase words, or are reserved", () => {
	expect(sqlName("users")).toBe("users");
	expect(sqlName("user")).toBe('"user"');
	expect(sqlName("order")).toBe('"order"');
	expect(sqlName("Users")).toBe('"Users"');
	expect(sqlName("my table")).toBe('"my table"');
	expect(sqlName('a"b')).toBe('"a""b"');
	expect(sqlName("ünïcode")).toBe('"ünïcode"');
	expect(sqlName("2fa")).toBe('"2fa"');
});
