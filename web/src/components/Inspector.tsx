import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { inspectorWidth } from "../layout";
import { matchRefs } from "../refs";
import { blobBytes, formatBytes, hexDump, kindOf, parseJson } from "../value";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { Icon, type IconName } from "./icons";
import { Kbd } from "./Kbd";
import { Segmented } from "./Segmented";
import { Splitter } from "./Splitter";
import { tip } from "./Tip";

export interface InspectorAction {
	label: string;
	detail?: string;
	icon: IconName;
	hint?: string;
	run: () => void;
}

export interface InspectedCell {
	column: string;
	type: string;
	value: string | null;
	row: number;
	actions?: InspectorAction[];
	/** Columns in other tables that point at this value. */
	incoming?: InspectorAction[];
}

/** Past this many references the list gets a filter. */
const FILTER_REFS_AT = 8;

type Mode = "pretty" | "raw";

/** Draws line breaks as a visible ↵ while keeping the text selectable and copyable. */
function withBreaks(text: string) {
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

function action(a: InspectorAction) {
	return (
		<button type="button" class="action" onClick={() => a.run()}>
			<Icon name={a.icon} />
			<span class="label">{a.label}</span>
			<Show when={a.detail}>
				<span class="detail mono">{a.detail}</span>
			</Show>
			<Show when={a.hint}>{(h) => <Kbd keys={h()} />}</Show>
		</button>
	);
}

/** Arrow keys move the grid's cursor while the inspector has focus, as its footer says. */
const arrows: Record<string, [number, number]> = {
	ArrowUp: [-1, 0],
	ArrowDown: [1, 0],
	ArrowLeft: [0, -1],
	ArrowRight: [0, 1],
};

export function Inspector(props: {
	cell: InspectedCell;
	onClose: () => void;
	onMove: (dRow: number, dCol: number) => void;
}) {
	const [mode, setMode] = createSignal<Mode>("pretty");

	const kind = createMemo(() => kindOf(props.cell.value, props.cell.type));
	createEffect(on(kind, () => setMode("pretty"), { defer: true }));

	const [refQuery, setRefQuery] = createSignal("");
	createEffect(
		on(
			() => props.cell.column,
			() => setRefQuery(""),
			{ defer: true },
		),
	);
	const refs = () => props.cell.incoming ?? [];
	const shownRefs = createMemo(() => matchRefs(refs(), refQuery()));

	const shown = () => {
		const v = props.cell.value;
		if (v === null) return "NULL";
		if (v === "") return "Empty text";
		if (mode() === "raw") return v;
		if (kind() === "json") return JSON.stringify(parseJson(v), null, 2);
		if (kind() === "blob") return blobBytes(v) ? hexDump(v) : "No bytes";
		return v;
	};

	const facts = () => {
		const v = props.cell.value;
		if (v === null) return ["NULL"];
		if (kind() === "blob") return ["blob", formatBytes(blobBytes(v))];
		const out = [`${[...v].length.toLocaleString()} chars`];
		const lines = v.split("\n").length;
		if (lines > 1) out.push(`${lines.toLocaleString()} lines`);
		if (kind() === "json") out.push("JSON");
		return out;
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
		if (e.key === "Escape") {
			e.preventDefault();
			props.onClose();
			return;
		}
		// Text fields and the value keep their arrows for the caret and for scrolling.
		const at = e.target as HTMLElement;
		const step = arrows[e.key];
		if (!step || e.shiftKey || at.closest("input, textarea, .value")) return;
		e.preventDefault();
		props.onMove(step[0], step[1]);
	};

	return (
		<section
			class="inspector"
			aria-label={`Value of ${props.cell.column}, row ${props.cell.row}`}
			onKeyDown={onKeyDown}
		>
			<header>
				<span class="col" {...tip(props.cell.column, undefined, "bottom")}>
					{props.cell.column}
				</span>
				<span class="type">{props.cell.type}</span>
				<span class="spacer" />
				<CopyButton
					text={() => props.cell.value ?? ""}
					what={props.cell.column}
					label="Copy value"
					kbd="C"
					disabled={props.cell.value === null}
				/>
				<Button icon="close" label="Close inspector" kbd="Esc" onClick={() => props.onClose()} />
			</header>
			<div class="facts">
				<span>row {props.cell.row.toLocaleString()}</span>
				{facts().map((f) => (
					<span>{f}</span>
				))}
			</div>
			<Show when={kind() === "json" || kind() === "blob"}>
				<div class="modes">
					<Segmented
						legend="View"
						options={[
							{ value: "pretty", label: kind() === "json" ? "Formatted" : "Hex" },
							{ value: "raw", label: "Raw" },
						]}
						value={mode()}
						onChange={setMode}
					/>
				</div>
			</Show>
			<pre
				class="value"
				classList={{
					null: props.cell.value === null || props.cell.value === "" || shown() === "No bytes",
					hex: kind() === "blob" && mode() === "pretty",
				}}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a long value scrolls, and a scrollable region must be reachable by keyboard.
				tabIndex={0}
			>
				{kind() === "multiline" || (kind() === "json" && mode() === "raw")
					? withBreaks(shown())
					: shown()}
			</pre>
			<Show when={props.cell.actions?.length || refs().length}>
				<nav class="actions" aria-label="Go to related rows">
					<For each={props.cell.actions}>{action}</For>
					<Show when={refs().length}>
						<div class="refs-head">
							<span>Rows pointing here</span>
							<span class="count">
								{shownRefs().length === refs().length
									? refs().length.toLocaleString()
									: `${shownRefs().length.toLocaleString()} of ${refs().length.toLocaleString()}`}
							</span>
							<Show when={refs().length > FILTER_REFS_AT}>
								<span class="refs-find">
									<Icon name="search" size={12} />
									<input
										type="search"
										aria-label="Filter the tables pointing here"
										placeholder="Filter tables"
										autocomplete="off"
										spellcheck={false}
										value={refQuery()}
										onInput={(e) => setRefQuery(e.currentTarget.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape" && refQuery()) {
												e.preventDefault();
												setRefQuery("");
											}
										}}
									/>
								</span>
							</Show>
						</div>
						<For each={shownRefs()} fallback={<div class="refs-empty">No matching tables</div>}>
							{action}
						</For>
					</Show>
				</nav>
			</Show>
			<footer>
				<Kbd keys="ArrowUp" />
				<Kbd keys="ArrowDown" />
				<Kbd keys="ArrowLeft" />
				<Kbd keys="ArrowRight" />
				<span>move</span>
				<span class="spacer" />
				<Kbd keys="Esc" />
				<span>close</span>
			</footer>
			<Splitter width={inspectorWidth} edge="left" label="Resize the inspector" />
		</section>
	);
}
