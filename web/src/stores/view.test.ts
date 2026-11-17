import { expect, test } from "bun:test";

// view.ts reads the address and wires history when it loads. The real addEventListener goes
// back afterwards: a module loaded later in this process, such as layout.ts, needs it.
const realAddEventListener = globalThis.addEventListener;
Object.assign(globalThis, {
	location: { search: "", pathname: "/" },
	history: { replaceState() {}, pushState() {} },
	addEventListener() {},
});
const { parse, serialize } = await import("./view");
globalThis.addEventListener = realAddEventListener;

test("hidden columns round-trip through the URL, whatever their names hold", () => {
	const names = ["a,b", 'say "hi"', "naïve ✓", "a&b=c", " spaced "];
	const url = serialize({ ...parse(""), schema: "main", table: "t", hide: names });
	expect(parse(url.slice(1)).hide).toEqual(names);
});

test("a function and its overload's arguments round-trip through the URL", () => {
	const url = serialize({ ...parse(""), schema: "public", fn: "add", args: "x integer, y text" });
	const back = parse(url.slice(1));
	expect(back.fn).toBe("add");
	expect(back.args).toBe("x integer, y text");
	expect(parse("?table=t").fn).toBeNull();
});

test("no hide parameter means nothing hidden, and repeats and blanks are dropped", () => {
	expect(parse("?table=t").hide).toEqual([]);
	expect(parse("?hide=a&hide=&hide=a&hide=b").hide).toEqual(["a", "b"]);
	expect(serialize({ ...parse(""), table: "t" })).toBe("?table=t");
});
