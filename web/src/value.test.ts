import { describe, expect, test } from "bun:test";
import { closest, errorRange, hexDump, isWrite, kindOf, unknownColumn } from "./value";

describe("kindOf", () => {
	test("tells blobs, JSON and multi-line text apart", () => {
		expect(kindOf(null)).toBe("null");
		expect(kindOf("\\xdeadbeef")).toBe("blob");
		expect(kindOf('{"a":1}')).toBe("json");
		expect(kindOf("a\nb")).toBe("multiline");
		expect(kindOf("{not json")).toBe("text");
	});

	test("text shaped like a blob stays text when its column says so", () => {
		expect(kindOf("\\x41", "text")).toBe("text");
		expect(kindOf("\\x41", "bytea")).toBe("blob");
		expect(kindOf("\\x41", "BLOB")).toBe("blob");
		expect(kindOf("\\x41", "")).toBe("blob");
	});
});

describe("did you mean", () => {
	test("finds the column in both databases' messages", () => {
		expect(unknownColumn("no such column: balanc")).toBe("balanc");
		// Builder queries quote names, and SQLite then quotes them back in the message.
		expect(
			unknownColumn('no such column: "balanc" - should this be a string literal in single-quotes?'),
		).toBe("balanc");
		expect(unknownColumn('column "c.balanc" does not exist')).toBe("balanc");
		expect(closest("balanc", ["id", "name", "balance"])).toBe("balance");
		expect(closest("zzz", ["id", "name"])).toBeNull();
	});
});

describe("errorRange", () => {
	test("follows the Postgres caret onto the right line", () => {
		const sql = "select 1;\nselec 2";
		const msg = 'syntax error at or near "selec"\nLINE 2: selec 2\n        ^';
		expect(errorRange(sql, msg)).toEqual([10, 15]);
	});
	test("finds SQLite's near token", () => {
		expect(errorRange("selec 1", 'near "selec": syntax error')).toEqual([0, 5]);
	});
});

describe("isWrite", () => {
	test("flags any statement that changes data, ignoring comments", () => {
		expect(isWrite("select 1")).toBe(false);
		expect(isWrite("select 1; update t set x = 1")).toBe(true);
		expect(isWrite("-- delete everything\nselect 1")).toBe(false);
	});
});

test("hexDump groups bytes with offsets", () => {
	expect(hexDump("\\x0011223344")).toBe("000000  0011 2233 44");
});
