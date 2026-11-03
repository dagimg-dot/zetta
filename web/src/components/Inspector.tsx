import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { announce } from "../announce";
import { inspectorWidth } from "../layout";
import { matchRefs } from "../refs";
import { blobBytes, formatBytes, hexDump, kindOf, parseJson } from "../value";
import { Button } from "./Button";
import { Icon, type IconName } from "./icons";
import { Kbd } from "./Kbd";
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

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

/**
 * Writes plain text and an HTML table together, so spreadsheets paste cells. Browsers allow this
 * only on HTTPS or localhost; elsewhere it falls back to the plain text.
 */
export async function copyRich(text: string, html: string): Promise<boolean> {
	if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return copyText(text);
	try {
		await navigator.clipboard.write([
			new ClipboardItem({
				"text/plain": new Blob([text], { type: "text/plain" }),
				"text/html": new Blob([html], { type: "text/html" }),
			}),
		]);
		return true;
	} catch {
		return copyText(text);
	}
}

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

export function Inspector(props: { cell: InspectedCell; onClose: () => void }) {
	const [mode, setMode] = createSignal<Mode>("pretty");
	const [copied, setCopied] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(timer));

	const kind = createMemo(() => kindOf(props.cell.value));
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
		if (mode() === "raw") return v;
		if (kind() === "json") return JSON.stringify(parseJson(v), null, 2);
		if (kind() === "blob") return hexDump(v);
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

	const copy = async () => {
		const ok = await copyText(props.cell.value ?? "");
		if (!ok) return;
		setCopied(true);
		announce("Copied");
		clearTimeout(timer);
		timer = setTimeout(() => setCopied(false), 1200);
	};

	return (
		<section class="inspector" aria-label={`Value of ${props.cell.column}, row ${props.cell.row}`}>
			<header>
				<span class="col" {...tip(props.cell.column, undefined, "bottom")}>
					{props.cell.column}
				</span>
				<span class="type">{props.cell.type}</span>
				<span class="spacer" />
				<Button
					icon={copied() ? "check" : "copy"}
					label="Copy value"
					kbd="C"
					disabled={props.cell.value === null}
					onClick={copy}
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
				<fieldset class="modes">
					<legend class="sr-only">View</legend>
					<button
						type="button"
						aria-pressed={mode() === "pretty"}
						onClick={() => setMode("pretty")}
					>
						{kind() === "json" ? "Formatted" : "Hex"}
					</button>
					<button type="button" aria-pressed={mode() === "raw"} onClick={() => setMode("raw")}>
						Raw
					</button>
				</fieldset>
			</Show>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a long value scrolls, and a scrollable region must be reachable by keyboard. */}
			<pre class="value" classList={{ null: props.cell.value === null }} tabIndex={0}>
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
						<For each={shownRefs()} fallback={<div class="refs-empty">No table matches</div>}>
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
