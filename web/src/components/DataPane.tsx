import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { announce } from "../announce";
import { browse, type Column, getColumns } from "../api";
import { formatMs } from "../format";
import { createRequest } from "../request";
import { setView, view } from "../url";
import { closest, unknownColumn } from "../value";
import { ErrorBox } from "./ErrorBox";
import { createHidden, Grid, HiddenButton, type Sort } from "./Grid";
import { Icon } from "./icons";

const PAGE = 100;

function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/** The sort icons only reflect an ORDER BY that is exactly one quoted column with an optional direction. */
function parseSort(order: string): Sort | null {
	const m = /^"((?:[^"]|"")+)"(?:\s+(asc|desc))?\s*$/i.exec(order.trim());
	if (!m?.[1]) return null;
	return {
		col: m[1].replaceAll('""', '"'),
		dir: m[2]?.toLowerCase() === "desc" ? "desc" : "asc",
	};
}

function nextOrder(order: string, col: string): string {
	const cur = parseSort(order);
	if (!cur || cur.col !== col) return `${quoteIdent(col)} asc`;
	return cur.dir === "asc" ? `${quoteIdent(col)} desc` : "";
}

export function DataPane(props: {
	active: boolean;
	approxRows: (schema: string, table: string) => number | null;
	filterRef?: (el: HTMLInputElement) => void;
}) {
	const [filter, setFilter] = createSignal(view().filter);
	const [order, setOrder] = createSignal(view().order);
	const hidden = createHidden();

	const applied = {
		filter: createMemo(() => view().filter),
		order: createMemo(() => view().order),
		offset: createMemo(() => view().offset),
	};
	createEffect(on(applied.filter, (f) => setFilter(f)));
	createEffect(on(applied.order, (o) => setOrder(o)));

	const targetKey = createMemo(() => {
		const v = view();
		return v.schema !== null && v.table !== null ? `${v.schema}\u0000${v.table}` : "";
	});
	const target = createMemo(() => {
		if (!targetKey()) return null;
		const v = view();
		return v.schema !== null && v.table !== null ? { schema: v.schema, table: v.table } : null;
	});
	createEffect(on(targetKey, () => hidden.clear(), { defer: true }));

	const rows = createRequest(browse, () => {
		const t = target();
		if (!t || !props.active) return null;
		return {
			...t,
			filter: applied.filter(),
			order: applied.order(),
			limit: PAGE,
			offset: applied.offset(),
		};
	});

	const columns = createRequest(
		(t: { schema: string; table: string }) => getColumns(t.schema, t.table),
		() => (props.active ? target() : null),
	);

	const columnMap = createMemo(() => {
		const m = new Map<string, Column>();
		for (const c of columns.data()?.columns ?? []) m.set(c.name, c);
		return m;
	});

	const apply = () => setView({ filter: filter().trim(), order: order().trim(), offset: 0 });

	const sortBy = (col: string) => {
		const next = nextOrder(view().order, col);
		setOrder(next);
		setView({ filter: filter().trim(), order: next, offset: 0 });
	};

	const onKey = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
		if (e.key === "Enter") apply();
		if (e.key === "Escape") {
			setFilter(view().filter);
			setOrder(view().order);
		}
	};

	const dirty = () => filter().trim() !== view().filter || order().trim() !== view().order;

	/** The last result for this table, kept on screen (dimmed) while a newer request failed. */
	const result = () => {
		const k = rows.dataKey();
		const t = target();
		if (!k || !t || k.schema !== t.schema || k.table !== t.table) return undefined;
		return rows.data();
	};

	const suggestion = () => {
		const err = rows.error();
		if (!err) return null;
		const bad = unknownColumn(err.message);
		if (!bad) return null;
		const names = [...columnMap().keys()];
		const fix = closest(bad, names.length ? names : (result()?.columns.map((c) => c.name) ?? []));
		return fix && fix !== bad ? { bad, fix } : null;
	};

	const applySuggestion = (bad: string, fix: string) => {
		const swap = (s: string) =>
			s.replace(new RegExp(`\\b${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), fix);
		const f = swap(filter());
		const o = swap(order());
		setFilter(f);
		setOrder(o);
		setView({ filter: f.trim(), order: o.trim(), offset: 0 });
	};

	const clearFilter = () => {
		setFilter("");
		setOrder("");
		setView({ filter: "", order: "", offset: 0 });
	};

	const info = () => {
		const t = target();
		const r = result();
		if (!t || !r) return "";
		const offset = rows.dataKey()?.offset ?? 0;
		const n = r.rows.length;
		const range = n
			? `rows ${(offset + 1).toLocaleString()}–${(offset + n).toLocaleString()}`
			: "no rows";
		const total = props.approxRows(t.schema, t.table);
		const of = total !== null && !view().filter ? ` of ~${total.toLocaleString()}` : "";
		return `${range}${of} · ${formatMs(r.elapsedMs)}`;
	};

	createEffect(
		on(rows.data, () => {
			const t = target();
			if (t && props.active) announce(`${t.table}: ${info()}`);
		}),
	);

	return (
		<section
			class="pane"
			hidden={!props.active}
			id="pane-data"
			role="tabpanel"
			aria-labelledby="tab-data"
		>
			<div class="bar">
				<input
					ref={props.filterRef}
					type="text"
					class="grow mono"
					aria-label="Filter rows, as a SQL WHERE condition"
					placeholder="WHERE …   e.g.  id > 100 and email like '%@example.com'"
					autocomplete="off"
					spellcheck={false}
					disabled={!target()}
					value={filter()}
					onInput={(e) => setFilter(e.currentTarget.value)}
					onKeyDown={onKey}
				/>
				<input
					type="text"
					class="ord mono"
					aria-label="Order rows, as a SQL ORDER BY list"
					placeholder="ORDER BY …"
					autocomplete="off"
					spellcheck={false}
					disabled={!target()}
					value={order()}
					onInput={(e) => setOrder(e.currentTarget.value)}
					onKeyDown={onKey}
				/>
				<button
					type="button"
					class="btn"
					classList={{ primary: dirty() }}
					disabled={!target()}
					onClick={apply}
				>
					Apply
				</button>
			</div>
			<Show
				when={target()}
				fallback={
					<div class="empty">
						<strong>Pick a table</strong>
						Choose one on the left, or press <kbd>/</kbd> to search. <kbd>?</kbd> lists every
						shortcut.
					</div>
				}
			>
				<Show when={rows.error()}>
					{(err) => (
						<ErrorBox error={err()} inline>
							<Show when={suggestion()}>
								{(s) => (
									<button
										type="button"
										class="btn"
										onClick={() => applySuggestion(s().bad, s().fix)}
									>
										Use <span class="mono">{s().fix}</span> instead of{" "}
										<span class="mono">{s().bad}</span>
									</button>
								)}
							</Show>
							<Show when={view().filter || view().order}>
								<button type="button" class="btn quiet" onClick={clearFilter}>
									Clear filter and order
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
								label={`${target()?.schema}.${target()?.table}`}
								offset={rows.dataKey()?.offset ?? 0}
								sort={parseSort(view().order)}
								onSort={sortBy}
								columnInfo={(name) => columnMap().get(name)}
								stale={!!rows.error()}
							/>
						</div>
					)}
				</Show>
			</Show>
			<div class="status">
				<span class="info">
					{rows.loading() && !result()
						? "Loading…"
						: rows.error() && result()
							? "Showing the last good result"
							: info()}
				</span>
				<span class="spacer" />
				<HiddenButton hidden={hidden} />
				<button
					type="button"
					class="btn"
					title="Previous page ([)"
					disabled={!result() || view().offset === 0 || rows.loading()}
					onClick={() => setView({ offset: Math.max(0, view().offset - PAGE) })}
				>
					<Icon name="prev" />
					Prev
				</button>
				<button
					type="button"
					class="btn"
					title="Next page (])"
					disabled={!result() || (result()?.rows.length ?? 0) < PAGE || rows.loading()}
					onClick={() => setView({ offset: view().offset + PAGE })}
				>
					Next
					<Icon name="next" />
				</button>
			</div>
		</section>
	);
}

export const PAGE_SIZE = PAGE;
