import { describe, expect, test } from "bun:test";
import type { Adapter, Column, SchemaInfo } from "./api";
import { type CatalogView, complete, enterAccepts, quoteName, rank } from "./sql-complete";

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

const offeredTop = (textWithCaret: string) => offered(textWithCaret)[0];

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

describe("where a new name goes", () => {
	test("nothing is offered after AS, or after a cast", () => {
		expect(offered("select id as n| from customers")).toEqual([]);
		expect(offered("select * from customers as c|")).toEqual([]);
		expect(offered("select cast(id as in|) from customers")).toEqual([]);
		expect(offered("select id::|")).toEqual([]);
		expect(offered("select birthday::d| from customers")).toEqual([]);
	});

	test("one letter after a table is an alias, so no list opens for it", () => {
		expect(offered("select * from customers u|", "postgres", pg, false)).toEqual([]);
		expect(offered("select * from audit.events u|", "postgres", pg, false)).toEqual([]);
		expect(offered("select * from (select 1) u|", "postgres", pg, false)).toEqual([]);
		expect(offered("select * from orders o join customers u|", "postgres", pg, false)).toEqual([]);
	});

	test("after a table, longer words are offered only the clauses they begin", () => {
		expect(offered("select * from customers wh|", "postgres", pg, false)).toEqual(["where"]);
		expect(offered("select * from customers cu|", "postgres", pg, false)).toEqual([]);
		expect(offered("update customers se|", "postgres", pg, false)).toEqual(["set"]);
	});

	test("what comes after an alias is not one", () => {
		expect(offered("select * from customers c w|", "postgres", pg, false)[0]).toBe("where");
	});
});

describe("words that only look like they take a table", () => {
	test("FROM inside a function call takes a value", () => {
		for (const text of [
			"select extract(year from |) from customers",
			"select trim(both from |) from customers",
			"select substring(name from |) from customers",
		]) {
			const labels = offered(text);
			expect(labels).toContain("name");
			expect(labels).not.toContain("orders");
		}
	});

	test("a subquery inside such a call still takes a table", () => {
		expect(offered("select extract(year from (select at from |))")).toContain("orders");
	});

	test("IS DISTINCT FROM takes a value", () => {
		const labels = offered("select * from customers where name is distinct from |");
		expect(labels).toContain("email");
		expect(labels).not.toContain("orders");
		expect(offered("select * from customers where name is not distinct from |")).not.toContain(
			"orders",
		);
	});

	test("COPY and REVOKE have no table after FROM", () => {
		expect(offered("copy customers from |")).not.toContain("orders");
		expect(offered("revoke select on customers from |")).not.toContain("orders");
	});

	test("UPDATE outside the start of a statement takes no table", () => {
		expect(offered("select * from customers for update |")).not.toContain("orders");
		expect(offered("insert into orders values (1) on conflict do update |")).not.toContain(
			"customers",
		);
		expect(offered("insert into orders values (1) on conflict do update se|")).toEqual(["set"]);
	});

	test("a real UPDATE still takes a table, after WITH and EXPLAIN too", () => {
		expect(offered("update |")).toContain("orders");
		expect(offered("with x as (select 1) update |")).toContain("orders");
		expect(offered("explain update |")).toContain("orders");
	});

	test("the name after IS DISTINCT FROM is not read as a table in scope", () => {
		expect(offered("select | from customers where name is distinct from y z")).not.toContain("z");
	});
});

describe("what Enter takes", () => {
	/** Whether Enter takes the top item with the caret at `|`. */
	function enter(
		textWithCaret: string,
		opts: { moved?: boolean; explicit?: boolean; dialect?: Adapter } = {},
	): boolean {
		const caret = textWithCaret.indexOf("|");
		const text = textWithCaret.replace("|", "");
		const explicit = opts.explicit ?? false;
		const c = complete(text, caret, opts.dialect ?? "postgres", pg, explicit);
		const pick = c && rank(c.candidates, c.typed)[0];
		if (!c || !pick) return false;
		return enterAccepts(c, pick, text.slice(c.from, c.to), {
			moved: opts.moved ?? false,
			explicit,
		});
	}

	test("a name that continues what was typed", () => {
		expect(enter("select * from cust|")).toBe(true);
		expect(enter("sel|")).toBe(true);
	});

	test("not a guess from the middle of a name, unless it was chosen", () => {
		const text = "select cid| from orders";
		expect(offeredTop(text)).toBe("customer_id");
		expect(enter(text)).toBe(false);
		expect(enter(text, { moved: true })).toBe(true);
	});

	test("not what was typed in another case", () => {
		expect(enter("select * From|")).toBe(false);
		expect(enter("select * from CUSTOMERS|")).toBe(false);
	});

	test("a mixed-case name that needs its quotes, since without them it fails", () => {
		expect(enter("select CreatedAt| from customers")).toBe(true);
	});

	test("not over a function name that happens to begin a column", () => {
		const cat: CatalogView = {
			...pg,
			columns: () => [col("country"), col("name")],
		};
		const c = complete("select count from customers", 12, "postgres", cat, false);
		const pick = c && rank(c.candidates, c.typed)[0];
		expect(pick?.label).toBe("country");
		expect(c && pick && enterAccepts(c, pick, "count", { moved: false, explicit: false })).toBe(
			false,
		);
	});

	test("a function the database defines counts too", () => {
		const cat: CatalogView = {
			...pg,
			schemas: pg.schemas.map((s) =>
				s.name === "public"
					? { ...s, functions: [{ name: "name_of" } as SchemaInfo["functions"][number]] }
					: s,
			),
			columns: () => [col("name_of_user")],
		};
		const c = complete("select name_of from customers", 14, "postgres", cat, false);
		const pick = c && rank(c.candidates, c.typed)[0];
		expect(c && pick && enterAccepts(c, pick, "name_of", { moved: false, explicit: false })).toBe(
			false,
		);
	});

	test("not an alias that begins a keyword, though a list asked for or moved in may", () => {
		expect(enter("select * from customers us|")).toBe(false);
		expect(enter("select * from customers us|", { explicit: true })).toBe(true);
		expect(enter("select * from customers us|", { moved: true })).toBe(true);
	});

	test("not the first table when nothing was typed, unless the list was asked for", () => {
		expect(enter("select * from |")).toBe(false);
		expect(enter("select * from |", { explicit: true })).toBe(true);
		expect(enter("select * from |", { moved: true })).toBe(true);
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
