import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type {
	ApiError,
	Catalog,
	FunctionInfo,
	FunctionKind,
	Meta,
	SchemaInfo,
	TableInfo,
	TableKind,
} from "../../lib/api";
import { splitViews, viewsStartOpen } from "../../lib/relations";
import { sidebarWidth } from "../../stores/layout";
import { openFunction, openTable, view } from "../../stores/view";
import { Button } from "../ui/Button";
import { ErrorBox } from "../ui/ErrorBox";
import { Icon, Mark } from "../ui/icons";
import { Kbd } from "../ui/Kbd";
import { SkeletonTree } from "../ui/Skeleton";
import { Splitter } from "../ui/Splitter";
import { tip } from "../ui/Tip";
import { ThemeSwitch } from "./ThemeSwitch";
import "./sidebar.css";

const kindLabel: Record<TableKind, string | null> = {
	table: null,
	view: null,
	materialized_view: "mat view",
	foreign_table: "foreign",
};

const functionBadge: Record<FunctionKind, string | null> = {
	function: null,
	procedure: "proc",
	aggregate: "agg",
	window: "window",
};

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function approx(n: number): string {
	return `~${n < 10000 ? n.toLocaleString() : compact.format(n)}`;
}

function matches(q: string, schema: string, item: { name: string }): boolean {
	return item.name.toLowerCase().includes(q) || schema.toLowerCase().includes(q);
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
			const functions = s.functions.filter((f) => matches(q, s.name, f));
			if (tables.length || functions.length) out.push({ name: s.name, tables, functions });
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

	const hasFunctions = () => schemas().some((s) => s.functions.length > 0);
	const searchLabel = () => (hasFunctions() ? "Search tables and functions" : "Search tables");

	/** A search unfolds every group, without changing what the reader folded by hand. */
	const groupOpen = (key: string, startOpen: boolean) =>
		query().trim() ? true : (toggled()[key] ?? startOpen);

	const open = (schema: string, table: string) => {
		openTable(schema, table);
		props.onOpen();
	};

	const openFirst = () => {
		const s = shown()[0];
		if (!s) return;
		const { tables, views } = splitViews(s.tables);
		const t = tables[0] ?? views[0];
		const f = s.functions[0];
		if (t) open(s.name, t.name);
		else if (f) {
			openFunction(s.name, f.name, f.arguments);
			props.onOpen();
		} else return;
		setQuery("");
	};

	const TableRow = (p: { schema: string; t: TableInfo; nested?: boolean }) => {
		const active = () => view().schema === p.schema && view().table === p.t.name;
		const kind = kindLabel[p.t.kind];
		return (
			<button
				type="button"
				class="tbl"
				classList={{ active: active(), nested: p.nested }}
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

	const FunctionRow = (p: { schema: string; f: FunctionInfo }) => {
		const active = () =>
			view().schema === p.schema && view().fn === p.f.name && view().args === p.f.arguments;
		const badge = p.f.returns === "trigger" ? "trigger" : functionBadge[p.f.kind];
		return (
			<button
				type="button"
				class="tbl nested"
				classList={{ active: active() }}
				aria-current={active() ? "page" : undefined}
				{...tip(
					`${p.f.name}(${p.f.arguments})${p.f.returns ? ` returns ${p.f.returns}` : ""}`,
					undefined,
					"right",
				)}
				onClick={() => {
					openFunction(p.schema, p.f.name, p.f.arguments);
					props.onOpen();
				}}
			>
				<Icon name="function" />
				<span class="name">{p.f.name}</span>
				<span class="args">({p.f.arguments})</span>
				<Show when={badge}>
					<span class="badge">{badge}</span>
				</Show>
			</button>
		);
	};

	const Group = (p: {
		label: string;
		schema: string;
		count: number;
		startOpen: boolean;
		children: JSX.Element;
	}) => {
		const key = () => `${p.label}\u0000${p.schema}`;
		const isGroupOpen = () => groupOpen(key(), p.startOpen);
		return (
			<>
				<button
					type="button"
					class="sub-group"
					aria-expanded={isGroupOpen()}
					aria-label={`${p.label} in ${p.schema}, ${p.count}`}
					onClick={() => setToggled({ ...toggled(), [key()]: !isGroupOpen() })}
				>
					<Icon name="chevron" class="chev" size={11} />
					<span>{p.label}</span>
					<span class="count" aria-hidden="true">
						{p.count}
					</span>
				</button>
				<Show when={isGroupOpen()}>{p.children}</Show>
			</>
		);
	};

	const SchemaItems = (p: { schema: SchemaInfo }) => {
		const relations = createMemo(() => splitViews(p.schema.tables));
		const openTableName = () => (view().schema === p.schema.name ? view().table : null);
		const functionOpen = () => view().fn !== null && view().schema === p.schema.name;
		return (
			<>
				<Show
					when={p.schema.tables.length || p.schema.functions.length}
					fallback={<div class="note">No tables</div>}
				>
					<For each={relations().tables}>{(t) => <TableRow schema={p.schema.name} t={t} />}</For>
				</Show>
				<Show when={relations().views.length}>
					<Group
						label="Views"
						schema={p.schema.name}
						count={relations().views.length}
						startOpen={viewsStartOpen(relations(), openTableName())}
					>
						<For each={relations().views}>
							{(t) => <TableRow schema={p.schema.name} t={t} nested />}
						</For>
					</Group>
				</Show>
				<Show when={p.schema.functions.length}>
					<Group
						label="Functions"
						schema={p.schema.name}
						count={p.schema.functions.length}
						startOpen={functionOpen()}
					>
						<For each={p.schema.functions}>
							{(f) => <FunctionRow schema={p.schema.name} f={f} />}
						</For>
					</Group>
				</Show>
			</>
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
				<Show
					when={props.meta}
					fallback={
						<div class="meta">
							<span class="sk-bar" style={{ width: "60%" }} />
						</div>
					}
				>
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
					aria-label={searchLabel()}
					placeholder={searchLabel()}
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
			<div class="tree" classList={{ flat: flat(), ready: !!props.catalog }}>
				<Show when={props.error}>{(err) => <ErrorBox error={err()} />}</Show>
				<Show when={!props.catalog && props.loading}>
					<SkeletonTree label="Loading tables" />
				</Show>
				<Show when={props.catalog && !shown().length}>
					<div class="empty">{query().trim() ? "Nothing matches" : "No schemas"}</div>
				</Show>
				<Show
					when={!flat()}
					fallback={<Show when={shown()[0]}>{(s) => <SchemaItems schema={s()} />}</Show>}
				>
					<For each={shown()}>
						{(s) => {
							const count = splitViews(s.tables).tables.length;
							return (
								<div class="schema">
									<button
										type="button"
										class="schema-head"
										aria-expanded={isOpen(s.name)}
										aria-label={`Schema ${s.name}, ${count} ${count === 1 ? "table" : "tables"}`}
										onClick={() => toggle(s.name)}
									>
										<Icon name="chevron" class="chev" size={11} />
										<span>{s.name}</span>
										<Show when={count}>
											<span class="count" aria-hidden="true">
												{count}
											</span>
										</Show>
									</button>
									<Show when={isOpen(s.name)}>
										<SchemaItems schema={s} />
									</Show>
								</div>
							);
						}}
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
