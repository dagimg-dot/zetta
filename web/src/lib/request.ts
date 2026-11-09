import {
	type Accessor,
	batch,
	createEffect,
	createSignal,
	getOwner,
	onCleanup,
	untrack,
} from "solid-js";
import { ApiError } from "./api";

export interface Request<K, T> {
	data: Accessor<T | undefined>;
	/** The key that produced `data`. */
	dataKey: Accessor<K | undefined>;
	error: Accessor<ApiError | undefined>;
	loading: Accessor<boolean>;
	/** Loading with nothing to show for this key yet, as opposed to refreshing an answer on screen. */
	waiting: Accessor<boolean>;
	run: (key: K) => void;
	refetch: () => void;
	/** Stops waiting for the request in flight and keeps the last result. */
	cancel: () => void;
	reset: () => void;
}

/**
 * Answers kept by key, oldest first, so a request can show its last answer while it asks again.
 * `same` lets an unchanged answer leave the screen alone; `keep` turns away one too big to hold.
 */
export interface ResponseCache<T> {
	limit: number;
	entries: Map<string, T>;
	same: (a: T, b: T) => boolean;
	keep: (value: T) => boolean;
}

export function createResponseCache<T>(
	limit: number,
	options: { same?: (a: T, b: T) => boolean; keep?: (value: T) => boolean } = {},
): ResponseCache<T> {
	return {
		limit,
		entries: new Map(),
		same: options.same ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b)),
		keep: options.keep ?? (() => true),
	};
}

function remember<T>(cache: ResponseCache<T>, json: string, value: T): void {
	cache.entries.delete(json);
	if (!cache.keep(value)) return;
	cache.entries.set(json, value);
	for (const oldest of cache.entries.keys()) {
		if (cache.entries.size <= cache.limit) break;
		cache.entries.delete(oldest);
	}
}

function toApiError(e: unknown): ApiError {
	if (e instanceof ApiError) return e;
	return new ApiError("internal", e instanceof Error ? e.message : String(e), 0);
}

/**
 * Wraps a fetcher with loading/error state that never throws on read. A new run, a reset or the
 * owner's cleanup aborts the request in flight, so the browser stops reading a response nobody will
 * see. When `source` is given the request reruns only when its key changes by value; a falsy key
 * pauses it without clearing the last result. With a `cache` a key seen before shows its last answer
 * at once, and the request runs anyway to replace it.
 */
export function createRequest<K, T>(
	fetcher: (key: K, signal: AbortSignal) => Promise<T>,
	source?: () => K | false | null | undefined,
	cache?: ResponseCache<T>,
): Request<K, T> {
	const [data, setData] = createSignal<T>();
	const [dataKey, setDataKey] = createSignal<K>();
	const [error, setError] = createSignal<ApiError>();
	const [loading, setLoading] = createSignal(false);
	const [waiting, setWaiting] = createSignal(false);
	let seq = 0;
	let lastKey: { key: K } | undefined;
	let lastJson: string | undefined;
	let inFlight: AbortController | undefined;

	const abort = () => {
		inFlight?.abort();
		inFlight = undefined;
	};
	if (getOwner()) onCleanup(abort);

	const run = (key: K) => {
		const id = ++seq;
		lastKey = { key };
		const json = JSON.stringify(key);
		lastJson = json;
		const known = cache?.entries.get(json);
		batch(() => {
			setLoading(true);
			setWaiting(known === undefined);
			if (known === undefined) return;
			setData(() => known);
			setDataKey(() => key);
			setError(undefined);
		});
		abort();
		const controller = new AbortController();
		inFlight = controller;
		fetcher(key, controller.signal).then(
			(value) => {
				if (id !== seq) return;
				inFlight = undefined;
				if (cache) remember(cache, json, value);
				const unchanged = known !== undefined && cache?.same(known, value);
				batch(() => {
					if (!unchanged) setData(() => value);
					setDataKey(() => key);
					setError(undefined);
					setLoading(false);
					setWaiting(false);
				});
			},
			(e: unknown) => {
				if (id !== seq) return;
				inFlight = undefined;
				batch(() => {
					setError(toApiError(e));
					setLoading(false);
					setWaiting(false);
				});
			},
		);
	};

	if (source) {
		createEffect(() => {
			const key = source();
			if (key === false || key === null || key === undefined) return;
			if (JSON.stringify(key) === lastJson) return;
			untrack(() => run(key));
		});
	}

	return {
		data,
		dataKey,
		error,
		loading,
		waiting,
		run,
		refetch: () => {
			if (lastKey) run(lastKey.key);
		},
		cancel: () => {
			seq++;
			abort();
			setLoading(false);
			setWaiting(false);
		},
		reset: () => {
			seq++;
			abort();
			lastKey = undefined;
			lastJson = undefined;
			batch(() => {
				setData(undefined);
				setDataKey(undefined);
				setError(undefined);
				setLoading(false);
				setWaiting(false);
			});
		},
	};
}
