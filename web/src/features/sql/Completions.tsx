import { createEffect, For, type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../../components/ui/icons";
import type { Ranked } from "../../lib/sql-complete";
import "./completions.css";

/** Where the list sits, in viewport pixels: under the caret, or above it when there is no room. */
export interface Placement {
	left: number;
	top?: number;
	bottom?: number;
}

function iconOf(item: Ranked): IconName {
	if (item.kind === "column") return "columns";
	if (item.kind === "schema") return "database";
	if (item.kind === "keyword") return "code";
	return item.relationKind === "view" || item.relationKind === "materialized_view"
		? "view"
		: "table";
}

/** The label with its matched letters marked. */
function Label(props: { text: string; ranges: [number, number][] }) {
	const parts = () => {
		const out: JSX.Element[] = [];
		let at = 0;
		for (const [a, b] of props.ranges) {
			if (a > at) out.push(props.text.slice(at, a));
			out.push(<b class="hit">{props.text.slice(a, b)}</b>);
			at = b;
		}
		if (at < props.text.length) out.push(props.text.slice(at));
		return out;
	};
	return <span class="label">{parts()}</span>;
}

/**
 * The completion list. Focus never leaves the editor: it names the list with aria-controls and the
 * chosen row with aria-activedescendant, and a click picks a row without taking focus.
 */
export function Completions(props: {
	id: string;
	items: readonly Ranked[];
	selected: number;
	/** Columns are still loading, so the list may grow. */
	loading: boolean;
	at: Placement;
	onPick: (index: number) => void;
	onHover: (index: number) => void;
}) {
	createEffect(() => {
		document.getElementById(`${props.id}-${props.selected}`)?.scrollIntoView({ block: "nearest" });
	});
	return (
		<div
			id={props.id}
			class="completions mono"
			role="listbox"
			aria-label="Suggestions"
			style={{
				left: `${props.at.left}px`,
				top: props.at.top === undefined ? undefined : `${props.at.top}px`,
				bottom: props.at.bottom === undefined ? undefined : `${props.at.bottom}px`,
			}}
			onMouseDown={(e) => e.preventDefault()}
		>
			<For each={props.items}>
				{(item, i) => (
					// biome-ignore lint/a11y/useKeyWithClickEvents: keys reach the list through the editor, which keeps focus and points at the row with aria-activedescendant.
					<div
						id={`${props.id}-${i()}`}
						class="option"
						role="option"
						tabIndex={-1}
						aria-selected={i() === props.selected}
						aria-label={`${item.label}, ${item.kind === "relation" ? (item.relationKind ?? "table").replace("_", " ") : item.kind}`}
						onMouseMove={() => i() !== props.selected && props.onHover(i())}
						onClick={() => props.onPick(i())}
					>
						<Icon name={iconOf(item)} size={11} />
						<Label text={item.label} ranges={item.ranges} />
						<Show when={item.kind !== "keyword"}>
							<span class="detail">{item.detail}</span>
						</Show>
					</div>
				)}
			</For>
			<Show when={props.items.length === 0}>
				<div class="empty">{props.loading ? "Loading columns" : "No suggestions"}</div>
			</Show>
		</div>
	);
}
