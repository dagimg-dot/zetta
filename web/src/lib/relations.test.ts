import { describe, expect, test } from "bun:test";
import type { TableInfo, TableKind } from "./api";
import { splitViews, viewsStartOpen } from "./relations";

const rel = (name: string, kind: TableKind): TableInfo => ({ name, kind, approxRows: null });

describe("splitViews", () => {
	test("materialized views count as views and foreign tables as tables", () => {
		const { tables, views } = splitViews([
			rel("a", "view"),
			rel("b", "table"),
			rel("c", "materialized_view"),
			rel("d", "foreign_table"),
		]);
		expect(tables.map((t) => t.name)).toEqual(["b", "d"]);
		expect(views.map((t) => t.name)).toEqual(["a", "c"]);
	});

	test("an empty schema has neither", () => {
		expect(splitViews([])).toEqual({ tables: [], views: [] });
	});
});

describe("viewsStartOpen", () => {
	const mixed = splitViews([rel("orders", "table"), rel("recent", "view")]);

	test("views beside tables start folded", () => {
		expect(viewsStartOpen(mixed, null)).toBe(false);
		expect(viewsStartOpen(mixed, "orders")).toBe(false);
	});

	test("a schema of only views starts open", () => {
		expect(viewsStartOpen(splitViews([rel("recent", "view")]), null)).toBe(true);
	});

	test("the open view keeps its group open", () => {
		expect(viewsStartOpen(mixed, "recent")).toBe(true);
	});
});
