import { expect, test } from "bun:test";
import { createRequest, createResponseCache } from "./request";

function deferred<T>() {
	let resolve: (v: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function harness(cache = createResponseCache<{ v: number }>(2)) {
	const pending: ReturnType<typeof deferred<{ v: number }>>[] = [];
	const request = createRequest(
		(_: string) => {
			const d = deferred<{ v: number }>();
			pending.push(d);
			return d.promise;
		},
		undefined,
		cache,
	);
	const answer = async (v: { v: number }) => {
		pending.shift()?.resolve(v);
		await Promise.resolve();
		await Promise.resolve();
	};
	return { request, answer, cache };
}

test("a key seen before shows its last answer at once and still asks again", async () => {
	const { request, answer } = harness();
	request.run("a");
	expect(request.data()).toBeUndefined();
	expect(request.waiting()).toBe(true);
	await answer({ v: 1 });

	request.run("b");
	await answer({ v: 2 });
	request.run("a");
	expect(request.data()).toEqual({ v: 1 });
	expect(request.dataKey()).toBe("a");
	expect(request.loading()).toBe(true);
	expect(request.waiting()).toBe(false);

	await answer({ v: 3 });
	expect(request.data()).toEqual({ v: 3 });
	expect(request.loading()).toBe(false);
});

test("an unchanged answer leaves the shown value in place", async () => {
	const { request, answer } = harness();
	request.run("a");
	await answer({ v: 1 });
	const shown = request.data();
	request.refetch();
	await answer({ v: 1 });
	expect(request.data()).toBe(shown);
});

test("the oldest answer is the one forgotten past the limit", async () => {
	const { request, answer, cache } = harness();
	for (const [i, key] of ["a", "b", "c"].entries()) {
		request.run(key);
		await answer({ v: i });
	}
	expect([...cache.entries.keys()]).toEqual(['"b"', '"c"']);
});

test("an answer the cache turns away also drops the older one", async () => {
	const cache = createResponseCache<{ v: number }>(2, { keep: (x) => x.v < 10 });
	const { request, answer } = harness(cache);
	request.run("a");
	await answer({ v: 1 });
	request.refetch();
	await answer({ v: 11 });
	expect(cache.entries.size).toBe(0);
});
