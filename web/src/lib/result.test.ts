import { expect, test } from "bun:test";
import type { ResultSet } from "./api";
import { sameResult, smallResult } from "./result";

const result = (rows: (string | null)[][], elapsedMs = 1): ResultSet => ({
	columns: [{ name: "a", type: "text" }],
	rows,
	rowCount: rows.length,
	rowCountExact: true,
	truncated: false,
	truncatedBy: "rows",
	command: "SELECT",
	elapsedMs,
});

test("the same rows answered at another speed are the same result", () => {
	expect(sameResult(result([["x"], [null]], 1), result([["x"], [null]], 900))).toBe(true);
});

test("one changed cell, even to null, is a different result", () => {
	expect(sameResult(result([["x"]]), result([["y"]]))).toBe(false);
	expect(sameResult(result([["x"]]), result([[null]]))).toBe(false);
});

test("a renamed column is a different result", () => {
	const renamed = { ...result([["x"]]), columns: [{ name: "b", type: "text" }] };
	expect(sameResult(result([["x"]]), renamed)).toBe(false);
});

test("a page of huge cells is too big to remember", () => {
	expect(smallResult(result([["x"]]))).toBe(true);
	expect(smallResult(result([["x".repeat(2_000_001)]]))).toBe(false);
});
