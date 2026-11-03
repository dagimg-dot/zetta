import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { browse, type Column, getColumns } from "../api";
import { formatMs } from "../format";
import { createRequest } from "../request";
import { setView, view } from "../url";
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

	const result = () => {
		const k = rows.dataKey();
		const t = target();
		if (rows.error() || !k || !t || k.schema !== t.schema || k.table !== t.table) return undefined;
		return rows.data();
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
		return `${t.schema}.${t.table} · ${range}${of} · ${formatMs(r.elapsedMs)}`;
	};

	return (
		<section class="pane" hidden={!props.active}>
			<div class="bar">
				<input
					type="text"
					class="grow mono"
					placeholder="WHERE …   e.g.  id > 100 and email like '%@x.io'"
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
			<Show when={target()} fallback={<div class="empty">Pick a table on the left.</div>}>
				<Show when={rows.error()}>{(err) => <ErrorBox error={err()} />}</Show>
				<Show
					when={result()}
					fallback={
						<Show when={rows.loading()}>
							<div class="empty">Loading</div>
						</Show>
					}
				>
					{(r) => (
						<div class="pane" classList={{ busy: rows.loading() }}>
							<Grid
								result={r()}
								hidden={hidden}
								offset={rows.dataKey()?.offset ?? 0}
								sort={parseSort(view().order)}
								onSort={sortBy}
								columnInfo={(name) => columnMap().get(name)}
							/>
						</div>
					)}
				</Show>
			</Show>
			<div class="status">
				<span class="info">{rows.loading() && !result() ? "Loading…" : info()}</span>
				<span class="spacer" />
				<HiddenButton hidden={hidden} />
				<button
					type="button"
					class="btn"
					disabled={!result() || view().offset === 0 || rows.loading()}
					onClick={() => setView({ offset: Math.max(0, view().offset - PAGE) })}
				>
					<Icon name="prev" />
					Prev
				</button>
				<button
					type="button"
					class="btn"
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
