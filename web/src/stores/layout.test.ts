import { expect, test } from "bun:test";
import { clamp, inspectorWidth, sidebarWidth } from "./layout";

test("a dragged width stays between its limits", () => {
	expect(clamp(100, 180, 560)).toBe(180);
	expect(clamp(900, 180, 560)).toBe(560);
	expect(clamp(300.4, 180, 560)).toBe(300);
	// A window too narrow for the maximum still leaves the minimum.
	expect(clamp(300, 180, 120)).toBe(180);
});

test("resetting a panel returns it to its first width", () => {
	sidebarWidth.set(400);
	expect(sidebarWidth.value()).toBe(400);
	sidebarWidth.set(10);
	expect(sidebarWidth.value()).toBe(sidebarWidth.min);
	sidebarWidth.reset();
	expect(sidebarWidth.value()).toBe(sidebarWidth.initial);
});

test("a narrow window shrinks the inspector without forgetting its width", () => {
	inspectorWidth.set(700);
	const wide = globalThis.innerWidth;
	globalThis.innerWidth = 1000;
	globalThis.dispatchEvent(new Event("resize"));
	expect(inspectorWidth.value()).toBe(1000 - sidebarWidth.value() - 240);
	globalThis.innerWidth = wide;
	globalThis.dispatchEvent(new Event("resize"));
	expect(inspectorWidth.value()).toBe(700);
	inspectorWidth.reset();
});
