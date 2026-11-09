import { afterEach, expect, test } from "bun:test";
import { catalogView, loadColumns, setCatalog } from "./catalog";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Answers every columns request with one column named after the table, counting the calls. */
function stubColumns(): { calls: string[]; settle: () => Promise<void> } {
	const calls: string[] = [];
	const pending: (() => void)[] = [];
	globalThis.fetch = ((url: string) => {
		calls.push(url);
		const table = new URL(url, "http://x").searchParams.get("table") ?? "";
		return new Promise<Response>((resolve) => {
			pending.push(() =>
				resolve(
					new Response(
						JSON.stringify({
							columns: [
								{
									name: `${table}_id`,
									type: "integer",
									nullable: false,
									primaryKey: true,
									default: null,
								},
							],
						}),
					),
				),
			);
		});
	}) as typeof fetch;
	return {
		calls,
		settle: async () => {
			for (const go of pending.splice(0)) go();
			await new Promise((r) => setTimeout(r, 0));
		},
	};
}

test("columns are fetched once per table and read back when they arrive", async () => {
	const stub = stubColumns();
	setCatalog({
		schemas: [
			{ name: "public", tables: [{ name: "t", kind: "table", approxRows: 1 }], functions: [] },
		],
	});
	expect(catalogView().columns("public", "t")).toBeUndefined();
	loadColumns("public", "t");
	loadColumns("public", "t");
	expect(stub.calls.length).toBe(1);
	await stub.settle();
	expect(
		catalogView()
			.columns("public", "t")
			?.map((c) => c.name),
	).toEqual(["t_id"]);
	loadColumns("public", "t");
	expect(stub.calls.length).toBe(1);
});

test("a new catalog forgets columns, and an answer for the old one is dropped", async () => {
	const stub = stubColumns();
	setCatalog({ schemas: [] });
	loadColumns("public", "a");
	setCatalog({ schemas: [] });
	await stub.settle();
	expect(catalogView().columns("public", "a")).toBeUndefined();
});
