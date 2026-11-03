import { expect, test } from "bun:test";
import { clip, peekParams } from "./peek";
import { decodeBuilder } from "./query";

test("the peek asks browse for up to two rows matching the key exactly", () => {
	const p = peekParams({ schema: "public", table: "users", column: "id", value: "42" });
	expect(p).toMatchObject({ schema: "public", table: "users", limit: 2 });
	expect(decodeBuilder(p.q ?? "")).toEqual({
		match: "all",
		filters: [{ c: "id", op: "eq", v: "42" }],
		sorts: [],
	});
});

test("an empty-string key is still a filter, not no filter", () => {
	const p = peekParams({ schema: "main", table: "t", column: "code", value: "" });
	expect(decodeBuilder(p.q ?? "")?.filters).toEqual([{ c: "code", op: "eq", v: "" }]);
});

test("long values are cut for display only", () => {
	expect(clip("abc")).toBe("abc");
	expect(clip("x".repeat(500))).toHaveLength(401);
});
