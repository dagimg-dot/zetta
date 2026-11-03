import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { announce } from "../announce";
import { runQuery } from "../api";
import { formatMs, plural } from "../format";
import { createRequest } from "../request";
import { errorRange, isWrite } from "../value";
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
	editorRef?: (el: HTMLTextAreaElement) => void;
}) {
	let editor: HTMLTextAreaElement | undefined;
	const storageKey = () => `zetta.sql.${props.database ?? ""}`;
	const [sql, setSql] = createSignal("");
	const [ran, setRan] = createSignal("");
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

	/** Runs the selection when there is one, so a single statement can be run out of a longer script. */
	const run = () => {
		if (!editor || query.loading()) return;
		const { selectionStart: a, selectionEnd: b, value } = editor;
		const text = (a !== b ? value.slice(a, b) : value).trim();
		if (!text) return;
		setRan(text);
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
		const range = errorRange(ran(), err.message);
		if (!range) return null;
		const start = sql().indexOf(ran());
		return start >= 0 ? ([start + range[0], start + range[1]] as const) : null;
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
			if (r) announce(info());
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
				placeholder="select * from customers limit 10"
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
					{query.loading() ? "Running" : writes() ? "Run write" : "Run"}
				</Button>
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
							{(range) => <Button onClick={() => showError(range())}>Show in editor</Button>}
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
				<Show
					when={!query.loading() && !query.error() && query.data()}
					fallback={
						<span class="st-note">
							<Show when={query.loading()} fallback={query.error() ? "Failed" : ""}>
								<span class="st-loading">
									<Loader size={12} />
									Running
								</span>
							</Show>
						</span>
					}
				>
					{(r) => (
						<p class="st-summary">
							<Show
								when={r().columns.length}
								fallback={<span class="st-word st-strong">{r().command || "Done"}</span>}
							>
								<span class="st-num">{r().rowCount.toLocaleString()}</span>
								<span class="st-word">{r().rowCount === 1 ? "row" : "rows"}</span>
							</Show>
							<span class="st-sep" aria-hidden="true" />
							<span class="st-time">{formatMs(r().elapsedMs)}</span>
						</p>
					)}
				</Show>
				<Show when={!query.loading() && !query.error() && query.data()?.truncated}>
					<span class="warn">showing the first {query.data()?.rows.length.toLocaleString()}</span>
				</Show>
				<SelectionNote selection={selection} total={query.data()?.rows.length ?? 0} />
				<span class="spacer" />
				<HiddenButton hidden={hidden} />
			</div>
		</section>
	);
}
