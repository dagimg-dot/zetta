import { describe, expect, test } from "bun:test";
import {
	categoryOf,
	compileOrder,
	compileWhere,
	decodeBuilder,
	encodeBuilder,
	toggleSort,
} from "./query";

describe("compileWhere", () => {
	test("values are literals and names are identifiers, whatever is typed", () => {
		expect(
			compileWhere(
				{ match: "all", filters: [{ c: 'we"ird', op: "eq", v: "x' or 1=1 --" }], sorts: [] },
				"postgres",
			),
		).toBe(`"we""ird" = 'x'' or 1=1 --'`);
	});
	test("several filters join with AND or OR and are parenthesised", () => {
		const b = {
			match: "any" as const,
			filters: [
				{ c: "a", op: "gt" as const, v: "1" },
				{ c: "b", op: "is_null" as const, v: "" },
			],
			sorts: [],
		};
		expect(compileWhere(b, "sqlite")).toBe(`("a" > '1') OR ("b" IS NULL)`);
	});
	test("incomplete rows are skipped rather than sent", () => {
		expect(
			compileWhere({ match: "all", filters: [{ c: "a", op: "eq", v: "" }], sorts: [] }, "sqlite"),
		).toBe("");
	});
	test("contains escapes LIKE wildcards and is case-insensitive on Postgres", () => {
		expect(
			compileWhere(
				{ match: "all", filters: [{ c: "n", op: "contains", v: "50%_off" }], sorts: [] },
				"postgres",
			),
		).toBe(`"n"::text ILIKE '%50\\%\\_off%' ESCAPE '\\'`);
	});
	test("is one of splits on commas", () => {
		expect(
			compileWhere(
				{ match: "all", filters: [{ c: "s", op: "in", v: "paid, shipped," }], sorts: [] },
				"sqlite",
			),
		).toBe(`"s" IN ('paid', 'shipped')`);
	});
	test("booleans follow the dialect", () => {
		expect(
			compileWhere(
				{ match: "all", filters: [{ c: "x", op: "is_true", v: "" }], sorts: [] },
				"postgres",
			),
		).toBe(`"x" IS TRUE`);
		expect(
			compileWhere(
				{ match: "all", filters: [{ c: "x", op: "is_true", v: "" }], sorts: [] },
				"sqlite",
			),
		).toBe(`"x" = 1`);
	});
});

test("order joins sort keys in priority order", () => {
	expect(
		compileOrder({
			match: "all",
			filters: [],
			sorts: [
				{ c: "b", d: "desc" },
				{ c: "a", d: "asc" },
			],
		}),
	).toBe(`"b" desc, "a" asc`);
});

test("header clicks cycle a column, shift adds a secondary key", () => {
	expect(toggleSort([], "a", false)).toEqual([{ c: "a", d: "asc" }]);
	expect(toggleSort([{ c: "a", d: "asc" }], "a", false)).toEqual([{ c: "a", d: "desc" }]);
	expect(toggleSort([{ c: "a", d: "desc" }], "a", false)).toEqual([]);
	expect(toggleSort([{ c: "a", d: "asc" }], "b", true)).toEqual([
		{ c: "a", d: "asc" },
		{ c: "b", d: "asc" },
	]);
	expect(toggleSort([{ c: "a", d: "asc" }], "b", false)).toEqual([{ c: "b", d: "asc" }]);
});

test("the builder survives the URL and junk does not", () => {
	const b = {
		match: "any" as const,
		filters: [{ c: "a", op: "eq" as const, v: "1" }],
		sorts: [{ c: "a", d: "desc" as const }],
	};
	expect(decodeBuilder(encodeBuilder(b))).toEqual(b);
	expect(decodeBuilder("{not json")).toBeNull();
	expect(decodeBuilder('{"filters":[{"c":"a","op":"drop table"}]}')?.filters).toEqual([]);
});

test("column types map to operator families", () => {
	expect(categoryOf("integer")).toBe("number");
	expect(categoryOf("timestamp with time zone")).toBe("time");
	expect(categoryOf("character varying(255)")).toBe("text");
	expect(categoryOf("jsonb")).toBe("json");
	expect(categoryOf("boolean")).toBe("bool");
	expect(categoryOf("point")).toBe("other");
});
