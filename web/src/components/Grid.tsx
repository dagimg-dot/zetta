import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { announce } from "../announce";
import type { Column, ResultColumn, ResultSet } from "../api";
import type { SortKey } from "../query";
import { blobBytes, formatBytes, isBlob, isNumericType } from "../value";
import { type HeaderActions, HeaderMenu, type HeaderTarget } from "./HeaderMenu";
import { copyText, Inspector, type InspectorAction } from "./Inspector";
import { Icon } from "./icons";

export interface LinkTarget {
	schema: string;
	table: string;
	column: string;
}

/** What the grid knows about foreign keys, so a value can take you to its row. */
export interface Links {
	/** Where a single-column foreign key in this table points. */
	outgoing: (column: string) => LinkTarget | undefined;
	/** Columns in other tables that point at this column. */
	incoming: (column: string) => LinkTarget[];
	follow: (target: LinkTarget, value: string) => void;
	filterBy: (column: string, value: string | null) => void;
}

export function createHidden() {
	const [hidden, setHidden] = createSignal<ReadonlySet<number>>(new Set());
	return {
		hidden,
		toggle(i: number) {
			const next = new Set(hidden());
			if (!next.delete(i)) next.add(i);
			setHidden(next);
		},
		clear() {
			if (hidden().size) setHidden(new Set<number>());
		},
	};
}

export type Hidden = ReturnType<typeof createHidden>;

export function HiddenButton(props: { hidden: Hidden }) {
	const n = () => props.hidden.hidden().size;
	return (
		<Show when={n()}>
			<button type="button" class="btn quiet" onClick={() => props.hidden.clear()}>
				Show {n()} hidden column{n() > 1 ? "s" : ""}
			</button>
		</Show>
	);
}

let gridSeq = 0;

/** Body cells are built directly so large results do not create a reactive scope per cell. */
function cell(v: string | null, numeric: boolean, link: boolean): HTMLTableCellElement {
	const td = document.createElement("td");
	if (v === null) {
		td.className = "null";
		td.textContent = "NULL";
		return td;
	}
	if (isBlob(v)) {
		const mark = document.createElement("span");
		mark.className = "mark";
		mark.textContent = `blob · ${formatBytes(blobBytes(v))}`;
		td.append(mark);
		return td;
	}
	if (numeric) td.className = "num";
	if (v.includes("\n")) {
		v.split("\n").forEach((line, i) => {
			if (i > 0) {
				const nl = document.createElement("span");
				nl.className = "nl";
				nl.textContent = "↵";
				td.append(nl);
			}
			td.append(line);
		});
	} else {
		td.textContent = v;
	}
	if (v.length > 40) td.title = v.length > 400 ? `${v.slice(0, 400)}…` : v;
	if (link) {
		// Clicks are handled by the table; the keyboard uses O on the cursor cell.
		const go = document.createElement("span");
		go.className = "fk-go";
		go.title = "Open the referenced row (O)";
		go.textContent = "↗";
		td.append(go);
	}
	return td;
}

function headerFacts(info: Column | undefined): string[] {
	if (!info) return [];
	const out: string[] = [];
	if (info.primaryKey) out.push("primary key");
	else if (!info.nullable) out.push("not null");
	if (info.default !== null) out.push(`default ${info.default}`);
	return out;
}

function headerTitle(name: string, type: string, info: Column | undefined): string {
	if (!info) return `${name}  ${type}`;
	const parts = [name, info.type || type];
	if (info.primaryKey) parts.push("primary key");
	if (!info.nullable) parts.push("not null");
	if (info.default !== null) parts.push(`default ${info.default}`);
	return parts.join("  ");
}

interface Cursor {
	row: number;
	col: number;
}

export function Grid(props: {
	result: ResultSet;
	hidden: Hidden;
	label: string;
	offset?: number;
	sorts?: SortKey[];
	/** `additive` is true for shift-click, which adds a secondary sort key. */
	onSort?: (col: string, additive: boolean) => void;
	columnInfo?: (name: string) => Column | undefined;
	links?: Links;
	/** Turns on the column menu: sort, filter, hide and copy, from a header button or a right-click. */
	actions?: Pick<HeaderActions, "sort" | "filter" | "open">;
	stale?: boolean;
}) {
	const id = `g${++gridSeq}`;
	let host: HTMLDivElement | undefined;
	let table: HTMLTableElement | undefined;
	let cells: HTMLTableCellElement[][] = [];
	let focusAfterRender: string | null = null;

	const [cursor, setCursor] = createSignal<Cursor | null>(null);
	const [inspecting, setInspecting] = createSignal(false);
	const [menu, setMenu] = createSignal<HeaderTarget | null>(null);

	/** Opens the column menu under the header, or at the pointer when `point` is given. */
	const openMenu = (c: ResultColumn, th: HTMLElement, point?: { x: number; y: number }) => {
		const rect = th.getBoundingClientRect();
		const info = props.columnInfo?.(c.name);
		const sorts = props.sorts ?? [];
		const sort = sorts.find((s) => s.c === c.name)?.d ?? null;
		const link = props.links?.outgoing(c.name);
		setMenu({
			name: c.name,
			type: info?.type || c.type,
			nullable: info ? info.nullable && !info.primaryKey : true,
			sort,
			othersSorted: sorts.some((s) => s.c !== c.name),
			link: link ? { schema: link.schema, table: link.table } : null,
			at: point ?? { x: rect.left, y: rect.bottom },
			rect,
			facts: headerFacts(info),
		});
	};

	const closeMenu = (restoreFocus: boolean) => {
		const name = menu()?.name;
		setMenu(null);
		if (restoreFocus && name !== undefined) queueMicrotask(() => focusHeader(name));
	};

	const numeric = createMemo(() => props.result.columns.map((c) => isNumericType(c.type)));
	const linked = createMemo(() => props.result.columns.map((c) => !!props.links?.outgoing(c.name)));
	const visibleCols = createMemo(() =>
		props.result.columns.map((_, i) => i).filter((i) => !props.hidden.hidden().has(i)),
	);

	createEffect(
		on(
			() => props.result,
			() => {
				// The row callbacks below have already filled `cells` for this result; drop leftovers.
				cells.length = props.result.rows.length;
				if (host) host.scrollTop = 0;
				const cur = cursor();
				const cols = props.result.columns.length;
				setCursor(
					cur && props.result.rows.length && cur.col < cols ? { row: 0, col: cur.col } : null,
				);
				if (focusAfterRender !== null) {
					const name = focusAfterRender;
					focusAfterRender = null;
					queueMicrotask(() => focusHeader(name));
				}
			},
			{ defer: true },
		),
	);

	const focusHeader = (name: string, which: "label" | "expand" = "label") => {
		const sel =
			which === "label"
				? `[data-col="${CSS.escape(name)}"]`
				: `[data-expand="${CSS.escape(name)}"]`;
		const el = host?.querySelector<HTMLElement>(sel);
		(el ?? table)?.focus();
	};

	createEffect(() => {
		for (const row of cells) for (const td of row) td.classList.remove("cur");
		for (const tr of host?.querySelectorAll("tr.cur-row") ?? []) tr.classList.remove("cur-row");
		const cur = cursor();
		if (!cur || !table) {
			table?.removeAttribute("aria-activedescendant");
			return;
		}
		const td = cells[cur.row]?.[cur.col];
		if (!td) return;
		td.classList.add("cur");
		td.id = `${id}-${cur.row}-${cur.col}`;
		td.parentElement?.classList.add("cur-row");
		table.setAttribute("aria-activedescendant", td.id);
		td.scrollIntoView({ block: "nearest", inline: "nearest" });
	});

	const inspected = createMemo(() => {
		const cur = cursor();
		if (!inspecting() || !cur) return null;
		const col = props.result.columns[cur.col];
		const row = props.result.rows[cur.row];
		if (!col || !row) return null;
		const value = row[cur.col] ?? null;
		return {
			column: col.name,
			type: props.columnInfo?.(col.name)?.type || col.type,
			value,
			row: (props.offset ?? 0) + cur.row + 1,
			actions: actionsFor(col.name, value),
		};
	});

	const actionsFor = (column: string, value: string | null): InspectorAction[] => {
		const links = props.links;
		if (!links) return [];
		const out: InspectorAction[] = [
			{
				label: value === null ? `Rows where ${column} is null` : `Rows with this ${column}`,
				icon: "filter",
				run: () => links.filterBy(column, value),
			},
		];
		if (value === null) return out;
		const target = links.outgoing(column);
		if (target)
			out.push({
				label: `Open in ${target.table}`,
				icon: "go",
				hint: "O",
				run: () => links.follow(target, value),
			});
		for (const ref of links.incoming(column)) {
			out.push({
				label: `${ref.table} rows pointing here`,
				detail: ref.column,
				icon: "next",
				run: () => links.follow(ref, value),
			});
		}
		return out;
	};

	const followAt = (at: Cursor) => {
		const col = props.result.columns[at.col];
		const value = props.result.rows[at.row]?.[at.col];
		const target = col && props.links?.outgoing(col.name);
		if (target && value !== undefined && value !== null) props.links?.follow(target, value);
	};

	const move = (dRow: number, dCol: number, toEdge = false) => {
		const rows = props.result.rows.length;
		const cols = visibleCols();
		if (!rows || !cols.length) return;
		const cur = cursor() ?? { row: 0, col: cols[0] ?? 0 };
		let row = Math.min(cur.row, rows - 1);
		let pos = cols.indexOf(cur.col);
		if (pos < 0) {
			// The cursor's column was just hidden: land on the next visible one.
			const after = cols.findIndex((c) => c > cur.col);
			pos = after >= 0 ? after : cols.length - 1;
		}
		if (toEdge) {
			if (dRow) row = dRow < 0 ? 0 : rows - 1;
			if (dCol) pos = dCol < 0 ? 0 : cols.length - 1;
		} else {
			row = Math.min(rows - 1, Math.max(0, row + dRow));
			pos = Math.min(cols.length - 1, Math.max(0, pos + dCol));
		}
		setCursor({ row, col: cols[pos] ?? 0 });
	};

	const pageRows = () => Math.max(1, Math.floor((host?.clientHeight ?? 400) / 28) - 2);

	const copyCurrent = async () => {
		const cur = cursor();
		if (!cur) return;
		const v = props.result.rows[cur.row]?.[cur.col];
		if (v === undefined) return;
		if (await copyText(v ?? "")) announce("Copied");
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.target !== table) return;
		const mod = e.ctrlKey || e.metaKey;
		switch (e.key) {
			case "ArrowDown":
				move(1, 0, mod);
				break;
			case "ArrowUp":
				move(-1, 0, mod);
				break;
			case "ArrowRight":
				move(0, 1, mod);
				break;
			case "ArrowLeft":
				move(0, -1, mod);
				break;
			case "Home":
				move(mod ? -1 : 0, -1, true);
				break;
			case "End":
				move(mod ? 1 : 0, 1, true);
				break;
			case "PageDown":
				move(pageRows(), 0);
				break;
			case "PageUp":
				move(-pageRows(), 0);
				break;
			case "Enter":
			case " ":
				if (!cursor()) move(0, 0);
				setInspecting(!inspecting());
				break;
			case "Escape":
				if (!inspecting()) return;
				setInspecting(false);
				break;
			case "c":
				if (mod && window.getSelection()?.toString()) return;
				void copyCurrent();
				break;
			case "h": {
				const cur = cursor();
				if (!cur || mod) return;
				props.hidden.toggle(cur.col);
				move(0, 0);
				break;
			}
			case "o": {
				const cur = cursor();
				if (!cur || mod) return;
				followAt(cur);
				break;
			}
			default:
				return;
		}
		e.preventDefault();
	};

	const cellAt = (target: EventTarget | null): Cursor | null => {
		const td = (target as HTMLElement | null)?.closest?.("td");
		const tr = td?.parentElement as HTMLTableRowElement | null;
		if (!td || !tr || td.classList.contains("rn")) return null;
		const row = tr.sectionRowIndex;
		const col = td.cellIndex - 1;
		return col >= 0 && row >= 0 ? { row, col } : null;
	};

	const onClick = (e: MouseEvent) => {
		const at = cellAt(e.target);
		if (!at) return;
		if ((e.target as HTMLElement).closest(".fk-go")) {
			followAt(at);
			return;
		}
		setCursor(at);
		if (!window.getSelection()?.toString()) table?.focus({ preventScroll: true });
	};

	const onDblClick = (e: MouseEvent) => {
		const at = cellAt(e.target);
		if (!at) return;
		setCursor(at);
		setInspecting(true);
	};

	const onFocus = () => {
		if (!cursor()) move(0, 0);
	};

	const closeInspector = () => {
		setInspecting(false);
		table?.focus({ preventScroll: true });
	};

	const toggleColumn = (i: number, name: string, collapsing: boolean) => {
		props.hidden.toggle(i);
		queueMicrotask(() => focusHeader(name, collapsing ? "expand" : "label"));
	};

	const collapseCss = () =>
		[...props.hidden.hidden()]
			.map((i) => `table[data-grid="${id}"] td:nth-child(${i + 2})`)
			.join(",")
			.concat(
				props.hidden.hidden().size
					? "{width:30px;min-width:30px;max-width:30px;padding:0;font-size:0;background:var(--surface-chrome)}"
					: "",
			);

	onCleanup(() => {
		cells = [];
	});

	return (
		<div class="work">
			<div class="grid" ref={host} classList={{ stale: !!props.stale }}>
				<Show
					when={props.result.columns.length}
					fallback={
						<div class="done" role="status">
							<Icon name="check" size={14} />
							<span class="what">{props.result.command || "Done"}</span>
							<Show when={/^(insert|update|delete|replace)\b/i.test(props.result.command)}>
								<span class="note">
									{props.result.rowCount === 1
										? "1 row changed"
										: `${props.result.rowCount.toLocaleString()} rows changed`}
								</span>
							</Show>
						</div>
					}
				>
					<style>{collapseCss()}</style>
					<table
						ref={table}
						class="mono"
						data-grid={id}
						// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a data table with arrow-key cell navigation is the ARIA grid pattern.
						role="grid"
						tabIndex={0}
						aria-label={props.label}
						aria-rowcount={props.result.rows.length + 1}
						aria-colcount={props.result.columns.length + 1}
						onKeyDown={onKey}
						onClick={onClick}
						onDblClick={onDblClick}
						onFocus={onFocus}
					>
						<thead>
							<tr>
								<th class="rn" scope="col">
									<span aria-hidden="true">#</span>
									<span class="sr-only">Row</span>
								</th>
								<For each={props.result.columns}>
									{(c, i) => {
										const info = () => props.columnInfo?.(c.name);
										const off = () => props.hidden.hidden().has(i());
										const sortAt = () => props.sorts?.findIndex((s) => s.c === c.name) ?? -1;
										const sorted = () => props.sorts?.[sortAt()] ?? null;
										return (
											<th
												scope="col"
												classList={{ collapsed: off(), num: numeric()[i()] && !off() }}
												title={
													off()
														? c.name
														: props.actions
															? undefined
															: headerTitle(c.name, c.type, info())
												}
												onContextMenu={(e) => {
													if (!props.actions || off()) return;
													e.preventDefault();
													openMenu(c, e.currentTarget, { x: e.clientX, y: e.clientY });
												}}
												aria-sort={
													sorted()
														? sorted()?.d === "asc"
															? "ascending"
															: "descending"
														: undefined
												}
											>
												<div class="th">
													<Show
														when={!off()}
														fallback={
															<button
																type="button"
																class="ico fold"
																data-expand={c.name}
																aria-label={`Show column ${c.name}`}
																onClick={() => toggleColumn(i(), c.name, false)}
															>
																<Icon name="unfold" />
															</button>
														}
													>
														<Show
															when={props.onSort}
															fallback={
																<span class="label">
																	<span class="name">{c.name}</span>
																	<span class="type">{c.type}</span>
																</span>
															}
														>
															{(onSort) => (
																<button
																	type="button"
																	class="label"
																	data-col={c.name}
																	aria-label={`${c.name}, ${c.type}${info()?.primaryKey ? ", primary key" : ""}${props.links?.outgoing(c.name) ? `, links to ${props.links.outgoing(c.name)?.table}` : ""}. Sort; shift adds a secondary sort${props.actions ? "; the menu key opens column actions" : ""}`}
																	onKeyDown={(e) => {
																		const th = e.currentTarget.closest("th");
																		if (!props.actions || !th) return;
																		if (
																			e.key === "ContextMenu" ||
																			(e.key === "F10" && e.shiftKey)
																		) {
																			e.preventDefault();
																			openMenu(c, th);
																		}
																	}}
																	onClick={(e) => {
																		focusAfterRender = c.name;
																		onSort()(c.name, e.shiftKey);
																	}}
																>
																	<span class="name">{c.name}</span>
																	<span class="type">{c.type}</span>
																	<Show when={info()?.primaryKey}>
																		<span class="pk">
																			<Icon name="key" size={11} />
																		</span>
																	</Show>
																	<Show when={props.links?.outgoing(c.name)}>
																		<span class="fk-mark">↗</span>
																	</Show>
																	<span class="sort-ind" classList={{ on: !!sorted() }}>
																		<Icon name={sorted()?.d ?? "sort"} size={11} />
																		<Show when={sorted() && (props.sorts?.length ?? 0) > 1}>
																			<span class="sort-n">{sortAt() + 1}</span>
																		</Show>
																	</span>
																</button>
															)}
														</Show>
														<Show when={!props.onSort && info()?.primaryKey}>
															<span class="pk" title="Primary key">
																<Icon name="key" size={11} />
															</span>
														</Show>
														<Show when={props.actions}>
															<button
																type="button"
																class="ico more"
																classList={{ open: menu()?.name === c.name }}
																tabIndex={-1}
																aria-label={`Column actions for ${c.name}`}
																aria-haspopup="menu"
																onClick={(e) => {
																	const th = e.currentTarget.closest("th");
																	if (th) openMenu(c, th);
																}}
															>
																<Icon name="more" />
															</button>
														</Show>
														<button
															type="button"
															class="ico fold"
															tabIndex={-1}
															aria-label={`Hide column ${c.name}`}
															title={`Hide column (H)`}
															onClick={() => toggleColumn(i(), c.name, true)}
														>
															<Icon name="fold" />
														</button>
													</Show>
												</div>
											</th>
										);
									}}
								</For>
							</tr>
						</thead>
						<tbody>
							<For each={props.result.rows}>
								{(row, r) => {
									const tds = row.map((v, k) =>
										cell(v, numeric()[k] ?? false, linked()[k] ?? false),
									);
									cells[r()] = tds;
									return (
										<tr>
											<td class="rn">{(props.offset ?? 0) + r() + 1}</td>
											{tds}
										</tr>
									);
								}}
							</For>
						</tbody>
					</table>
					<Show when={!props.result.rows.length}>
						<div class="none">No rows</div>
					</Show>
				</Show>
			</div>
			<Show when={inspected()}>{(c) => <Inspector cell={c()} onClose={closeInspector} />}</Show>
			<Show when={props.actions}>
				{(a) => (
					<HeaderMenu
						target={menu()}
						actions={{
							...a(),
							// Sorting and filtering reload the rows, so focus returns to the header once they render.
							sort: (name, dir, additive) => {
								focusAfterRender = name;
								a().sort(name, dir, additive);
							},
							filter: (f) => {
								focusAfterRender = f.c;
								a().filter(f);
							},
							hide: (name) => {
								const i = props.result.columns.findIndex((c) => c.name === name);
								if (i >= 0) toggleColumn(i, name, true);
							},
							copy: async (name) => {
								if (await copyText(name)) announce(`Copied ${name}`);
							},
						}}
						onClose={closeMenu}
					/>
				)}
			</Show>
		</div>
	);
}
