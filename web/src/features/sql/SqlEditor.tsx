import { createMemo, For, type JSX, splitProps } from "solid-js";
import { SqlLine } from "../../components/ui/SqlText";
import { escapeHtml, highlightLines } from "../../lib/sql-highlight";
import { dialect } from "../../stores/dialect";
import "./sql-editor.css";

/** Past this many characters, about 2,000 lines, the layer shows plain text, so colouring never slows typing. */
const maxHighlight = 100_000;

type TextareaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement>;

export interface SqlEditorProps extends Omit<TextareaProps, "value" | "ref"> {
	value: string;
	/** The [start, end) of the statement Run would send, shaded line by line. */
	current?: readonly [number, number] | null;
	/** The [start, end) the last error points at. */
	error?: readonly [number, number] | null;
	ref?: (el: HTMLTextAreaElement) => void;
}

/** Where each line of `text` starts. */
function lineStarts(text: string): number[] {
	const out = [0];
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
	return out;
}

/** The line that holds offset `at`, by binary search over `starts`. */
function lineAt(starts: readonly number[], at: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((starts[mid] ?? 0) <= at) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * A textarea over a coloured copy of its own text. Typing, selection, undo, IME and screen readers
 * stay the browser's own; the textarea's letters are transparent, and the layer beneath draws the
 * same letters in colour, wrapped and scrolled the same way.
 */
export function SqlEditor(props: SqlEditorProps) {
	const [own, rest] = splitProps(props, ["value", "current", "error", "ref", "class", "onScroll"]);
	let layer: HTMLDivElement | undefined;
	let input: HTMLTextAreaElement | undefined;

	const lines = createMemo(() =>
		own.value.length > maxHighlight
			? own.value.split("\n").map(escapeHtml)
			: highlightLines(own.value, dialect(), { error: own.error }),
	);
	const starts = createMemo(() => lineStarts(own.value));
	/** The first and last line of the current statement, or -1 to -1 for none. */
	const first = createMemo(() => (own.current ? lineAt(starts(), own.current[0]) : -1));
	const last = createMemo(() => (own.current ? lineAt(starts(), own.current[1]) : -1));
	const isShaded = (i: number) => i >= first() && i <= last() && first() >= 0;

	const follow = () => {
		if (!layer || !input) return;
		layer.scrollTop = input.scrollTop;
		layer.scrollLeft = input.scrollLeft;
	};

	return (
		<div class="sql-editor">
			<div class="sql-layer mono" ref={layer} aria-hidden="true">
				<For each={lines()}>{(html, i) => <SqlLine html={html} current={isShaded(i())} />}</For>
			</div>
			<textarea
				{...rest}
				ref={(el) => {
					input = el;
					own.ref?.(el);
				}}
				class={own.class ? `sql-input mono ${own.class}` : "sql-input mono"}
				value={own.value}
				onScroll={(e) => {
					follow();
					if (typeof own.onScroll === "function") own.onScroll(e);
				}}
			/>
		</div>
	);
}
