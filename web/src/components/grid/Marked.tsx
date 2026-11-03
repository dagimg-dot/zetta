import { Show } from "solid-js";
import { plural } from "../../lib/format";
import { blobBytes, edges, formatBytes, kindOf } from "../../lib/value";
import { whitespace } from "./marks";

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
	const kind = () => kindOf(props.value, props.type);
	const mark = () => {
		const v = props.value;
		if (v === null) return "NULL";
		if (v === "") return "empty";
		if (kind() === "blank") return `blank · ${plural([...v].length, "char")}`;
		if (kind() === "blob") return `blob · ${formatBytes(blobBytes(v))}`;
		return null;
	};
	return (
		<Show when={mark()} fallback={withMarks(props.value ?? "")}>
			{(m) => <span class="mark">{m()}</span>}
		</Show>
	);
}
