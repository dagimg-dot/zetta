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
	run: (key: K) => void;
	refetch: () => void;
	reset: () => void;
}

function toApiError(e: unknown): ApiError {
	if (e instanceof ApiError) return e;
	return new ApiError("internal", e instanceof Error ? e.message : String(e), 0);
}

/**
 * Wraps a fetcher with loading/error state that never throws on read. A new run, a reset or the
 * owner's cleanup aborts the request in flight, so the browser stops reading a response nobody will
 * see. When `source` is given the request reruns only when its key changes by value; a falsy key
 * pauses it without clearing the last result.
 */
export function createRequest<K, T>(
	fetcher: (key: K, signal: AbortSignal) => Promise<T>,
	source?: () => K | false | null | undefined,
): Request<K, T> {
	const [data, setData] = createSignal<T>();
	const [dataKey, setDataKey] = createSignal<K>();
	const [error, setError] = createSignal<ApiError>();
	const [loading, setLoading] = createSignal(false);
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
		lastJson = JSON.stringify(key);
		setLoading(true);
		abort();
		const controller = new AbortController();
		inFlight = controller;
		fetcher(key, controller.signal).then(
			(value) => {
				if (id !== seq) return;
				inFlight = undefined;
				batch(() => {
					setData(() => value);
					setDataKey(() => key);
					setError(undefined);
					setLoading(false);
				});
			},
			(e: unknown) => {
				if (id !== seq) return;
				inFlight = undefined;
				batch(() => {
					setError(toApiError(e));
					setLoading(false);
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
		run,
		refetch: () => {
			if (lastKey) run(lastKey.key);
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
			});
		},
	};
}
