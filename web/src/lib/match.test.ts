import { describe, expect, test } from "bun:test";
import { match, Tier } from "./match";

const tier = (typed: string, name: string) => match(typed, name)?.tier ?? null;

describe("match", () => {
	test("tiers run exact, prefix, word run, initials, scattered", () => {
		expect(tier("orders", "orders")).toBe(Tier.Exact);
		expect(tier("ORD", "orders")).toBe(Tier.Prefix);
		expect(tier("id", "customer_id")).toBe(Tier.WordRun);
		expect(tier("ci", "customer_id")).toBe(Tier.Initials);
		expect(tier("cud", "customer_id")).toBe(Tier.Scattered);
	});

	test("the first letter must start a word", () => {
		expect(tier("ust", "customer")).toBeNull();
		expect(tier("ord", "border")).toBeNull();
		expect(tier("cu", "scuba")).toBeNull();
	});

	test("underscores, digits and case steps start words", () => {
		expect(tier("ca", "created_at")).toBe(Tier.Initials);
		expect(tier("2", "address2")).toBe(Tier.WordRun);
		expect(tier("id", "userId")).toBe(Tier.WordRun);
		expect(tier("ui", "userId")).toBe(Tier.Initials);
	});

	test("ranges cover the matched letters for drawing", () => {
		expect(match("ci", "customer_id")?.ranges).toEqual([
			[0, 1],
			[9, 10],
		]);
		expect(match("cust", "customers")?.ranges).toEqual([[0, 4]]);
		expect(match("", "customers")?.ranges).toEqual([]);
	});

	test("within a tier, shorter names and tighter matches cost less", () => {
		const a = match("ord", "orders");
		const b = match("ord", "order_items");
		expect(a && b && a.cost < b.cost).toBe(true);
	});

	test("text longer than the name, or with letters out of order, does not match", () => {
		expect(match("customers2", "customers")).toBeNull();
		expect(match("ic", "customer_id")).toBeNull();
	});
});
