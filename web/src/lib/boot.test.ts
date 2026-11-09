import { beforeEach, expect, test } from "bun:test";
import type { Catalog, Meta } from "./api";
import { loadBoot, sameDatabase, saveBoot } from "./boot";

const store = new Map<string, string>();
Object.assign(globalThis, {
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		removeItem: (k: string) => store.delete(k),
	},
});
beforeEach(() => store.clear());

const meta: Meta = {
	name: "zetta",
	version: "1",
	adapter: "postgres",
	database: "shop",
	readOnly: false,
	capabilities: { schemas: true, approxRows: true },
};
const catalog: Catalog = { schemas: [{ name: "public", tables: [], functions: [] }] };

test("what was saved comes back on the next load", () => {
	saveBoot({ meta, catalog });
	expect(loadBoot()).toEqual({ meta, catalog });
});

test("nothing saved, junk, or an older shape all count as nothing", () => {
	expect(loadBoot()).toBeNull();
	store.set("zetta.boot", "{not json");
	expect(loadBoot()).toBeNull();
	store.set(
		"zetta.boot",
		JSON.stringify({ meta, catalog: { schemas: [{ name: "public", tables: [] }] } }),
	);
	expect(loadBoot()).toBeNull();
});

test("a catalog too long to store also clears the one before it", () => {
	saveBoot({ meta, catalog });
	const name = "x".repeat(600 * 1024);
	saveBoot({ meta, catalog: { schemas: [{ name, tables: [], functions: [] }] } });
	expect(loadBoot()).toBeNull();
});

test("the same database name on another adapter is another database", () => {
	expect(sameDatabase(meta, { ...meta, readOnly: true })).toBe(true);
	expect(sameDatabase(meta, { ...meta, adapter: "sqlite" })).toBe(false);
	expect(sameDatabase(meta, { ...meta, database: "other" })).toBe(false);
});
