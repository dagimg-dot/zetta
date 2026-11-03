import { expect, test } from "bun:test";
import { categoryOf, decodeBuilder, encodeBuilder, toggleSort } from "./query";

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
