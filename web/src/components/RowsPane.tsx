import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { announce } from "../announce";
import { browse, countRows, type TableDetail } from "../api";
import { formatMs } from "../format";
import {
	type Builder,
	compileOrder,
	compileWhere,
	type Dialect,
	decodeBuilder,
	emptyBuilder,
	encodeBuilder,
	type Filter,
	quoteIdent,
	toggleSort,
} from "../query";
import { createRequest } from "../request";
import { openRowsWhere, openTable, setView, view } from "../url";
import { closest, unknownColumn } from "../value";
import type { ColumnChoice } from "./ColumnPicker";
import { ErrorBox } from "./ErrorBox";
import { createHidden, Grid, HiddenButton, type Links } from "./Grid";
import { Icon } from "./icons";
import { Pager } from "./Pager";
import { QueryBar } from "./QueryBar";

export function RowsPane(props: {
	schema: string;
	table: string;
	active: boolean;
	dialect: Dialect;
	detail: TableDetail | undefined;
	approxRows: number | null;
	filterRef?: (el: HTMLInputElement) => void;
}) {
	const hidden = createHidden();
	const applied = createMemo(() => decodeBuilder(view().q));
	const raw = createMemo(() => !view().q && (view().filter !== "" || view().order !== ""));
	const [sqlMode, setSqlMode] = createSignal(raw());
	const [draft, setDraft] = createSignal<Builder>(applied() ?? emptyBuilder);
	const [rawFilter, setRawFilter] = createSignal(view().filter);
	const [rawOrder, setRawOrder] = createSignal(view().order);

	createEffect(on(applied, (b) => setDraft(b ?? emptyBuilder), { defer: true }));
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

	/** What actually runs: the builder compiled for this database, or the raw SQL. */
	const query = createMemo(() => {
		const b = applied();
		if (b) return { filter: compileWhere(b, props.dialect), order: compileOrder(b) };
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

	const dirty = () =>
		sqlMode()
			? rawFilter().trim() !== view().filter ||
				rawOrder().trim() !== view().order ||
				view().q !== ""
			: encodeBuilder(draft()) !== view().q;

	const toBuilder = () => {
		setSqlMode(false);
		setView({ q: "", filter: "", order: "", offset: 0 });
	};

	const toSql = () => {
		const b = draft();
		setRawFilter(compileWhere(b, props.dialect));
		setRawOrder(compileOrder(b));
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
		return { schema: k.schema, table: k.table, filter: k.filter ?? "" };
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
			ck.filter === (k.filter ?? "")
		)
			return { n: c.count, exact: true };
		if (k && !k.filter && props.approxRows !== null) return { n: props.approxRows, exact: false };
		return null;
	};

	const filtered = () => !!rows.dataKey()?.filter;

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
						dialect={props.dialect}
						draft={draft()}
						setDraft={setDraft}
						dirty={dirty()}
						onApply={() => applyBuilder(draft())}
						onRevert={() => setDraft(applied() ?? emptyBuilder)}
						onClear={() => {
							setDraft(emptyBuilder);
							applyBuilder(emptyBuilder);
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
					<button
						type="button"
						class="btn quiet"
						onClick={toBuilder}
						title="Back to the filter and sort builder"
					>
						<Icon name="filter" />
						Builder
					</button>
					<button type="button" class="btn" classList={{ primary: dirty() }} onClick={applyRaw}>
						Apply
					</button>
				</div>
			</Show>

			<Show when={rows.error()}>
				{(err) => (
					<ErrorBox error={err()} inline>
						<Show when={suggestion()}>
							{(s) => (
								<button
									type="button"
									class="btn"
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
								</button>
							)}
						</Show>
						<Show when={query().filter || query().order}>
							<button
								type="button"
								class="btn quiet"
								onClick={() => {
									setDraft(emptyBuilder);
									setSqlMode(false);
									applyBuilder(emptyBuilder);
								}}
							>
								Clear filter and sort
							</button>
						</Show>
					</ErrorBox>
				)}
			</Show>

			<Show
				when={result()}
				fallback={
					<Show when={rows.loading()}>
						<div class="empty">Loading…</div>
					</Show>
				}
			>
				{(r) => (
					<div class="pane" classList={{ busy: rows.loading() }}>
						<Grid
							result={r()}
							hidden={hidden}
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
					fallback={<span class="st-note">{rows.loading() ? "Loading rows…" : ""}</span>}
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
												<span class="st-pending" classList={{ counting: counter.loading() }}>
													{counter.error()?.code === "timeout"
														? `${(offset() + r().rows.length).toLocaleString()}+`
														: "counting"}
												</span>
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
								<span class="st-time">{formatMs(r().elapsedMs)}</span>
								<Show when={rows.error()}>
									<span class="st-warn">last good result</span>
								</Show>
							</p>
						);
					}}
				</Show>
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
