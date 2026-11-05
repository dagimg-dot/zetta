import { describe, expect, test } from "bun:test";
import type { Adapter } from "./api";
import { highlightHtml, highlightLines } from "./sql-highlight";

/** The words drawn as keywords. */
function keywords(text: string, dialect: Adapter): string[] {
	return [...highlightHtml(text, dialect).matchAll(/<span class="tk-k">([^<]*)<\/span>/g)].map(
		(m) => m[1] ?? "",
	);
}

describe("keywords", () => {
	test("reserved words are keywords, and names that happen to be unreserved keywords are not", () => {
		expect(
			keywords("select name, type, data, key, value from items where id is not null", "postgres"),
		).toEqual(["select", "from", "where", "is", "not", "null"]);
	});

	test("type and column keywords count in Postgres, such as integer and coalesce", () => {
		expect(keywords("create table t (n integer default coalesce(1, 2))", "postgres")).toEqual([
			"create",
			"table",
			"integer",
			"default",
			"coalesce",
		]);
	});

	test("clause words count unless called like a function", () => {
		expect(keywords("insert into t values (replace('a', 'b', 'c'))", "postgres")).toEqual([
			"insert",
			"into",
			"values",
		]);
		expect(keywords("explain analyze select 1", "postgres")).toEqual([
			"explain",
			"analyze",
			"select",
		]);
	});

	test("a word next to a dot is part of a name", () => {
		expect(keywords("select t.order, public.user from public.t", "postgres")).toEqual([
			"select",
			"from",
		]);
	});

	test("each dialect uses its own list", () => {
		expect(keywords("pragma table_info(t)", "sqlite")).toEqual(["pragma"]);
		expect(keywords("pragma table_info(t)", "postgres")).toEqual([]);
		expect(keywords("select * from t limit 1", "sqlite")).toEqual(["select", "from", "limit"]);
	});
});

describe("lines", () => {
	test("tokens get their colour class, and markup in the text is escaped", () => {
		expect(highlightLines(`'a<b' "c" 1 $1 -- d & e`, "postgres")).toEqual([
			`<span class="tk-s">'a&lt;b'</span> <span class="tk-q">"c"</span> <span class="tk-n">1</span> <span class="tk-p">$1</span> <span class="tk-c">-- d &amp; e</span>`,
		]);
	});

	test("a token that spans lines is cut at each newline, and a final newline makes an empty line", () => {
		expect(highlightLines("/* a\nb */ x\n", "postgres")).toEqual([
			`<span class="tk-c">/* a</span>`,
			`<span class="tk-c">b */</span> x`,
			"",
		]);
	});

	test("the error range marks every token it touches, not the space between", () => {
		expect(highlightLines("select foo bar", "postgres", { error: [7, 14] })).toEqual([
			`<span class="tk-k">select</span> <span class="tk-err">foo</span> <span class="tk-err">bar</span>`,
		]);
	});

	test("the lines hold exactly the text", () => {
		const text = "select 1;\n\n  -- note\nselect 'x\ny' from t";
		const plain = highlightLines(text, "postgres").map((l) =>
			l
				.replace(/<[^>]+>/g, "")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&"),
		);
		expect(plain.join("\n")).toBe(text);
	});
});
