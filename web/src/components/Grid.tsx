import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { announce } from "../announce";
import type { Column, ResultSet } from "../api";
import { blobBytes, formatBytes, isBlob, isNumericType } from "../value";
import { copyText, Inspector } from "./Inspector";
import { Icon } from "./icons";

export interface Sort {
	col: string;
	dir: "asc" | "desc";
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
function cell(v: string | null, numeric: boolean): HTMLTableCellElement {
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
	return td;
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
	sort?: Sort | null;
	onSort?: (col: string) => void;
	columnInfo?: (name: string) => Column | undefined;
	stale?: boolean;
}) {
	const id = `g${++gridSeq}`;
	let host: HTMLDivElement | undefined;
	let table: HTMLTableElement | undefined;
	let cells: HTMLTableCellElement[][] = [];
	let focusAfterRender: string | null = null;

	const [cursor, setCursor] = createSignal<Cursor | null>(null);
	const [inspecting, setInspecting] = createSignal(false);

	const numeric = createMemo(() => props.result.columns.map((c) => isNumericType(c.type)));
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
		return {
			column: col.name,
			type: props.columnInfo?.(col.name)?.type || col.type,
			value: row[cur.col] ?? null,
			row: (props.offset ?? 0) + cur.row + 1,
		};
	});

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
										const sorted = () => (props.sort?.col === c.name ? props.sort : null);
										return (
											<th
												scope="col"
												classList={{ collapsed: off(), num: numeric()[i()] && !off() }}
												title={off() ? c.name : headerTitle(c.name, c.type, info())}
												aria-sort={
													sorted()
														? sorted()?.dir === "asc"
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
																	aria-label={`${c.name}, ${c.type}${info()?.primaryKey ? ", primary key" : ""}. Sort`}
																	onClick={() => {
																		focusAfterRender = c.name;
																		onSort()(c.name);
																	}}
																>
																	<span class="name">{c.name}</span>
																	<span class="type">{c.type}</span>
																	<Show when={info()?.primaryKey}>
																		<span class="pk">
																			<Icon name="key" size={11} />
																		</span>
																	</Show>
																	<span class="sort-ind" classList={{ on: !!sorted() }}>
																		<Icon name={sorted()?.dir ?? "sort"} size={11} />
																	</span>
																</button>
															)}
														</Show>
														<Show when={!props.onSort && info()?.primaryKey}>
															<span class="pk" title="Primary key">
																<Icon name="key" size={11} />
															</span>
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
									const tds = row.map((v, k) => cell(v, numeric()[k] ?? false));
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
		</div>
	);
}
