import { createEffect, createSignal, on, Show } from "solid-js";
import { runQuery } from "../api";
import { formatMs, plural } from "../format";
import { createRequest } from "../request";
import { ErrorBox } from "./ErrorBox";
import { createHidden, Grid, HiddenButton } from "./Grid";
import { Icon } from "./icons";

const INDENT = "  ";

export function SqlPane(props: { active: boolean }) {
	let editor: HTMLTextAreaElement | undefined;
	const [sql, setSql] = createSignal("");
	const hidden = createHidden();
	const query = createRequest(runQuery);

	createEffect(on(query.data, () => hidden.clear(), { defer: true }));
	createEffect(
		on(
			() => props.active,
			(active) => {
				if (active) queueMicrotask(() => editor?.focus());
			},
		),
	);

	/** Runs the selection when there is one, so a single statement can be run out of a longer script. */
	const run = () => {
		if (!editor || query.loading()) return;
		const { selectionStart: a, selectionEnd: b, value } = editor;
		const text = (a !== b ? value.slice(a, b) : value).trim();
		if (text) query.run(text);
	};

	const onKey = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			run();
		} else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			if (!document.execCommand("insertText", false, INDENT)) {
				e.currentTarget.setRangeText(
					INDENT,
					e.currentTarget.selectionStart,
					e.currentTarget.selectionEnd,
					"end",
				);
				setSql(e.currentTarget.value);
			}
		}
	};

	const info = () => {
		const r = query.data();
		if (!r) return "";
		const rows = plural(r.rowCount, "row") + (r.columns.length ? "" : " affected");
		return [r.command, rows, formatMs(r.elapsedMs)].filter(Boolean).join(" · ");
	};

	return (
		<section class="pane" hidden={!props.active}>
			<textarea
				ref={editor}
				class="editor mono"
				spellcheck={false}
				autocomplete="off"
				placeholder="select * from …     (Ctrl+Enter to run, or select a statement to run just that)"
				value={sql()}
				onInput={(e) => setSql(e.currentTarget.value)}
				onKeyDown={onKey}
			/>
			<div class="bar">
				<button
					type="button"
					class="btn primary"
					disabled={query.loading() || !sql().trim()}
					onClick={run}
				>
					<Icon name="play" />
					Run
					<kbd>Ctrl ↵</kbd>
				</button>
				<span class="info">{query.loading() ? "Running…" : query.error() ? "Failed" : info()}</span>
				<Show when={!query.loading() && !query.error() && query.data()?.truncated}>
					<span class="warn">showing first {query.data()?.rows.length.toLocaleString()} rows</span>
				</Show>
				<span class="spacer" />
				<HiddenButton hidden={hidden} />
			</div>
			<Show when={query.error()}>{(err) => <ErrorBox error={err()} />}</Show>
			<Show when={!query.error() && query.data()}>
				{(r) => (
					<div class="pane" classList={{ busy: query.loading() }}>
						<Grid result={r()} hidden={hidden} />
					</div>
				)}
			</Show>
		</section>
	);
}
