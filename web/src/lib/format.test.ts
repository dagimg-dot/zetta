import { describe, expect, test } from "bun:test";
import { rowTotal } from "./format";

describe("rowTotal", () => {
	test("an exact count is the count", () => {
		expect(rowTotal(20000, true)).toBe((20000).toLocaleString());
	});

	test("a count that stopped past the limit shows the limit and a plus", () => {
		expect(rowTotal(5001, false)).toBe(`${(5000).toLocaleString()}+`);
	});
});
