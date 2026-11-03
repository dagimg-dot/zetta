import { createMemo, For, Match, Show, Switch } from "solid-js";
import { getTable, type TableDetail } from "../api";
import type { Dialect } from "../query";
import { createRequest } from "../request";
import { type Pane, setView, view } from "../url";
import { formatBytes } from "../value";
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./icons";
import { Relationships } from "./Relationships";
import { RowsPane } from "./RowsPane";
import { DdlPane, IndexesPane, StructurePane, TriggersPane } from "./TableInfo";

const kindLabel: Record<string, string> = {
	table: "table",
	view: "view",
	materialized_view: "materialized view",
	foreign_table: "foreign table",
};

const tabs: { pane: Pane; label: string; count?: (d: TableDetail) => number }[] = [
	{ pane: "rows", label: "Rows" },
	{ pane: "structure", label: "Structure", count: (d) => d.columns.length },
	{ pane: "indexes", label: "Indexes", count: (d) => d.indexes.length },
	{
		pane: "relationships",
		label: "Relationships",
		count: (d) => d.foreignKeys.length + d.referencedBy.length,
	},
	{ pane: "triggers", label: "Triggers", count: (d) => d.triggers.length },
	{ pane: "ddl", label: "DDL" },
];

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function DataPane(props: {
	active: boolean;
	dialect: Dialect;
	approxRows: (schema: string, table: string) => number | null;
	filterRef?: (el: HTMLInputElement) => void;
}) {
	const target = createMemo(
		() => {
			const v = view();
			return v.schema !== null && v.table !== null ? { schema: v.schema, table: v.table } : null;
		},
		undefined,
		{ equals: (a, b) => a?.schema === b?.schema && a?.table === b?.table },
	);

	const detail = createRequest(
		(t: { schema: string; table: string }) => getTable(t.schema, t.table),
		() => (props.active ? target() : null),
	);

	/** Only the detail for the open table counts; a slower answer for the previous one is ignored. */
	const current = () => {
		const k = detail.dataKey();
		const t = target();
		return k && t && k.schema === t.schema && k.table === t.table ? detail.data() : undefined;
	};

	const approx = () => {
		const t = target();
		return current()?.approxRows ?? (t ? props.approxRows(t.schema, t.table) : null);
	};

	const stats = () => {
		const d = current();
		if (!d) return [];
		const out: string[] = [];
		const rows = approx();
		if (rows !== null)
			out.push(`~${rows < 10000 ? rows.toLocaleString() : compact.format(rows)} rows`);
		if (d.sizeBytes) out.push(formatBytes(d.sizeBytes.total));
		out.push(plural(d.columns.length, "column"));
		if (d.indexes.length) out.push(plural(d.indexes.length, "index", "indexes"));
		const rels = d.foreignKeys.length + d.referencedBy.length;
		if (rels) out.push(plural(rels, "relationship"));
		if (d.triggers.length) out.push(plural(d.triggers.length, "trigger"));
		return out;
	};

	const select = (pane: Pane) => {
		if (view().pane !== pane) setView({ pane }, "push");
	};

	const onTabKey = (e: KeyboardEvent) => {
		if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
		const at = tabs.findIndex((t) => t.pane === view().pane);
		const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
		if (!next) return;
		select(next.pane);
		queueMicrotask(() => document.getElementById(`subtab-${next.pane}`)?.focus());
		e.preventDefault();
	};

	return (
		<section
			class="pane"
			hidden={!props.active}
			id="pane-data"
			role="tabpanel"
			aria-labelledby="tab-data"
		>
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
				{(t) => (
					<>
						<header class="table-head">
							<div class="table-title">
								<Icon
									name={current()?.kind === "table" || !current() ? "table" : "view"}
									size={14}
								/>
								<h1>
									<span class="schema">{t().schema}.</span>
									{t().table}
								</h1>
								<Show when={current() && current()?.kind !== "table"}>
									<span class="badge">{kindLabel[current()?.kind ?? "table"]}</span>
								</Show>
								<ul class="table-stats" aria-label="About this table">
									<For each={stats()}>{(s) => <li>{s}</li>}</For>
								</ul>
							</div>
							<Show when={current()?.comment}>
								<p class="table-comment">{current()?.comment}</p>
							</Show>
							<div
								class="subtabs"
								role="tablist"
								aria-label={`${t().table} views`}
								onKeyDown={onTabKey}
							>
								<For each={tabs}>
									{(tab) => (
										<button
											type="button"
											class="subtab"
											role="tab"
											id={`subtab-${tab.pane}`}
											aria-selected={view().pane === tab.pane}
											aria-controls="table-panel"
											tabIndex={view().pane === tab.pane ? 0 : -1}
											onClick={() => select(tab.pane)}
										>
											{tab.label}
											<Show when={tab.count && current()}>
												{(_) => {
													const n = () => {
														const d = current();
														return d && tab.count ? tab.count(d) : 0;
													};
													return (
														<span class="count" classList={{ zero: n() === 0 }}>
															{n()}
														</span>
													);
												}}
											</Show>
										</button>
									)}
								</For>
							</div>
						</header>

						<div
							class="table-panel"
							id="table-panel"
							role="tabpanel"
							aria-labelledby={`subtab-${view().pane}`}
						>
							<Switch>
								<Match when={view().pane === "rows"}>
									<RowsPane
										schema={t().schema}
										table={t().table}
										active={props.active}
										dialect={props.dialect}
										detail={current()}
										approxRows={approx()}
										filterRef={props.filterRef}
									/>
								</Match>
								<Match when={view().pane !== "rows"}>
									<Show
										when={current()}
										fallback={
											<Show when={detail.error()} fallback={<div class="empty">Loading…</div>}>
												{(err) => <ErrorBox error={err()} />}
											</Show>
										}
									>
										{(d) => (
											<Switch>
												<Match when={view().pane === "structure"}>
													<StructurePane detail={d()} />
												</Match>
												<Match when={view().pane === "indexes"}>
													<IndexesPane detail={d()} />
												</Match>
												<Match when={view().pane === "relationships"}>
													<Relationships detail={d()} />
												</Match>
												<Match when={view().pane === "triggers"}>
													<TriggersPane detail={d()} />
												</Match>
												<Match when={view().pane === "ddl"}>
													<DdlPane detail={d()} />
												</Match>
											</Switch>
										)}
									</Show>
								</Match>
							</Switch>
						</div>
					</>
				)}
			</Show>
		</section>
	);
}
