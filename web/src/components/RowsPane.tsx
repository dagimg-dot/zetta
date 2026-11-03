import { createEffect, createMemo, createSignal, on, Show, untrack } from "solid-js";
import { announce } from "../announce";
import { browse, compileBuilder, countRows, type TableDetail } from "../api";
import { formatMs } from "../format";
import {
	type Builder,
	decodeBuilder,
	dropFilter,
	dropSort,
	emptyBuilder,
	encodeBuilder,
	type Filter,
	quoteIdent,
	toggleSort,
} from "../query";
import { createRequest } from "../request";
import { openRowsWhere, openTable, setView, view } from "../url";
import { closest, unknownColumn } from "../value";
import { Button } from "./Button";
import type { ColumnChoice } from "./ColumnPicker";
import { ErrorBox } from "./ErrorBox";
import {
	createHidden,
	createSelection,
	Grid,
	HiddenButton,
	type Links,
	SelectionNote,
} from "./Grid";
import { Loader } from "./icons";
import { Loading } from "./Loading";
import { Pager } from "./Pager";
import { QueryBar } from "./QueryBar";

export function RowsPane(props: {
	schema: string;
	table: string;
	active: boolean;
	detail: TableDetail | undefined;
	approxRows: number | null;
	filterRef?: (el: HTMLInputElement) => void;
}) {
	const hidden = createHidden();
	const selection = createSelection();
	const applied = createMemo(() => decodeBuilder(view().q));
	const raw = createMemo(() => !view().q && (view().filter !== "" || view().order !== ""));
	const [sqlMode, setSqlMode] = createSignal(raw());
	const [draft, setDraft] = createSignal<Builder>(applied() ?? emptyBuilder);
	const [rawFilter, setRawFilter] = createSignal(view().filter);
	const [rawOrder, setRawOrder] = createSignal(view().order);

	/** The draft to show after the next apply, when an apply should keep edits not yet applied. */
	let keepDraft: Builder | null = null;
	createEffect(
		on(
			applied,
			(b) => {
				setDraft(keepDraft ?? b ?? emptyBuilder);
				keepDraft = null;
			},
			{ defer: true },
		),
	);
	createEffect(on(raw, (r) => r && setSqlMode(true), { defer: true }));
	createEffect(
		on(
			() => view().filter,
			(f) => setRawFilter(f),
		),
	);
	createEffect(
		on(
			() => view().order,
			(o) => setRawOrder(o),
		),
	);
	createEffect(
		on(
			() => `${props.schema}\u0000${props.table}`,
			() => hidden.clear(),
			{ defer: true },
		),
	);

	/** What the server runs: the builder as data, which it compiles per dialect, or the raw SQL. */
	const query = createMemo((): { q?: string; filter?: string; order?: string } => {
		if (applied()) return { q: view().q };
		return { filter: view().filter, order: view().order };
	});

	const rows = createRequest(browse, () => {
		if (!props.active) return null;
		return {
			schema: props.schema,
			table: props.table,
			...query(),
			limit: view().limit,
			offset: view().offset,
		};
	});

	const result = () => {
		const k = rows.dataKey();
		if (!k || k.schema !== props.schema || k.table !== props.table) return undefined;
		return rows.data();
	};

	const columns = createMemo<ColumnChoice[]>(() => {
		if (props.detail?.columns.length)
			return props.detail.columns.map((c) => ({ name: c.name, type: c.type }));
		return result()?.columns.map((c) => ({ name: c.name, type: c.type })) ?? [];
	});

	const applyBuilder = (b: Builder) =>
		setView(
			{ q: encodeBuilder(b), filter: "", order: "", offset: 0 },
			b.filters.length ? "push" : "replace",
		);
	const applyRaw = () =>
		setView({ q: "", filter: rawFilter().trim(), order: rawOrder().trim(), offset: 0 });

	/**
	 * Takes a row out of the builder. If it was applied, the rows reload without it straight away;
	 * other edits still waiting for Apply stay in the builder either way.
	 */
	const removeRow = (next: Builder, reload: Builder | null) => {
		if (!reload) {
			setDraft(next);
			return;
		}
		keepDraft = next;
		applyBuilder(reload);
	};

	const dirty = () =>
		sqlMode()
			? rawFilter().trim() !== view().filter ||
				rawOrder().trim() !== view().order ||
				view().q !== ""
			: // Both sides re-encoded, so a shared URL written another way (\u escapes, key order) is not an edit.
				encodeBuilder(draft()) !== encodeBuilder(applied() ?? emptyBuilder);

	const toBuilder = () => {
		setSqlMode(false);
		setView({ q: "", filter: "", order: "", offset: 0 });
	};

	/** Seeds the raw boxes with the server's own SQL for the builder, so nothing is lost switching. */
	const toSql = async () => {
		const q = encodeBuilder(draft());
		let where = "";
		let order = "";
		if (q) {
			try {
				({ where, order } = await compileBuilder(q));
			} catch {
				// The builder stays as it was; switching with empty boxes loses nothing that applied.
			}
		}
		setRawFilter(where);
		setRawOrder(order);
		setSqlMode(true);
		queueMicrotask(() =>
			document.querySelector<HTMLInputElement>("#pane-data .raw-where")?.focus(),
		);
	};

	const sortBy = (col: string, additive: boolean) => {
		if (sqlMode()) {
			const q = quoteIdent(col);
			const next =
				view().order === `${q} asc` ? `${q} desc` : view().order === `${q} desc` ? "" : `${q} asc`;
			setRawOrder(next);
			setView({ q: "", filter: rawFilter().trim(), order: next, offset: 0 });
			return;
		}
		const base = applied() ?? emptyBuilder;
		applyBuilder({ ...base, sorts: toggleSort(base.sorts, col, additive) });
	};

	const filterByValue = (col: string, value: string | null) => {
		const base = applied() ?? emptyBuilder;
		const kept = base.filters.filter((f) => f.c !== col);
		const added = {
			c: col,
			op: value === null ? ("is_null" as const) : ("eq" as const),
			v: value ?? "",
		};
		setSqlMode(false);
		applyBuilder({ ...base, filters: [...kept, added] });
	};

	/** The column menu's sort and filter, which edit the applied builder the way the header and inspector do. */
	const headerActions = {
		sort: (col: string, dir: "asc" | "desc" | null, additive: boolean) => {
			const base = applied() ?? emptyBuilder;
			const rest = base.sorts.filter((s) => s.c !== col);
			const sorts =
				dir === null ? rest : additive ? [...rest, { c: col, d: dir }] : [{ c: col, d: dir }];
			setSqlMode(false);
			applyBuilder({ ...base, sorts });
		},
		filter: (f: Filter) => {
			const base = applied() ?? emptyBuilder;
			setSqlMode(false);
			applyBuilder({ ...base, filters: [...base.filters.filter((x) => x.c !== f.c), f] });
		},
		open: (schema: string, table: string) => openTable(schema, table),
	};

	/** Single-column foreign keys out of this table, and references into it, for the grid and inspector. */
	const links = createMemo<Links>(() => {
		const d = props.detail;
		const out = new Map<string, { schema: string; table: string; column: string }>();
		const into = new Map<string, { schema: string; table: string; column: string }[]>();
		for (const fk of d?.foreignKeys ?? []) {
			const [c] = fk.columns;
			const [rc] = fk.refColumns;
			if (fk.columns.length === 1 && c && rc)
				out.set(c, { schema: fk.refSchema, table: fk.refTable, column: rc });
		}
		for (const r of d?.referencedBy ?? []) {
			const [c] = r.columns;
			const [rc] = r.refColumns;
			if (r.columns.length !== 1 || !c || !rc) continue;
			into.set(rc, [...(into.get(rc) ?? []), { schema: r.schema, table: r.table, column: c }]);
		}
		return {
			schema: d?.schema ?? "",
			outgoing: (col) => out.get(col),
			incoming: (col) => into.get(col) ?? [],
			follow: (target, value) => openRowsWhere(target.schema, target.table, target.column, value),
			filterBy: filterByValue,
		};
	});

	const suggestion = () => {
		const err = rows.error();
		if (!err) return null;
		const bad = unknownColumn(err.message);
		if (!bad) return null;
		const fix = closest(
			bad,
			columns().map((c) => c.name),
		);
		return fix && fix !== bad ? { bad, fix } : null;
	};

	/** A first page that came back short already is the total, so no count is needed. */
	const shortPage = () => {
		const r = result();
		const k = rows.dataKey();
		return r && k && k.offset === 0 && r.rows.length < k.limit ? r.rows.length : null;
	};

	const counter = createRequest(countRows, () => {
		const k = rows.dataKey();
		if (!props.active || !k || shortPage() !== null) return null;
		return { schema: k.schema, table: k.table, q: k.q, filter: k.filter };
	});

	/** The best total we have: exact when counted, the planner's estimate while counting an unfiltered table. */
	const total = (): { n: number; exact: boolean } | null => {
		const short = shortPage();
		if (short !== null) return { n: short, exact: true };
		const k = rows.dataKey();
		const ck = counter.dataKey();
		const c = counter.data();
		if (
			k &&
			ck &&
			c &&
			ck.schema === k.schema &&
			ck.table === k.table &&
			ck.q === k.q &&
			ck.filter === k.filter
		)
			return { n: c.count, exact: true };
		if (k && !filtered() && props.approxRows !== null) return { n: props.approxRows, exact: false };
		return null;
	};

	/** An offset past the end, as from an old link, moves to the last page once the count is known. */
	createEffect(() => {
		const r = result();
		const k = rows.dataKey();
		const t = total();
		// Once moved, the URL no longer holds the empty page's offset, so this does not repeat.
		if (!r || !k || r.rows.length || k.offset === 0 || !t?.exact || view().offset !== k.offset)
			return;
		const last = Math.max(0, Math.floor((t.n - 1) / k.limit) * k.limit);
		if (last !== k.offset) untrack(() => setView({ offset: last }));
	});

	/** Whether the rows shown are a subset: a raw WHERE, or a builder with at least one filter. */
	const filtered = () => {
		const k = rows.dataKey();
		if (!k) return false;
		if (k.filter) return true;
		return (decodeBuilder(k.q ?? null)?.filters.length ?? 0) > 0;
	};

	const info = () => {
		const r = result();
		if (!r) return "";
		const offset = rows.dataKey()?.offset ?? 0;
		const n = r.rows.length;
		const t = total();
		const range = n
			? `rows ${(offset + 1).toLocaleString()} to ${(offset + n).toLocaleString()}`
			: "no rows";
		const of = t ? ` of ${t.exact ? "" : "about "}${t.n.toLocaleString()}` : "";
		return `${range}${of}${filtered() ? " matching" : ""}`;
	};

	createEffect(
		on(rows.data, () => {
			if (props.active && result()) announce(`${props.table}: ${info()}`);
		}),
	);

	return (
		<div class="pane rows-pane">
			<Show
				when={sqlMode()}
				fallback={
					<QueryBar
						columns={columns()}
						draft={draft()}
						setDraft={setDraft}
						dirty={dirty()}
						onApply={() => applyBuilder(draft())}
						onRevert={() => setDraft(applied() ?? emptyBuilder)}
						onClear={() => {
							setDraft(emptyBuilder);
							applyBuilder(emptyBuilder);
						}}
						onRemoveFilter={(i) => {
							const d = draft();
							const f = d.filters[i];
							if (!f) return;
							removeRow(
								{ ...d, filters: d.filters.filter((_, k) => k !== i) },
								dropFilter(applied(), f),
							);
						}}
						onRemoveSort={(i) => {
							const d = draft();
							const s = d.sorts[i];
							if (!s) return;
							removeRow(
								{ ...d, sorts: d.sorts.filter((_, k) => k !== i) },
								dropSort(applied(), s.c),
							);
						}}
						onEditSql={toSql}
					/>
				}
			>
				<div class="bar raw-bar">
					<input
						ref={props.filterRef}
						type="text"
						class="grow mono raw-where"
						aria-label="Filter rows, as a SQL WHERE condition"
						placeholder="WHERE …   e.g.  id > 100 and email like '%@example.com'"
						autocomplete="off"
						spellcheck={false}
						value={rawFilter()}
						onInput={(e) => setRawFilter(e.currentTarget.value)}
						onKeyDown={(e) => e.key === "Enter" && applyRaw()}
					/>
					<input
						type="text"
						class="ord mono"
						aria-label="Order rows, as a SQL ORDER BY list"
						placeholder="ORDER BY …"
						autocomplete="off"
						spellcheck={false}
						value={rawOrder()}
						onInput={(e) => setRawOrder(e.currentTarget.value)}
						onKeyDown={(e) => e.key === "Enter" && applyRaw()}
					/>
					<Button
						variant="quiet"
						icon="filter"
						tip="Back to the filter and sort builder"
						onClick={toBuilder}
					>
						Builder
					</Button>
					<Button variant={dirty() ? "primary" : "default"} kbd="Enter" onClick={applyRaw}>
						Apply
					</Button>
				</div>
			</Show>

			<Show when={rows.error()}>
				{(err) => (
					<ErrorBox error={err()} inline>
						<Show when={suggestion()}>
							{(s) => (
								<Button
									size="sm"
									onClick={() => {
										const swap = (t: string) => t.replaceAll(s().bad, s().fix);
										const b = applied();
										if (b)
											applyBuilder({
												...b,
												filters: b.filters.map((f) => ({ ...f, c: swap(f.c) })),
											});
										else
											setView({
												filter: swap(view().filter),
												order: swap(view().order),
												offset: 0,
											});
									}}
								>
									Use <span class="mono">{s().fix}</span> instead of{" "}
									<span class="mono">{s().bad}</span>
								</Button>
							)}
						</Show>
						<Show when={query().q || query().filter || query().order}>
							<Button
								variant="quiet"
								size="sm"
								onClick={() => {
									setDraft(emptyBuilder);
									setSqlMode(false);
									applyBuilder(emptyBuilder);
								}}
							>
								Clear filter and sort
							</Button>
						</Show>
					</ErrorBox>
				)}
			</Show>

			<Show
				when={result()}
				fallback={
					<Show when={rows.loading()}>
						<Loading label="Loading rows" />
					</Show>
				}
			>
				{(r) => (
					<div class="pane" classList={{ busy: rows.loading() }}>
						<Grid
							result={r()}
							hidden={hidden}
							selection={selection}
							label={`${props.schema}.${props.table}`}
							offset={rows.dataKey()?.offset ?? 0}
							sorts={applied()?.sorts ?? []}
							onSort={sortBy}
							columnInfo={(name) => props.detail?.columns.find((c) => c.name === name)}
							links={links()}
							actions={headerActions}
							stale={!!rows.error()}
						/>
					</div>
				)}
			</Show>

			<div class="status">
				<Show
					when={result()}
					fallback={
						<Show when={rows.loading()}>
							<span class="st-note st-loading">
								<Loader size={12} />
								Loading rows
							</span>
						</Show>
					}
				>
					{(r) => {
						const offset = () => rows.dataKey()?.offset ?? 0;
						return (
							<p class="st-summary">
								<Show
									when={r().rows.length}
									fallback={
										<span class="st-word">{filtered() ? "No matching rows" : "No rows"}</span>
									}
								>
									<span class="st-num">{(offset() + 1).toLocaleString()}</span>
									<span class="st-dash">–</span>
									<span class="st-num">{(offset() + r().rows.length).toLocaleString()}</span>
									<Show when={total() || counter.loading() || counter.error()?.code === "timeout"}>
										<span class="st-word">of</span>
										<Show
											when={total()}
											fallback={
												<Show
													when={counter.error()?.code !== "timeout"}
													fallback={
														<span class="st-pending">
															{(offset() + r().rows.length).toLocaleString()}+
														</span>
													}
												>
													<span class="st-pending st-loading">
														<Loader size={12} />
														counting
													</span>
												</Show>
											}
										>
											{(t) => (
												<span class="st-num" classList={{ approx: !t().exact }}>
													{t().exact ? "" : "~"}
													{t().n.toLocaleString()}
												</span>
											)}
										</Show>
									</Show>
									<span class="st-word">{filtered() ? "matching rows" : "rows"}</span>
								</Show>
								<span class="st-sep" aria-hidden="true" />
								<Show
									when={rows.loading()}
									fallback={<span class="st-time">{formatMs(r().elapsedMs)}</span>}
								>
									<span class="st-time st-loading">
										<Loader size={12} />
										<span class="sr-only">Loading rows</span>
									</span>
								</Show>
								<Show when={rows.error()}>
									<span class="st-warn">last good result</span>
								</Show>
							</p>
						);
					}}
				</Show>
				<SelectionNote selection={selection} total={result()?.rows.length ?? 0} />
				<span class="spacer" />
				<HiddenButton hidden={hidden} />
				<Show when={result()}>
					{(r) => (
						<Pager
							offset={rows.dataKey()?.offset ?? 0}
							limit={view().limit}
							shown={r().rows.length}
							total={total()?.exact ? (total()?.n ?? null) : null}
							busy={rows.loading()}
							onOffset={(offset) => setView({ offset })}
							onLimit={(limit) =>
								setView({ limit, offset: Math.floor(view().offset / limit) * limit })
							}
						/>
					)}
				</Show>
			</div>
		</div>
	);
}
