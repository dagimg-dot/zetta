import { createSignal } from "solid-js";

/**
 * Which columns are hidden, by name, so the choice survives a new page of rows and can live in the
 * URL. The rows view keeps it there; the SQL tab keeps it in memory with `createHidden`.
 */
export interface Hidden {
	hidden: () => ReadonlySet<string>;
	set: (next: ReadonlySet<string>) => void;
}

export function createHidden(): Hidden {
	const [hidden, set] = createSignal<ReadonlySet<string>>(new Set());
	return { hidden, set };
}

/**
 * Runs of adjacent hidden columns, keyed by the index of the first one, which draws as the one
 * stub for the whole run. Hiding 115 of 121 columns then leaves a few stubs, not 115.
 */
export function hiddenRuns(hidden: readonly boolean[]): Map<number, number[]> {
	const runs = new Map<number, number[]>();
	let start = -1;
	hidden.forEach((h, i) => {
		if (!h) {
			start = -1;
			return;
		}
		if (start < 0) {
			start = i;
			runs.set(i, []);
		}
		runs.get(start)?.push(i);
	});
	return runs;
}

/** The columns whose name or type contains the query, ignoring case. */
export function matchColumns<T extends { name: string; type: string }>(
	columns: readonly T[],
	query: string,
): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...columns];
	return columns.filter(
		(c) => c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q),
	);
}

/** The hidden set that shows exactly `keep`, or null when that would hide every column. */
export function showOnly(all: readonly string[], keep: readonly string[]): Set<string> | null {
	if (!keep.length) return null;
	const kept = new Set(keep);
	return new Set(all.filter((n) => !kept.has(n)));
}
