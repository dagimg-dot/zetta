import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { announce } from "../announce";
import { runQuery } from "../api";
import { formatMs, plural } from "../format";
import { isMac } from "../keys";
import { createRequest } from "../request";
import { changesSchema, errorRange, isWrite, statements } from "../value";
import { Button } from "./Button";
import { ErrorBox } from "./ErrorBox";
import { createHidden, createSelection, Grid, HiddenButton, SelectionNote } from "./Grid";
import { Loader } from "./icons";
import { Kbd } from "./Kbd";
import { Loading } from "./Loading";

const INDENT = "  ";

function load(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function save(key: string, value: string): void {
	try {
		if (value) localStorage.setItem(key, value);
		else localStorage.removeItem(key);
	} catch {
		// Storage can be blocked; the draft is then only kept for this page.
	}
}

export function SqlPane(props: {
	active: boolean;
	database: string | undefined;
	readOnly: boolean;
	/** A run created, dropped or altered something, so the table list may be out of date. */
	onSchemaChange?: () => void;
	editorRef?: (el: HTMLTextAreaElement) => void;
}) {
	let editor: HTMLTextAreaElement | undefined;
	const storageKey = () => `zetta.sql.${props.database ?? ""}`;
	const [sql, setSql] = createSignal("");
	/** What the last run sent, and where in the editor it started. */
	const [ran, setRan] = createSignal({ text: "", at: 0 });
	const hidden = createHidden();
	const selection = createSelection();
	const query = createRequest(runQuery);

	createEffect(
		on(
			() => props.database,
			(db) => {
				if (db !== undefined && !sql()) setSql(load(storageKey()));
			},
		),
	);
	createEffect(
		on(sql, (s) => props.database !== undefined && save(storageKey(), s), { defer: true }),
	);
	createEffect(on(query.data, () => hidden.clear(), { defer: true }));
	createEffect(
		on(
			() => props.active,
			(active) => {
				if (active) queueMicrotask(() => editor?.focus());
			},
		),
	);

	const writes = createMemo(() => !props.readOnly && isWrite(sql()));

	/** How many statements the shown result's run held, when more than one: only the last one's result shows. */
	const ranMany = createMemo(() => {
		const n = statements(query.dataKey() ?? "").length;
		return n > 1 ? n : 0;
	});

	/**
	 * Runs the selection when there is one, so a single statement can be run out of a longer script.
	 * A run while another is waiting replaces it.
	 */
	const run = () => {
		if (!editor) return;
		const { selectionStart: a, selectionEnd: b, value } = editor;
		const raw = a !== b ? value.slice(a, b) : value;
		const text = raw.trim();
		if (!text) return;
		setRan({ text, at: (a !== b ? a : 0) + raw.indexOf(text) });
		announce("Running");
		query.run(text);
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
		} else if (e.key === "Escape") {
			e.currentTarget.blur();
		}
	};

	const errorAt = () => {
		const err = query.error();
		if (!err) return null;
		const { text, at } = ran();
		const range = errorRange(text, err.message);
		// The editor may have changed since the run; then the spot is gone.
		if (!range || sql().slice(at, at + text.length) !== text) return null;
		return [at + range[0], at + range[1]] as const;
	};

	const showError = (range: readonly [number, number]) => {
		if (!editor) return;
		editor.focus();
		editor.setSelectionRange(range[0], range[1]);
	};

	const info = () => {
		const r = query.data();
		if (!r) return "";
		if (!r.columns.length) return [r.command, formatMs(r.elapsedMs)].filter(Boolean).join(" · ");
		return [plural(r.rowCount, "row"), formatMs(r.elapsedMs)].join(" · ");
	};

	createEffect(
		on(query.data, (r) => {
			if (!r) return;
			announce(info());
			if (changesSchema(query.dataKey() ?? "")) props.onSchemaChange?.();
		}),
	);

	return (
		<section
			class="pane"
			hidden={!props.active}
			id="pane-sql"
			role="tabpanel"
			aria-labelledby="tab-sql"
		>
			<textarea
				ref={(el) => {
					editor = el;
					props.editorRef?.(el);
				}}
				class="editor mono"
				aria-label="SQL"
				spellcheck={false}
				autocomplete="off"
				placeholder={`Write SQL here. ${isMac() ? "⌘" : "Ctrl"}+Enter runs it, or only the selected text.`}
				value={sql()}
				onInput={(e) => setSql(e.currentTarget.value)}
				onKeyDown={onKey}
			/>
			<div class="bar">
				<Button
					variant={writes() ? "danger" : "primary"}
					icon={writes() ? "warn" : "play"}
					kbd="Mod+Enter"
					busy={query.loading()}
					disabled={!sql().trim()}
					onClick={run}
				>
					{writes() ? "Run write" : "Run"}
				</Button>
				<Show when={query.loading()}>
					<Button
						icon="close"
						tip="Stop waiting for the result. A statement the database already started may still finish."
						onClick={() => {
							query.cancel();
							announce("Stopped");
						}}
					>
						Stop
					</Button>
				</Show>
				<Show
					when={writes()}
					fallback={<span class="hint">Select text to run only that statement</span>}
				>
					<span class="write-note">
						This changes data in <span class="mono">{props.database}</span>
					</span>
				</Show>
			</div>
			<Show when={query.error()}>
				{(err) => (
					<ErrorBox error={err()} inline>
						<Show when={errorAt()}>
							{(range) => (
								<Button size="sm" onClick={() => showError(range())}>
									Show in editor
								</Button>
							)}
						</Show>
					</ErrorBox>
				)}
			</Show>
			<Show
				when={query.data()}
				fallback={
					<Show
						when={!query.loading() && !query.error()}
						fallback={
							<Show when={query.loading()}>
								<Loading label="Running query" />
							</Show>
						}
					>
						<div class="empty">
							<strong>Run SQL against {props.database ?? "the database"}</strong>
							<Kbd keys="Mod+Enter" /> runs the editor, or only the selected text. Results are
							capped at 5,000 rows.
						</div>
					</Show>
				}
			>
				{(r) => (
					<div class="pane" classList={{ busy: query.loading() }}>
						<Grid
							result={r()}
							hidden={hidden}
							selection={selection}
							label="Query result"
							stale={!!query.error()}
						/>
					</div>
				)}
			</Show>
			<div class="status">
				{/* The same rules as the Rows status bar: a rerun or a failure keeps the last result's summary. */}
				<Show
					when={query.data()}
					fallback={
						<span class="st-note">
							{query.loading() ? "Running query" : query.error() ? "Failed" : ""}
						</span>
					}
				>
					{(r) => (
						<p class="st-summary">
							<Show
								when={r().columns.length}
								// The pane already names the command; the bar only says it finished.
								fallback={<span class="st-word st-strong">Done</span>}
							>
								<Show when={r().rowCount} fallback={<span class="st-word">No rows</span>}>
									<span class="st-num">{r().rowCount.toLocaleString()}</span>
									<span class="st-word">{r().rowCount === 1 ? "row" : "rows"}</span>
								</Show>
							</Show>
							<span class="st-sep" aria-hidden="true" />
							<Show
								when={query.loading()}
								fallback={<span class="st-time">{formatMs(r().elapsedMs)}</span>}
							>
								<span class="st-time st-loading">
									<Loader size={12} />
									<span class="sr-only">Running query</span>
								</span>
							</Show>
							<Show when={query.error()}>
								<span class="st-warn">last good result</span>
							</Show>
							<Show when={!query.error() && ranMany()}>
								<span class="st-note">the last of {plural(ranMany(), "statement")}</span>
							</Show>
							<Show when={!query.loading() && !query.error() && r().truncated}>
								<span class="st-warn">showing the first {r().rows.length.toLocaleString()}</span>
							</Show>
						</p>
					)}
				</Show>
				<SelectionNote selection={selection} total={query.data()?.rows.length ?? 0} />
				<span class="spacer" />
				<HiddenButton hidden={hidden} />
			</div>
		</section>
	);
}
