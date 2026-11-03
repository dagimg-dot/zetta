import { Show } from "solid-js";
import { edges, markOf } from "../../lib/value";

/** Past this many characters a run of whitespace is kept as it is but no longer marked. */
const MARK_AT_MOST = 64;

/**
 * Spaces and tabs as typed, each with a · or → drawn over it, so they can be seen and a copy or a
 * text selection still gets the real characters. Built as DOM nodes so the grid can use it too.
 */
export function whitespace(run: string): HTMLSpanElement {
	const out = document.createElement("span");
	out.className = "ws";
	const chars = [...run];
	for (const ch of chars.slice(0, MARK_AT_MOST)) {
		const c = document.createElement("span");
		c.className = ch === "\t" ? "tab" : "sp";
		c.textContent = ch;
		out.append(c);
	}
	if (chars.length > MARK_AT_MOST) out.append(chars.slice(MARK_AT_MOST).join(""));
	return out;
}

/** Draws line breaks as a visible ↵ while keeping the text selectable and copyable. */
export function withBreaks(text: string) {
	const parts = text.split("\n");
	return parts.map((line, i) => (
		<>
			{line}
			{i < parts.length - 1 && (
				<>
					<span class="nl" aria-hidden="true">
						↵
					</span>
					{"\n"}
				</>
			)}
		</>
	));
}

/** Line breaks as ↵, and the spaces and tabs a value starts or ends with as · and →. */
export function withMarks(text: string) {
	const { lead, body, trail } = edges(text);
	return (
		<>
			{lead && whitespace(lead)}
			{withBreaks(body)}
			{trail && whitespace(trail)}
		</>
	);
}

/**
 * A value on one line, as the grid draws it: NULL, empty, blank and blobs as muted marks, and
 * text with its line breaks and edge whitespace visible.
 */
export function ValueLine(props: { value: string | null; type: string }) {
	return (
		<Show when={markOf(props.value, props.type)} fallback={withMarks(props.value ?? "")}>
			{(m) => <span class="mark">{m()}</span>}
		</Show>
	);
}
