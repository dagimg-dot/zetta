import { describe, expect, test } from "bun:test";
import {
	categoryOf,
	decodeBuilder,
	dropFilter,
	dropSort,
	encodeBuilder,
	toggleSort,
} from "./query";

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

describe("removing a builder row", () => {
	const applied = {
		match: "all" as const,
		filters: [
			{ c: "status", op: "eq" as const, v: "paid" },
			{ c: "total", op: "gt" as const, v: "10" },
		],
		sorts: [{ c: "id", d: "desc" as const }],
	};

	test("an applied filter comes out of what runs", () => {
		expect(dropFilter(applied, { c: "status", op: "eq", v: "paid" })?.filters).toEqual([
			{ c: "total", op: "gt", v: "10" },
		]);
	});

	test("a filter only in the draft reloads nothing", () => {
		expect(dropFilter(applied, { c: "status", op: "eq", v: "pending" })).toBeNull();
		expect(dropFilter(null, { c: "status", op: "eq", v: "paid" })).toBeNull();
	});

	test("an applied sort comes out, and an unapplied one reloads nothing", () => {
		expect(dropSort(applied, "id")?.sorts).toEqual([]);
		expect(dropSort(applied, "name")).toBeNull();
	});
});
