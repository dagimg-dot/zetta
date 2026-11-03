import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/icons";
import { tip } from "../../components/ui/Tip";
import type { RefAction, TableDetail } from "../../lib/api";
import { kindNoun } from "../../lib/format";
import { openTable } from "../../stores/view";
import { RefActions } from "./parts";
import "./relationships.css";

interface Edge {
	key: string;
	name: string | null;
	schema: string;
	table: string;
	/** Columns on the referencing side, then on the referenced side. */
	from: string[];
	to: string[];
	onDelete: RefAction;
	onUpdate: RefAction;
	self: boolean;
}

/** One box in the diagram: a single foreign key, every key from one schema, or the remainder. */
type MapNode =
	| { kind: "table"; key: string; edge: Edge; edges: Edge[] }
	| { kind: "group"; key: string; schema: string; edges: Edge[] }
	| { kind: "more"; key: string; schemas: number; edges: Edge[] };

interface Path {
	key: string;
	d: string;
	head: string;
	weight: number;
}

/** Past this many boxes a side stops naming tables and summarises by schema instead. */
const PER_SIDE = 8;

function pairs(from: string[], to: string[]): string {
	return from.length === 1 ? `${from[0]} → ${to[0]}` : `(${from.join(", ")}) → (${to.join(", ")})`;
}

function count(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function byPlace(a: Edge, b: Edge): number {
	return a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table);
}

function nodesFor(edges: Edge[], side: "in" | "out"): MapNode[] {
	if (edges.length <= PER_SIDE)
		return edges.map((e) => ({ kind: "table", key: `${side}:${e.key}`, edge: e, edges: [e] }));
	const bySchema = new Map<string, Edge[]>();
	for (const e of edges) bySchema.set(e.schema, [...(bySchema.get(e.schema) ?? []), e]);
	const groups = [...bySchema]
		.map(([schema, list]) => ({ schema, list }))
		.sort((a, b) => b.list.length - a.list.length || a.schema.localeCompare(b.schema));
	const shown = groups.length > PER_SIDE ? groups.slice(0, PER_SIDE - 1) : groups;
	const nodes: MapNode[] = shown.map(({ schema, list }) => {
		const [only] = list;
		return list.length === 1 && only
			? { kind: "table", key: `${side}:${only.key}`, edge: only, edges: list }
			: { kind: "group", key: `${side}:s:${schema}`, schema, edges: list };
	});
	const rest = groups.slice(shown.length);
	if (rest.length)
		nodes.push({
			kind: "more",
			key: `${side}:more`,
			schemas: rest.length,
			edges: rest.flatMap((g) => g.list),
		});
	return nodes;
}

function distinctTables(edges: Edge[]): string[] {
	return [...new Set(edges.map((e) => e.table))];
}

/**
 * The table's neighbourhood: tables that reference it on the left, the table in the middle and the
 * tables it references on the right. Every arrow points the way its foreign key does. A busy side
 * is summarised by schema, and the lists below hold every key, searchable.
 */
export function Relationships(props: { detail: TableDetail }) {
	const here = () => `${props.detail.schema}.${props.detail.name}`;

	const incoming = createMemo<Edge[]>(() =>
		props.detail.referencedBy
			.map((r, i) => ({
				key: `in${i}`,
				name: r.name,
				schema: r.schema,
				table: r.table,
				from: r.columns,
				to: r.refColumns,
				onDelete: r.onDelete,
				onUpdate: r.onUpdate,
				self: r.schema === props.detail.schema && r.table === props.detail.name,
			}))
			.sort(byPlace),
	);
	const outgoing = createMemo<Edge[]>(() =>
		props.detail.foreignKeys
			.map((f, i) => ({
				key: `out${i}`,
				name: f.name,
				schema: f.refSchema,
				table: f.refTable,
				from: f.columns,
				to: f.refColumns,
				onDelete: f.onDelete,
				onUpdate: f.onUpdate,
				self: f.refSchema === props.detail.schema && f.refTable === props.detail.name,
			}))
			.sort(byPlace),
	);

	const left = createMemo(() => nodesFor(incoming(), "in"));
	const right = createMemo(() => nodesFor(outgoing(), "out"));

	/** Which diagram box each foreign key sits in, so a list row and its box light up together. */
	const nodeOf = createMemo(() => {
		const m = new Map<string, string>();
		for (const n of [...left(), ...right()]) for (const e of n.edges) m.set(e.key, n.key);
		return m;
	});

	const [hot, setHot] = createSignal<string | null>(null);
	const [paths, setPaths] = createSignal<Path[]>([]);
	const [size, setSize] = createSignal({ w: 0, h: 0 });
	const [query, setQuery] = createSignal("");

	let box: HTMLDivElement | undefined;
	let center: HTMLDivElement | undefined;
	let search: HTMLInputElement | undefined;
	let lists: HTMLDivElement | undefined;
	const els = new Map<string, HTMLElement>();

	createEffect(on(here, () => setQuery(""), { defer: true }));

	const layout = () => {
		if (!box || !center) return;
		const o = box.getBoundingClientRect();
		const rel = (r: DOMRect) => ({
			l: r.left - o.left,
			r: r.right - o.left,
			t: r.top - o.top,
			b: r.bottom - o.top,
		});
		const mid = rel(center.getBoundingClientRect());
		const spread = (i: number, n: number) => mid.t + ((mid.b - mid.t) * (i + 1)) / (n + 1);
		const curve = (x1: number, y1: number, x2: number, y2: number) => {
			const dx = Math.max(24, (x2 - x1) / 2);
			return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
		};
		const head = (x: number, y: number) => `M${x - 6},${y - 3.5} L${x},${y} L${x - 6},${y + 3.5}`;
		const out: Path[] = [];
		const ins = left();
		ins.forEach((node, i) => {
			const el = els.get(node.key);
			if (!el) return;
			const n = rel(el.getBoundingClientRect());
			const y2 = spread(i, ins.length);
			out.push({
				key: node.key,
				d: curve(n.r, (n.t + n.b) / 2, mid.l, y2),
				head: head(mid.l, y2),
				weight: node.edges.length,
			});
		});
		const outs = right();
		outs.forEach((node, i) => {
			const el = els.get(node.key);
			if (!el) return;
			const n = rel(el.getBoundingClientRect());
			const y = (n.t + n.b) / 2;
			out.push({
				key: node.key,
				d: curve(mid.r, spread(i, outs.length), n.l, y),
				head: head(n.l, y),
				weight: node.edges.length,
			});
		});
		setPaths(out);
		setSize({ w: o.width, h: o.height });
	};

	onMount(() => {
		const ro = new ResizeObserver(layout);
		if (box) ro.observe(box);
		onCleanup(() => ro.disconnect());
	});
	createEffect(on([left, right], () => queueMicrotask(layout)));

	/** The filter bar's height, so schema headings stick right under it. */
	const watchTools = (el: HTMLDivElement) => {
		const seen = new ResizeObserver(() =>
			lists?.style.setProperty("--tools-h", `${el.getBoundingClientRect().height}px`),
		);
		seen.observe(el);
		onCleanup(() => {
			seen.disconnect();
			lists?.style.removeProperty("--tools-h");
		});
	};

	const total = () => incoming().length + outgoing().length;

	/** Narrows the lists to one schema, from a schema box in the diagram. */
	const scopeTo = (text: string) => {
		setQuery(text);
		// Scrolls only the sheet: scrollIntoView would also shift the app shell around it.
		const sheet = lists?.closest<HTMLElement>(".sheet");
		if (sheet && lists) {
			const top =
				sheet.scrollTop + lists.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
			sheet.scrollTo({ top, behavior: "smooth" });
		}
		queueMicrotask(() => search?.focus({ preventScroll: true }));
	};

	const matches = (e: Edge) => {
		const q = query().trim().toLowerCase();
		if (!q) return true;
		const text = `${e.schema}.${e.table} ${e.from.join(" ")} ${e.to.join(" ")} ${e.name ?? ""}`;
		return text.toLowerCase().includes(q);
	};

	const summary = () => {
		const ins = incoming();
		const outs = outgoing();
		const parts: string[] = [];
		if (ins.length) {
			const tables = new Set(ins.map((e) => `${e.schema}.${e.table}`)).size;
			const schemas = new Set(ins.map((e) => e.schema)).size;
			parts.push(
				`${count(ins.length, "foreign key")} from ${count(tables, "table")}${schemas > 1 ? ` in ${count(schemas, "schema")}` : ""} ${ins.length === 1 ? "points" : "point"} here`,
			);
		}
		if (outs.length)
			parts.push(
				`${parts.length ? "it" : "It"} references ${count(new Set(outs.map((e) => `${e.schema}.${e.table}`)).size, "table")}`,
			);
		return `${parts.join("; ")}.`;
	};

	const name = (schema: string, table: string) => (
		<>
			<Show when={schema !== props.detail.schema}>
				<span class="schema">{schema}.</span>
			</Show>
			{table}
		</>
	);

	const node = (n: MapNode) => {
		const hover = {
			onMouseEnter: () => setHot(n.key),
			onMouseLeave: () => setHot(null),
			onFocus: () => setHot(n.key),
			onBlur: () => setHot(null),
		};
		const tables = distinctTables(n.edges);
		const preview =
			tables.slice(0, 3).join(", ") + (tables.length > 3 ? ` +${tables.length - 3}` : "");
		if (n.kind === "table") {
			const e = n.edge;
			return (
				<button
					type="button"
					class="rel-node"
					classList={{ hot: hot() === n.key, self: e.self }}
					ref={(el) => els.set(n.key, el)}
					{...hover}
					onClick={() => openTable(e.schema, e.table)}
					{...tip(`Open ${e.schema}.${e.table}`)}
				>
					<span class="t">
						<Icon name="table" />
						<span class="name">{name(e.schema, e.table)}</span>
						<Show when={e.self}>
							<span class="key quiet">self</span>
						</Show>
					</span>
					<span class="via mono">{pairs(e.from, e.to)}</span>
				</button>
			);
		}
		const label = n.kind === "group" ? n.schema : `${count(n.schemas, "more schema")}`;
		return (
			<button
				type="button"
				class="rel-node group"
				classList={{ hot: hot() === n.key, more: n.kind === "more" }}
				ref={(el) => els.set(n.key, el)}
				{...hover}
				onClick={() => scopeTo(n.kind === "group" ? `${n.schema}.` : "")}
				{...tip(
					n.kind === "group"
						? `List the ${count(n.edges.length, "key")} from ${n.schema}`
						: "Search every relationship",
				)}
			>
				<span class="t">
					<Icon name={n.kind === "group" ? "database" : "search"} />
					<span class="name">{label}</span>
					<span class="n">{n.edges.length.toLocaleString()}</span>
				</span>
				<span class="via">{preview}</span>
			</button>
		);
	};

	const list = (title: string, edges: Edge[], side: "in" | "out") => {
		const shown = () => edges.filter(matches);
		const manySchemas = side === "in" && new Set(edges.map((x) => x.schema)).size > 1;
		return (
			<section class="info-section">
				<header>
					<h2>{title}</h2>
					<span class="note">
						{query().trim() && edges.length
							? `${shown().length.toLocaleString()} of ${edges.length.toLocaleString()}`
							: edges.length.toLocaleString()}
					</span>
				</header>
				<Show
					when={edges.length}
					fallback={
						<p class="info-none">
							{side === "out"
								? `This ${kindNoun(props.detail.kind)} has no foreign keys.`
								: `No foreign key in this database points at this ${kindNoun(props.detail.kind)}.`}
						</p>
					}
				>
					<Show when={shown().length} fallback={<p class="info-none">No matching relationships</p>}>
						<ul class="info-list rel-list">
							<For each={shown()}>
								{(e, i) => (
									<>
										<Show when={manySchemas && shown()[i() - 1]?.schema !== e.schema}>
											<li class="rel-schema">{e.schema}</li>
										</Show>
										<li
											classList={{ hot: hot() !== null && hot() === nodeOf().get(e.key) }}
											onMouseEnter={() => setHot(nodeOf().get(e.key) ?? null)}
											onMouseLeave={() => setHot(null)}
										>
											<div class="line">
												<span class="mono">
													<Show
														when={side === "in"}
														fallback={<span class="strong">{props.detail.name}</span>}
													>
														<span class="strong">{name(e.schema, e.table)}</span>
													</Show>
													({e.from.join(", ")})
												</span>
												<span class="arrow" aria-hidden="true">
													→
												</span>
												<span class="sr-only">references</span>
												<span class="mono">
													<Show
														when={side === "out"}
														fallback={<span class="strong">{props.detail.name}</span>}
													>
														<span class="strong">{name(e.schema, e.table)}</span>
													</Show>
													({e.to.join(", ")})
												</span>
												<RefActions onDelete={e.onDelete} onUpdate={e.onUpdate} />
												<span class="spacer" />
												<Button
													class="rel-open"
													icon="go"
													label={`Open ${e.schema}.${e.table}`}
													tipSide="left"
													onClick={() => openTable(e.schema, e.table)}
												/>
											</div>
											<Show when={e.name}>
												<span class="cname mono">{e.name}</span>
											</Show>
										</li>
									</>
								)}
							</For>
						</ul>
					</Show>
				</Show>
			</section>
		);
	};

	return (
		<div class="sheet">
			<Show
				when={total()}
				fallback={
					<section class="info-section">
						<header>
							<h2>Relationships</h2>
						</header>
						<p class="info-none">
							No foreign key leads out of <span class="mono">{here()}</span>, and none leads into
							it.
						</p>
					</section>
				}
			>
				<section class="info-section">
					<header>
						<h2>Neighbourhood</h2>
						<span class="note">{summary()}</span>
					</header>
					<div class="rel-map" ref={box}>
						<svg class="rel-edges" width={size().w} height={size().h} aria-hidden="true">
							<For each={paths()}>
								{(p) => (
									<g
										classList={{ hot: hot() === p.key, dim: hot() !== null && hot() !== p.key }}
										style={{ "stroke-width": `${Math.min(4.5, 1.5 + Math.log2(p.weight))}px` }}
									>
										<path d={p.d} />
										<path d={p.head} />
									</g>
								)}
							</For>
						</svg>
						<div class="rel-col">
							<span class="rel-label">Referenced by</span>
							<For each={left()} fallback={<span class="rel-empty">None</span>}>
								{(n) => node(n)}
							</For>
						</div>
						<div class="rel-col mid">
							<div class="rel-node here" ref={center}>
								<span class="t">
									<Icon name="table" />
									<span class="name">
										<span class="schema">{props.detail.schema}.</span>
										{props.detail.name}
									</span>
								</span>
								<span class="via mono">
									{props.detail.columns
										.filter((c) => c.primaryKey)
										.map((c) => c.name)
										.join(", ") || "no primary key"}
								</span>
							</div>
						</div>
						<div class="rel-col">
							<span class="rel-label">References</span>
							<For each={right()} fallback={<span class="rel-empty">None</span>}>
								{(n) => node(n)}
							</For>
						</div>
					</div>
				</section>

				<div class="rel-lists" ref={lists}>
					<Show when={total() > PER_SIDE}>
						<div class="rel-tools" ref={watchTools}>
							<span class="rel-search">
								<Icon name="search" />
								<input
									ref={search}
									type="search"
									aria-label="Filter relationships by schema, table, column or key name"
									placeholder="Filter by schema, table, column or key"
									autocomplete="off"
									spellcheck={false}
									value={query()}
									onInput={(e) => setQuery(e.currentTarget.value)}
									onKeyDown={(e) => {
										if (e.key === "Escape" && query()) {
											e.preventDefault();
											setQuery("");
										}
									}}
								/>
							</span>
						</div>
					</Show>
					{list("References", outgoing(), "out")}
					{list("Referenced by", incoming(), "in")}
				</div>
			</Show>
		</div>
	);
}
