import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ApiError, Catalog, Meta, SchemaInfo, TableInfo, TableKind } from "../api";
import { openTable, view } from "../url";
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./icons";

const kindLabel: Record<TableKind, string | null> = {
	table: null,
	view: "view",
	materialized_view: "mat view",
	foreign_table: "foreign",
};

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function approx(n: number): string {
	return `~${n < 10000 ? n.toLocaleString() : compact.format(n)}`;
}

function matches(q: string, schema: string, t: TableInfo): boolean {
	return t.name.toLowerCase().includes(q) || schema.toLowerCase().includes(q);
}

export function Sidebar(props: {
	meta: Meta | undefined;
	catalog: Catalog | undefined;
	error: ApiError | undefined;
	loading: boolean;
	onRefresh: () => void;
}) {
	let search: HTMLInputElement | undefined;
	const [query, setQuery] = createSignal("");
	const [toggled, setToggled] = createSignal<Record<string, boolean>>({});

	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
		const el = document.activeElement;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
		if (el instanceof HTMLElement && el.isContentEditable) return;
		e.preventDefault();
		search?.focus();
		search?.select();
	};
	onMount(() => addEventListener("keydown", onKey));
	onCleanup(() => removeEventListener("keydown", onKey));

	const schemas = () => props.catalog?.schemas ?? [];
	const flat = () => props.meta?.capabilities.schemas === false && schemas().length === 1;
	const showRows = () => props.meta?.capabilities.approxRows !== false;

	const shown = createMemo(() => {
		const q = query().trim().toLowerCase();
		const all = schemas();
		if (!q) return all;
		const out: SchemaInfo[] = [];
		for (const s of all) {
			const tables = s.tables.filter((t) => matches(q, s.name, t));
			if (tables.length) out.push({ name: s.name, tables });
		}
		return out;
	});

	const isOpen = (name: string) => {
		if (query().trim()) return true;
		const t = toggled()[name];
		if (t !== undefined) return t;
		return name === view().schema || name === "public" || name === "main" || schemas().length === 1;
	};

	const toggle = (name: string) => setToggled({ ...toggled(), [name]: !isOpen(name) });

	const TableRow = (p: { schema: string; t: TableInfo }) => {
		const active = () => view().schema === p.schema && view().table === p.t.name;
		const kind = kindLabel[p.t.kind];
		return (
			<button
				type="button"
				class="tbl"
				classList={{ active: active() }}
				title={`${p.schema}.${p.t.name}`}
				onClick={() => openTable(p.schema, p.t.name)}
			>
				<Icon name={p.t.kind === "table" ? "table" : "view"} />
				<span class="name">{p.t.name}</span>
				<Show when={kind}>
					<span class="badge">{kind}</span>
				</Show>
				<Show when={showRows() && p.t.approxRows !== null}>
					<span class="rows" title={`About ${p.t.approxRows?.toLocaleString()} rows`}>
						{approx(p.t.approxRows ?? 0)}
					</span>
				</Show>
			</button>
		);
	};

	return (
		<aside>
			<header>
				<div class="brand">
					<b>zetta</b>
					<Show when={props.meta}>{(m) => <span class="version">{m().version}</span>}</Show>
					<span class="spacer" />
					<button
						type="button"
						class="btn icon-only"
						title="Reload schemas"
						disabled={props.loading}
						onClick={() => props.onRefresh()}
					>
						<Icon name="refresh" />
					</button>
				</div>
				<Show when={props.meta}>
					{(m) => (
						<div class="meta">
							<Icon name="database" />
							<span class="db" title={m().database}>
								{m().database}
							</span>
							<span class="badge">{m().adapter}</span>
							<Show when={m().readOnly}>
								<span class="badge ro" title="Writes are rejected by the server">
									<Icon name="lock" size={10} />
									read-only
								</span>
							</Show>
						</div>
					)}
				</Show>
			</header>
			<div class="find">
				<Icon name="search" />
				<input
					ref={search}
					type="search"
					placeholder="Filter tables"
					autocomplete="off"
					spellcheck={false}
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setQuery("");
							e.currentTarget.blur();
						}
					}}
				/>
				<kbd>/</kbd>
			</div>
			<div class="tree" classList={{ flat: flat() }}>
				<Show when={props.error}>{(err) => <ErrorBox error={err()} />}</Show>
				<Show when={!props.catalog && props.loading}>
					<div class="empty">Loading</div>
				</Show>
				<Show when={props.catalog && !shown().length}>
					<div class="empty">{query().trim() ? "No matches" : "No schemas"}</div>
				</Show>
				<Show
					when={!flat()}
					fallback={
						<For each={shown()[0]?.tables ?? []}>
							{(t) => <TableRow schema={shown()[0]?.name ?? ""} t={t} />}
						</For>
					}
				>
					<For each={shown()}>
						{(s) => (
							<div class="schema">
								<button
									type="button"
									class="schema-head"
									classList={{ open: isOpen(s.name) }}
									onClick={() => toggle(s.name)}
								>
									<Icon name="chevron" class="chev" size={11} />
									<span>{s.name}</span>
									<span class="count">{s.tables.length}</span>
								</button>
								<Show when={isOpen(s.name)}>
									<Show when={s.tables.length} fallback={<div class="note">No tables</div>}>
										<For each={s.tables}>{(t) => <TableRow schema={s.name} t={t} />}</For>
									</Show>
								</Show>
							</div>
						)}
					</For>
				</Show>
			</div>
		</aside>
	);
}
