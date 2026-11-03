import { describe, expect, test } from "bun:test";
import { hiddenRuns, matchColumns, showOnly } from "./hidden";

describe("hidden runs", () => {
	test("adjacent hidden columns share one stub at the first of them", () => {
		const runs = hiddenRuns([false, true, true, true, false, true, false]);
		expect([...runs]).toEqual([
			[1, [1, 2, 3]],
			[5, [5]],
		]);
	});

	test("nothing hidden is no runs, and everything hidden but one is one run", () => {
		expect(hiddenRuns([false, false]).size).toBe(0);
		expect([...hiddenRuns([true, true, false])]).toEqual([[0, [0, 1]]]);
	});
});

test("search matches the name or the type, ignoring case", () => {
	const cols = [
		{ name: "created_at", type: "timestamptz" },
		{ name: "Email", type: "text" },
		{ name: "id", type: "integer" },
	];
	expect(matchColumns(cols, "EMA").map((c) => c.name)).toEqual(["Email"]);
	expect(matchColumns(cols, "time").map((c) => c.name)).toEqual(["created_at"]);
	expect(matchColumns(cols, "  ")).toHaveLength(3);
});

describe("only matching", () => {
	const all = ["a", "b", "c"];

	test("hides every column the search did not find", () => {
		expect(showOnly(all, ["b"])).toEqual(new Set(["a", "c"]));
	});

	test("does nothing when the search found none, so the grid never goes blank", () => {
		expect(showOnly(all, [])).toBeNull();
	});

	test("a search that finds every column shows them all", () => {
		expect(showOnly(all, ["a", "b", "c"])).toEqual(new Set());
	});
});
