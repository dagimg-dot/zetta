import { describe, expect, test } from "bun:test";
import type { Adapter } from "./api";
import { type LexOptions, lex } from "./sql-lex";

/** Each token that is not whitespace, as `kind:text`. */
function parts(text: string, dialect: Adapter, options?: LexOptions): string[] {
	return lex(text, dialect, options)
		.filter((t) => t.kind !== "space")
		.map((t) => `${t.kind}:${text.slice(t.start, t.end)}`);
}

test("tokens cover the text end to end in both dialects", () => {
	const text = "select a.\"b\", 'c' -- d\n/* e */ from t where x >= $1 and y = ?";
	for (const dialect of ["postgres", "sqlite"] as const) {
		const tokens = lex(text, dialect);
		expect(tokens.map((t) => text.slice(t.start, t.end)).join("")).toBe(text);
		for (let i = 1; i < tokens.length; i++) expect(tokens[i]?.start).toBe(tokens[i - 1]?.end ?? -1);
	}
});

describe("postgres", () => {
	test("comments nest, and a line comment stops at the newline", () => {
		expect(parts("/* a /* b */ c */ x -- y\nz", "postgres")).toEqual([
			"comment:/* a /* b */ c */",
			"word:x",
			"comment:-- y",
			"word:z",
		]);
	});

	test("dollar quotes need the same tag to close, and a tag may hold digits", () => {
		expect(parts("$tag$x$$y;$tag$ $fn1$ ; $fn1$", "postgres")).toEqual([
			"string:$tag$x$$y;$tag$",
			"string:$fn1$ ; $fn1$",
		]);
		expect(parts("$1 a$b$c", "postgres")).toEqual(["param:$1", "word:a$b$c"]);
	});

	test("E strings take backslash escapes; plain strings only with standard strings off", () => {
		expect(parts("E'a\\'b' 'c\\' 'd'", "postgres")).toEqual([
			"string:E'a\\'b'",
			"string:'c\\'",
			"string:'d'",
		]);
		expect(parts("'c\\' d'", "postgres", { standardStrings: false })).toEqual(["string:'c\\' d'"]);
	});

	test("prefixed strings and Unicode names are one token, but N is NCHAR's word", () => {
		expect(parts(`B'101' X'1F' N'n' U&'d\\0061t' U&"d\\0061t" "a""b"`, "postgres")).toEqual([
			"string:B'101'",
			"string:X'1F'",
			"word:N",
			"string:'n'",
			"string:U&'d\\0061t'",
			'name:U&"d\\0061t"',
			'name:"a""b"',
		]);
	});

	test("bit strings do not double quotes", () => {
		expect(parts("B'1''0'", "postgres")).toEqual(["string:B'1'", "string:'0'"]);
	});

	test("a string continues across a newline, comments allowed, in the same escape mode", () => {
		expect(parts("'a'\n  'b' 'c'", "postgres")).toEqual(["string:'a'\n  'b'", "string:'c'"]);
		expect(parts("'a' -- note\n'b'", "postgres")).toEqual(["string:'a' -- note\n'b'"]);
		// An E string's continuation keeps escapes, so \' does not end it.
		expect(parts("E'a'\n'\\'; still'", "postgres")).toEqual(["string:E'a'\n'\\'; still'"]);
	});

	test("a line comment also ends at a carriage return", () => {
		expect(parts("-- a\rselect", "postgres")).toEqual(["comment:-- a", "word:select"]);
	});

	test("letters glued to a number or parameter are one bad token, as the server sees it", () => {
		expect(parts("123abc 0x1Fg 1_ 1e 1e+ $1abc", "postgres")).toEqual([
			"number:123abc",
			"number:0x1Fg",
			"number:1_",
			"number:1e",
			"number:1e+",
			"param:$1abc",
		]);
		expect(parts("0x 1__2", "postgres")).toEqual(["number:0x", "number:1__2"]);
	});

	test("numbers take underscores, radix prefixes, decimals and exponents", () => {
		expect(parts("1_000 0x1F 0o17 0b101 1.5 .5 1e-3 1..10", "postgres")).toEqual([
			"number:1_000",
			"number:0x1F",
			"number:0o17",
			"number:0b101",
			"number:1.5",
			"number:.5",
			"number:1e-3",
			"number:1",
			"punct:..",
			"number:10",
		]);
	});

	test("an operator ending in + or - splits unless it holds a sign character", () => {
		expect(parts("a=-1", "postgres")).toEqual(["word:a", "operator:=", "operator:-", "number:1"]);
		expect(parts("a @- b", "postgres")).toEqual(["word:a", "operator:@-", "word:b"]);
		expect(parts("a<--b", "postgres")).toEqual(["word:a", "operator:<", "comment:--b"]);
		expect(parts("x::int", "postgres")).toEqual(["word:x", "punct:::", "word:int"]);
		expect(parts("f(a := 1, b => 2)", "postgres")).toEqual([
			"word:f",
			"punct:(",
			"word:a",
			"punct::=",
			"number:1",
			"punct:,",
			"word:b",
			"operator:=>",
			"number:2",
			"punct:)",
		]);
	});

	test("an unclosed string or comment runs to the end and says so", () => {
		const tokens = lex("select 'abc; select 1", "postgres");
		expect(tokens.at(-1)).toEqual({ kind: "string", start: 7, end: 21, open: true });
		expect(lex("/* a /* b */", "postgres").at(-1)?.open).toBe(true);
	});

	test("non-ASCII letters are part of names", () => {
		expect(parts("select ስም from ተጠቃሚ", "postgres")).toEqual([
			"word:select",
			"word:ስም",
			"word:from",
			"word:ተጠቃሚ",
		]);
	});
});

describe("sqlite", () => {
	test("names quote three ways, and comments do not nest", () => {
		expect(parts('"a""b" `c``d` [e f] /* x /* y */ z', "sqlite")).toEqual([
			'name:"a""b"',
			"name:`c``d`",
			"name:[e f]",
			"comment:/* x /* y */",
			"word:z",
		]);
	});

	test("parameters take all six forms, and $name stops at ::", () => {
		expect(parts("? ?12 :a @b #d $c $a::b", "sqlite")).toEqual([
			"param:?",
			"param:?12",
			"param::a",
			"param:@b",
			"param:#d",
			"param:$c",
			"param:$a",
			"punct::",
			"param::b",
		]);
	});

	test("blobs, hex numbers, separators and the JSON operators", () => {
		expect(parts("X'00ff' 0x1F 1_000 a->>'$.b' a->b c||d", "sqlite")).toEqual([
			"string:X'00ff'",
			"number:0x1F",
			"number:1_000",
			"word:a",
			"operator:->>",
			"string:'$.b'",
			"word:a",
			"operator:->",
			"word:b",
			"word:c",
			"operator:||",
			"word:d",
		]);
	});

	test("a blob does not double quotes, and a bad blob runs to the next quote", () => {
		expect(parts("x'ab''cd'", "sqlite")).toEqual(["string:x'ab'", "string:'cd'"]);
		expect(parts("x'abc' 1", "sqlite")).toEqual(["string:x'abc'", "number:1"]);
		expect(parts("x'zz;' 1", "sqlite")).toEqual(["string:x'zz;'", "number:1"]);
	});

	test("numbers follow tokenize.c: 0x needs a digit, 1..2 is two floats, letters are junk", () => {
		expect(parts("0x 0x_1 1..2 123abc 1_000 1e", "sqlite")).toEqual([
			"number:0x",
			"number:0x_1",
			"number:1.",
			"number:.2",
			"number:123abc",
			"number:1_000",
			"number:1e",
		]);
	});

	test("a backslash does not escape and E'' is not a Postgres string", () => {
		expect(parts("'a\\' E'b'", "sqlite")).toEqual(["string:'a\\'", "word:E", "string:'b'"]);
	});
});
