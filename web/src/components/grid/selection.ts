import { createSignal, onCleanup } from "solid-js";
import { announce } from "../../stores/announce";

/**
 * Rows picked for copying, by index into the loaded result. It is plain data rather than marks on
 * elements, because the grid draws only the rows in view. It also carries the short note a copy
 * leaves in the status bar.
 */
export function createSelection() {
	const [rows, setRows] = createSignal<ReadonlySet<number>>(new Set());
	const [note, setNote] = createSignal("");
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(timer));
	return {
		rows,
		set: (next: ReadonlySet<number>) => setRows(next),
		clear() {
			if (rows().size) setRows(new Set<number>());
		},
		note,
		tell(text: string) {
			clearTimeout(timer);
			setNote(text);
			announce(text);
			timer = setTimeout(() => setNote(""), 2400);
		},
	};
}

export type Selection = ReturnType<typeof createSelection>;
