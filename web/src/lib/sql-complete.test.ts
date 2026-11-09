import { describe, expect, test } from "bun:test";
import type { Adapter, Column } from "./api";
import { type CatalogView, complete, quoteName, rank } from "./sql-complete";

const col = (name: string, type = "text"): Column => ({
	name,
	type,
	nullable: true,
	primaryKey: false,
	default: null,
});

function catalog(defaultSchema: string): CatalogView {
	const columns: Record<string, Column[]> = {
		[`${defaultSchema}.customers`]: [
			col("id", "integer"),
			col("name"),
			col("email"),
			col("CreatedAt", "timestamp"),
		],
		[`${defaultSchema}.orders`]: [
			col("id", "integer"),
			col("customer_id", "integer"),
			col("total", "numeric"),
		],
		"audit.events": [col("kind"), col("at", "timestamp")],
	};
	return {
		defaultSchema,
		schemas: [
			{
				name: defaultSchema,
				tables: [
					{ name: "customers", kind: "table", approxRows: 3 },
					{ name: "orders", kind: "table", approxRows: 9 },
					{ name: "top_customers", kind: "view", approxRows: null },
				],
				functions: [],
			},
			{ name: "audit", tables: [{ name: "events", kind: "table", approxRows: 1 }], functions: [] },
		],
		columns: (s, t) => columns[`${s}.${t}`],
	};
}

const pg = catalog("public");

/** The labels offered with the caret at `|`, best first. */
function offered(
	textWithCaret: string,
	dialect: Adapter = "postgres",
	cat = pg,
	explicit = true,
): string[] {
	const caret = textWithCaret.indexOf("|");
	const text = textWithCaret.replace("|", "");
	const c = complete(text, caret, dialect, cat, explicit);
	return c ? rank(c.candidates, c.typed).map((r) => r.label) : [];
}

describe("quoting", () => {
	test("Postgres quotes what case folding or a keyword would change", () => {
		expect(quoteName("customers", "postgres")).toBe("customers");
		expect(quoteName("CreatedAt", "postgres")).toBe('"CreatedAt"');
		expect(quoteName("order", "postgres")).toBe('"order"');
		expect(quoteName("name", "postgres")).toBe("name");
		expect(quoteName("integer", "postgres")).toBe('"integer"');
		expect(quoteName('we"ird', "postgres")).toBe('"we""ird"');
		expect(quoteName("a$b", "postgres")).toBe('"a$b"');
	});

	test("SQLite quotes only reserved words and names that are not plain", () => {
		expect(quoteName("CreatedAt", "sqlite")).toBe("CreatedAt");
		expect(quoteName("order", "sqlite")).toBe('"order"');
		expect(quoteName("key", "sqlite")).toBe("key");
		expect(quoteName("two words", "sqlite")).toBe('"two words"');
	});
});

describe("what comes after a dot", () => {
	test("an alias gives its table's columns, from a FROM after the caret too", () => {
		expect(offered("select c.| from customers c")).toEqual(["id", "name", "email", "CreatedAt"]);
		expect(offered("select c.na| from customers as c")).toEqual(["name"]);
	});

	test("a table name gives its columns, and a schema gives its tables", () => {
		expect(offered("select orders.| from orders")).toEqual(["id", "customer_id", "total"]);
		expect(offered("select * from audit.|")).toEqual(["events"]);
		expect(offered("select audit.events.| from audit.events")).toEqual(["kind", "at"]);
	});

	test("a mixed-case column is inserted quoted", () => {
		const c = complete("select c.Cre from customers c", 12, "postgres", pg, true);
		expect(c && rank(c.candidates, c.typed)[0]?.insert).toBe('"CreatedAt"');
		expect(c?.from).toBe(9);
	});
});

describe("what comes after FROM and JOIN", () => {
	test("tables of the default schema first, then other schemas and their tables qualified", () => {
		expect(offered("select * from |")).toEqual([
			"customers",
			"orders",
			"top_customers",
			"audit",
			"audit.events",
		]);
		expect(offered("select * from orders o join cu|")).toEqual(["customers", "top_customers"]);
	});

	test("typing opens it only with a word, or right after a relation keyword", () => {
		expect(offered("select * from |", "postgres", pg, false).length).toBeGreaterThan(0);
		expect(offered("select |", "postgres", pg, false)).toEqual([]);
		expect(offered("select na| from customers", "postgres", pg, false)).toEqual(["name"]);
	});
});

describe("columns, keywords and statements", () => {
	test("columns of the tables in scope come before keywords in an expression", () => {
		const labels = offered("select | from customers");
		expect(labels.slice(0, 4)).toEqual(["id", "name", "email", "CreatedAt"]);
		expect(labels).toContain("distinct");
	});

	test("after a finished expression, keywords come first", () => {
		expect(offered("select name f| from customers")[0]).toBe("from");
	});

	test("an empty statement offers statement keywords, matching typed case", () => {
		expect(offered("sel|")).toEqual(["select"]);
		expect(offered("SEL|")).toEqual(["SELECT"]);
		expect(offered("select 1; up|")).toEqual(["update"]);
	});

	test("INSERT INTO t ( names t's columns", () => {
		expect(offered("insert into orders (|")).toEqual(["id", "customer_id", "total"]);
	});

	test("each dialect offers only its own keywords", () => {
		expect(offered("prag|", "sqlite", catalog("main"))).toEqual(["pragma"]);
		expect(offered("prag|")).toEqual([]);
	});
});

describe("where nothing completes", () => {
	test("strings, comments and numbers", () => {
		expect(offered("select 'cus|'")).toEqual([]);
		expect(offered("select 1 -- cus|")).toEqual([]);
		expect(offered("select 12|")).toEqual([]);
	});

	test("missing columns are reported so they can be fetched", () => {
		const cat: CatalogView = { ...pg, columns: () => undefined };
		const c = complete("select c. from customers c", 9, "postgres", cat, true);
		expect(c?.missing).toEqual([{ schema: "public", table: "customers" }]);
	});
});
