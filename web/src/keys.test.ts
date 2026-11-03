import { describe, expect, test } from "bun:test";
import { keyCap, splitKeys } from "./keys";

describe("key caps", () => {
	test("Mod is Command on a Mac and Ctrl elsewhere", () => {
		expect(keyCap("Mod", true)).toEqual({ text: "⌘", name: "Command" });
		expect(keyCap("Mod", false)).toEqual({ text: "Ctrl", name: "Control" });
		expect(keyCap("Shift", true).text).toBe("⇧");
		expect(keyCap("Shift", false).text).toBe("Shift");
	});

	test("named keys draw as symbols but are spoken as words", () => {
		expect(keyCap("Enter", false)).toEqual({ text: "↵", name: "Enter" });
		expect(keyCap("ArrowUp", true)).toEqual({ text: "↑", name: "Up arrow" });
		expect(keyCap("Escape", false).text).toBe("Esc");
	});

	test("letters print in capitals and symbols as they are", () => {
		expect(keyCap("c", false)).toEqual({ text: "C", name: "C" });
		expect(keyCap("?", false)).toEqual({ text: "?", name: "?" });
		expect(keyCap("F10", false).text).toBe("F10");
	});

	test("combos split on plus, and a lone plus is a key", () => {
		expect(splitKeys("Mod+Shift+K")).toEqual(["Mod", "Shift", "K"]);
		expect(splitKeys("/")).toEqual(["/"]);
		expect(splitKeys("+")).toEqual(["+"]);
	});
});
