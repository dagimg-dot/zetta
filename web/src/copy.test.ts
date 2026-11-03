import { describe, expect, test } from "bun:test";
import { fileName, format, htmlTable, jsonValue, pick, type Rows } from "./copy";

const sample: Rows = {
	columns: [
		{ name: "id", type: "bigint" },
		{ name: "name", type: "text" },
		{ name: "active", type: "boolean" },
		{ name: "meta", type: "jsonb" },
	],
	rows: [
		["9007199254740993", 'Acme, "the" co', "t", '{"tier": "gold", "seats": 12}'],
		["2", "tab\there\nand a line", "f", null],
		["3", "", null, "not json"],
	],
};

const write = (id: Parameters<typeof format>[0], t: Rows = sample) => format(id).write(t);

describe("JSON", () => {
	test("keeps ids past 2^53 digit for digit", () => {
		expect(jsonValue("9007199254740993", "number")).toBe("9007199254740993");
		expect(JSON.parse(write("json")).length).toBe(3);
		expect(write("json")).toContain('"id": 9007199254740993');
	});

	test("numbers that are not JSON numbers become strings", () => {
		expect(jsonValue("NaN", "number")).toBe('"NaN"');
		expect(jsonValue("$1.50", "number")).toBe('"$1.50"');
		expect(jsonValue("007", "number")).toBe('"007"');
		expect(jsonValue("-1.5e+10", "number")).toBe("-1.5e+10");
	});

	test("booleans from Postgres and SQLite become true and false", () => {
		expect(jsonValue("t", "bool")).toBe("true");
		expect(jsonValue("0", "bool")).toBe("false");
		expect(jsonValue("maybe", "bool")).toBe('"maybe"');
	});

	test("JSON columns embed as JSON, and invalid JSON stays a string", () => {
		const rows = JSON.parse(write("json"));
		expect(rows[0].meta).toEqual({ tier: "gold", seats: 12 });
		expect(rows[1].meta).toBeNull();
		expect(rows[2].meta).toBe("not json");
		expect(jsonValue('{\n  "a": "x y"\n}', "json")).toBe('{"a":"x y"}');
	});

	test("one row is an object and none is an empty array", () => {
		const one = pick(sample, [1], [0, 2]);
		expect(JSON.parse(write("json", one))).toEqual({ id: 2, active: false });
		expect(write("json", pick(sample, [], [0]))).toBe("[]");
	});

	test("repeated column names keep both values", () => {
		const t: Rows = {
			columns: [
				{ name: "id", type: "int" },
				{ name: "id", type: "int" },
			],
			rows: [["1", "2"]],
		};
		expect(JSON.parse(write("json", t))).toEqual({ id: 1, id_2: 2 });
	});

	test("JSON lines put each row on one line", () => {
		const lines = write("jsonl").split("\n");
		expect(lines.length).toBe(3);
		expect(JSON.parse(lines[1] as string).name).toBe("tab\there\nand a line");
	});
});

describe("CSV", () => {
	test("quotes commas, quotes and line breaks", () => {
		const lines = write("csv").split("\n");
		expect(lines[0]).toBe("id,name,active,meta");
		expect(lines[1]).toBe(
			'9007199254740993,"Acme, ""the"" co",t,"{""tier"": ""gold"", ""seats"": 12}"',
		);
		expect(lines[2]).toBe('2,"tab\there');
	});

	test("tells NULL from an empty string the way COPY does", () => {
		expect(write("csv").split("\n").at(-1)).toBe('3,"",,not json');
	});
});

describe("TSV", () => {
	test("quotes values holding a tab, quote or line break", () => {
		const t = pick(sample, [0, 1], [1]);
		expect(write("tsv", t)).toBe('name\n"Acme, ""the"" co"\n"tab\there\nand a line"');
	});

	test("leaves plain values and NULL bare", () => {
		expect(write("tsv", pick(sample, [2], [0, 2]))).toBe("id\tactive\n3\t");
	});
});

describe("Markdown", () => {
	test("escapes pipes, breaks lines and right-aligns numbers", () => {
		const t: Rows = {
			columns: [
				{ name: "n", type: "integer" },
				{ name: "s", type: "text" },
			],
			rows: [
				["1", "a|b\nc"],
				["2", null],
			],
		};
		expect(write("markdown", t)).toBe(
			"| n | s |\n| ---: | --- |\n| 1 | a\\|b<br>c |\n| 2 | NULL |",
		);
	});
});

describe("rich copy", () => {
	test("HTML cells are escaped and keep line breaks", () => {
		const html = htmlTable(pick(sample, [1], [1, 3]));
		expect(html).toBe(
			"<table><thead><tr><th>name</th><th>meta</th></tr></thead><tbody><tr><td>tab\there<br>and a line</td><td></td></tr></tbody></table>",
		);
		expect(htmlTable({ columns: [{ name: "<b>", type: "text" }], rows: [] })).toContain(
			"&lt;b&gt;",
		);
	});
});

describe("pick", () => {
	test("keeps only the chosen rows and columns, in order", () => {
		expect(pick(sample, [2, 0], [1, 0]).rows).toEqual([
			["", "3"],
			['Acme, "the" co', "9007199254740993"],
		]);
	});
});

test("file names come from the grid label", () => {
	expect(fileName("public.users", format("csv"))).toBe("public.users.csv");
	expect(fileName("Query result", format("jsonl"))).toBe("Query_result.jsonl");
});
