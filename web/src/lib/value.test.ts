import { describe, expect, test } from "bun:test";
import { edges, hexDump, isNumericType, kindOf, markOf } from "./value";

describe("kindOf", () => {
	test("tells blobs, JSON and multi-line text apart", () => {
		expect(kindOf(null)).toBe("null");
		expect(kindOf("\\xdeadbeef")).toBe("blob");
		expect(kindOf('{"a":1}')).toBe("json");
		expect(kindOf("a\nb")).toBe("multiline");
		expect(kindOf("{not json")).toBe("text");
	});

	test("empty and whitespace-only text are kinds of their own, apart from NULL", () => {
		expect(kindOf("")).toBe("empty");
		expect(kindOf(" ")).toBe("blank");
		expect(kindOf("\t \n ")).toBe("blank");
		expect(kindOf(" a ")).toBe("text");
	});

	test("text shaped like a blob stays text when its column says so", () => {
		expect(kindOf("\\x41", "text")).toBe("text");
		expect(kindOf("\\x41", "bytea")).toBe("blob");
		expect(kindOf("\\x41", "BLOB")).toBe("blob");
		expect(kindOf("\\x41", "")).toBe("blob");
	});
});

describe("edges", () => {
	test("splits off leading and trailing spaces and tabs", () => {
		expect(edges("  abc\t")).toEqual({ lead: "  ", body: "abc", trail: "\t" });
		expect(edges("abc")).toEqual({ lead: "", body: "abc", trail: "" });
		expect(edges("a  b")).toEqual({ lead: "", body: "a  b", trail: "" });
	});

	test("whitespace-only text is all lead", () => {
		expect(edges("   ")).toEqual({ lead: "   ", body: "", trail: "" });
		expect(edges("")).toEqual({ lead: "", body: "", trail: "" });
	});

	test("line breaks stay in the body, so only the first and last lines get marks", () => {
		expect(edges(" a \n b ")).toEqual({ lead: " ", body: "a \n b", trail: " " });
		expect(edges("a \n")).toEqual({ lead: "", body: "a \n", trail: "" });
		expect(edges("  \n  ")).toEqual({ lead: "  ", body: "\n", trail: "  " });
	});

	test("a long run between words stays linear", () => {
		const v = `a${" ".repeat(200_000)}b`;
		expect(edges(v).body).toBe(v);
	});
});

test("only number types are right-aligned, not ones that start like them", () => {
	for (const t of ["integer", "int8", "numeric(10,2)", "double precision", "float8", "REAL"])
		expect(isNumericType(t)).toBe(true);
	for (const t of ["interval", "int4range", "inet", "text"]) expect(isNumericType(t)).toBe(false);
});

test("hexDump groups bytes with offsets", () => {
	expect(hexDump("\\x0011223344")).toBe("000000  0011 2233 44");
});

test("NULL, empty, blank and blob values draw as marks, other text as itself", () => {
	expect(markOf(null)).toBe("NULL");
	expect(markOf("")).toBe("empty");
	expect(markOf("   ")).toBe("blank · 3 chars");
	expect(markOf("\t")).toBe("blank · 1 char");
	expect(markOf("\\xdeadbeef", "bytea")).toBe("blob · 4 B");
	expect(markOf("\\x41", "text")).toBeNull();
	expect(markOf(" a ")).toBeNull();
});
