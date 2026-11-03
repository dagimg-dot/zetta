import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { ColumnList } from "../../components/grid/ColumnList";
import { Grid } from "../../components/grid/Grid";
import { createHidden } from "../../components/grid/hidden";
import { SelectionNote } from "../../components/grid/SelectionNote";
import { createSelection } from "../../components/grid/selection";
import { Button } from "../../components/ui/Button";
import { ErrorBox } from "../../components/ui/ErrorBox";
import { Loader } from "../../components/ui/icons";
import { Kbd } from "../../components/ui/Kbd";
import { Loading } from "../../components/ui/Loading";
import { runQuery } from "../../lib/api";
import { formatMs, plural } from "../../lib/format";
import { isMac } from "../../lib/keys";
import { createRequest } from "../../lib/request";
import {
	changesSchema,
	errorRange,
	isWrite,
	statementAt,
	statementRanges,
	statements,
} from "../../lib/sql";
import { announce } from "../../stores/announce";
import "./sql.css";

const INDENT = "  ";

/**
 * What a run sends and where it starts in the editor: the selection when there is one, otherwise
 * the statement at the caret, or with `all` everything.
 */
function pickRun(
	value: string,
	a: number,
	b: number,
	all: boolean,
): { text: string; at: number } | null {
	if (all || a !== b) {
		const raw = all ? value : value.slice(a, b);
		const text = raw.trim();
		return text ? { text, at: (all ? 0 : a) + raw.indexOf(text) } : null;
	}
	const r = statementAt(value, a);
	return r ? { text: value.slice(r[0], r[1]), at: r[0] } : null;
}

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
	/** A first query to offer while the editor is empty, on a table that exists. */
	starter?: string | null;
	/** A run created, dropped or altered something, so the table list may be out of date. */
	onSchemaChange?: () => void;
	editorRef?: (el: HTMLTextAreaElement) => void;
}) {
	let editor: HTMLTextAreaElement | undefined;
	const storageKey = () => `zetta.sql.${props.database ?? ""}`;
	const [sql, setSql] = createSignal("");
	/** The editor's selection, or its caret when both ends are the same. */
	const [caret, setCaret] = createSignal<[number, number]>([0, 0]);
	const track = (e: { currentTarget: HTMLTextAreaElement }) =>
		setCaret([e.currentTarget.selectionStart, e.currentTarget.selectionEnd]);
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
	const [choosing, setChoosing] = createSignal(false);
	createEffect(on(query.data, () => hidden.set(new Set()), { defer: true }));
	createEffect(
		on(
			() => props.active,
			(active) => {
				if (active) queueMicrotask(() => editor?.focus());
			},
		),
	);

	const ranges = createMemo(() => statementRanges(sql()));
	const next = createMemo(() => pickRun(sql(), caret()[0], caret()[1], false));
	const writes = createMemo(() => !props.readOnly && isWrite(next()?.text ?? ""));
	const writesAll = createMemo(() => !props.readOnly && isWrite(sql()));

	/** Which statement Run would send, for the hint beside it. */
	const nextNote = () => {
		const [a, b] = caret();
		if (a !== b) return "Runs the selected text";
		const n = ranges().length;
		const at = next()?.at;
		const i = ranges().findIndex((r) => r[0] === at);
		return n > 1 && i >= 0 ? `Statement ${i + 1} of ${n}` : "";
	};

	/** How many statements the shown result's run held, when more than one: only the last one's result shows. */
	const ranMany = createMemo(() => {
		const n = statements(query.dataKey() ?? "").length;
		return n > 1 ? n : 0;
	});

	/**
	 * Runs the selection, or the statement at the caret, or with `all` the whole editor. A run while
	 * another is waiting replaces it.
	 */
	const run = (all = false) => {
		if (!editor) return;
		const picked = pickRun(editor.value, editor.selectionStart, editor.selectionEnd, all);
		if (!picked) return;
		setRan(picked);
		announce("Running");
		query.run(picked.text);
	};

	const start = (text: string) => {
		setSql(text);
		if (!editor) return;
		editor.focus();
		editor.setSelectionRange(text.length, text.length);
		setCaret([text.length, text.length]);
	};

	const onKey = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			run(e.shiftKey);
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
				placeholder={`Write SQL here. ${isMac() ? "⌘" : "Ctrl"}+Enter runs the statement at the caret, or the selected text.`}
				value={sql()}
				onInput={(e) => {
					setSql(e.currentTarget.value);
					track(e);
				}}
				onKeyDown={onKey}
				onKeyUp={track}
				onMouseUp={track}
				onSelect={track}
				onFocus={track}
			/>
			<div class="bar">
				<Button
					variant={writes() ? "danger" : "primary"}
					icon={writes() ? "warn" : "play"}
					kbd="Mod+Enter"
					busy={query.loading()}
					disabled={!next()}
					onClick={() => run()}
				>
					{writes() ? "Run write" : "Run"}
				</Button>
				<Show when={ranges().length > 1}>
					<Button
						variant={writesAll() ? "danger" : "default"}
						kbd="Mod+Shift+Enter"
						disabled={query.loading()}
						onClick={() => run(true)}
					>
						Run all
					</Button>
				</Show>
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
				<Show when={writes()} fallback={<span class="hint">{nextNote()}</span>}>
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
							<Kbd keys="Mod+Enter" /> runs the statement at the caret, or the selected text, and{" "}
							<Kbd keys="Mod+Shift+Enter" /> runs everything. Results are capped at 5,000 rows.
							<Show when={!sql().trim() && props.starter}>
								{(text) => (
									<Button size="sm" class="starter" onClick={() => start(text())}>
										<span class="mono">{text()}</span>
									</Button>
								)}
							</Show>
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
				<Show when={query.data()?.columns.length}>
					<ColumnList
						columns={query.data()?.columns ?? []}
						hidden={hidden}
						open={choosing()}
						onOpenChange={setChoosing}
					/>
				</Show>
			</div>
		</section>
	);
}
