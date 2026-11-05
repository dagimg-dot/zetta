import { createMemo, createSignal, For, Show } from "solid-js";
import type { ApiError, Catalog, Meta, SchemaInfo, TableInfo, TableKind } from "../../lib/api";
import { sidebarWidth } from "../../stores/layout";
import { openTable, view } from "../../stores/view";
import { Button } from "../ui/Button";
import { ErrorBox } from "../ui/ErrorBox";
import { Icon, Mark } from "../ui/icons";
import { Kbd } from "../ui/Kbd";
import { Loading } from "../ui/Loading";
import { Splitter } from "../ui/Splitter";
import { tip } from "../ui/Tip";
import { ThemeSwitch } from "./ThemeSwitch";
import "./sidebar.css";

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
	onOpen: () => void;
	searchRef?: (el: HTMLInputElement) => void;
}) {
	const [query, setQuery] = createSignal("");
	const [toggled, setToggled] = createSignal<Record<string, boolean>>({});

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

	const open = (schema: string, table: string) => {
		openTable(schema, table);
		props.onOpen();
	};

	const openFirst = () => {
		const s = shown()[0];
		const t = s?.tables[0];
		if (s && t) {
			open(s.name, t.name);
			setQuery("");
		}
	};

	const TableRow = (p: { schema: string; t: TableInfo }) => {
		const active = () => view().schema === p.schema && view().table === p.t.name;
		const kind = kindLabel[p.t.kind];
		return (
			<button
				type="button"
				class="tbl"
				classList={{ active: active() }}
				aria-current={active() ? "page" : undefined}
				onClick={() => open(p.schema, p.t.name)}
			>
				<Icon name={p.t.kind === "table" ? "table" : "view"} />
				<span class="name">{p.t.name}</span>
				<Show when={kind}>
					<span class="badge">{kind}</span>
				</Show>
				<Show when={showRows() && p.t.approxRows !== null}>
					<span class="rows">{approx(p.t.approxRows ?? 0)}</span>
				</Show>
			</button>
		);
	};

	return (
		<aside aria-label="Tables">
			<header>
				<div class="brand">
					<Mark size={18} />
					<b>zetta</b>
					<Show when={props.meta}>{(m) => <span class="version">{m().version}</span>}</Show>
					<span class="spacer" />
					<Button
						icon="refresh"
						iconSize={14}
						label="Reload tables"
						busy={props.loading}
						onClick={() => props.onRefresh()}
					/>
				</div>
				<Show when={props.meta}>
					{(m) => (
						<div class="meta">
							<Icon name="database" />
							<span class="db" {...tip(m().database, undefined, "bottom")}>
								{m().database}
							</span>
							<span class="badge">{m().adapter}</span>
							<Show
								when={m().readOnly}
								fallback={
									<span
										class="badge rw"
										{...tip(
											"Writes are allowed. Start zetta with --read-only to refuse them",
											undefined,
											"bottom",
										)}
									>
										<Icon name="pencil" size={10} />
										read-write
									</span>
								}
							>
								<span
									class="badge ro"
									{...tip("Writes are refused by the server", undefined, "bottom")}
								>
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
					ref={props.searchRef}
					type="search"
					aria-label="Search tables"
					placeholder="Search tables"
					autocomplete="off"
					spellcheck={false}
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							openFirst();
						} else if (e.key === "Escape") {
							setQuery("");
							e.currentTarget.blur();
						}
					}}
				/>
				<Kbd keys="/" />
			</div>
			<div class="tree" classList={{ flat: flat() }}>
				<Show when={props.error}>{(err) => <ErrorBox error={err()} />}</Show>
				<Show when={!props.catalog && props.loading}>
					<Loading label="Loading tables" size={24} />
				</Show>
				<Show when={props.catalog && !shown().length}>
					<div class="empty">{query().trim() ? "No matching tables" : "No schemas"}</div>
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
									aria-expanded={isOpen(s.name)}
									aria-label={`Schema ${s.name}, ${s.tables.length} ${s.tables.length === 1 ? "table" : "tables"}`}
									onClick={() => toggle(s.name)}
								>
									<Icon name="chevron" class="chev" size={11} />
									<span>{s.name}</span>
									<span class="count" aria-hidden="true">
										{s.tables.length}
									</span>
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
			<footer class="sidebar-foot">
				<span class="label">Theme</span>
				<ThemeSwitch />
			</footer>
			<Splitter width={sidebarWidth} edge="right" label="Resize the sidebar" />
		</aside>
	);
}
