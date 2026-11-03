import { type Accessor, batch, createEffect, createSignal, untrack } from "solid-js";
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
 * Wraps a fetcher with loading/error state that never throws on read. Stale responses are dropped,
 * and when `source` is given the request reruns only when its key changes by value; a falsy key
 * pauses it without clearing the last result.
 */
export function createRequest<K, T>(
	fetcher: (key: K) => Promise<T>,
	source?: () => K | false | null | undefined,
): Request<K, T> {
	const [data, setData] = createSignal<T>();
	const [dataKey, setDataKey] = createSignal<K>();
	const [error, setError] = createSignal<ApiError>();
	const [loading, setLoading] = createSignal(false);
	let seq = 0;
	let lastKey: { key: K } | undefined;
	let lastJson: string | undefined;

	const run = (key: K) => {
		const id = ++seq;
		lastKey = { key };
		lastJson = JSON.stringify(key);
		setLoading(true);
		fetcher(key).then(
			(value) => {
				if (id !== seq) return;
				batch(() => {
					setData(() => value);
					setDataKey(() => key);
					setError(undefined);
					setLoading(false);
				});
			},
			(e: unknown) => {
				if (id !== seq) return;
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
