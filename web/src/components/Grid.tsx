import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { Column, ResultSet } from "../api";
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
			<button type="button" class="btn" onClick={() => props.hidden.clear()}>
				Show {n()} hidden column{n() > 1 ? "s" : ""}
			</button>
		</Show>
	);
}

let gridSeq = 0;

/** Body cells are built directly so large results do not create a reactive scope per cell. */
function cell(v: string | null): HTMLTableCellElement {
	const td = document.createElement("td");
	if (v === null) {
		td.className = "null";
		td.textContent = "NULL";
	} else {
		td.textContent = v;
		if (v.length > 60) td.title = v;
	}
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

export function Grid(props: {
	result: ResultSet;
	hidden: Hidden;
	offset?: number;
	sort?: Sort | null;
	onSort?: (col: string) => void;
	columnInfo?: (name: string) => Column | undefined;
}) {
	const id = `g${++gridSeq}`;
	let host: HTMLDivElement | undefined;

	createEffect(
		on(
			() => props.result,
			() => {
				if (host) host.scrollTop = 0;
			},
			{ defer: true },
		),
	);

	const collapseCss = () =>
		[...props.hidden.hidden()]
			.map((i) => `table[data-grid="${id}"] td:nth-child(${i + 2})`)
			.join(",")
			.concat(
				props.hidden.hidden().size
					? "{width:34px;min-width:34px;max-width:34px;padding:0;font-size:0;background:repeating-linear-gradient(135deg,transparent 0 4px,var(--hover) 4px 5px)}"
					: "",
			);

	return (
		<div class="grid" ref={host}>
			<Show
				when={props.result.columns.length}
				fallback={<div class="empty">{props.result.command || "Done"}</div>}
			>
				<style>{collapseCss()}</style>
				<table class="mono" data-grid={id}>
					<thead>
						<tr>
							<th class="rn">#</th>
							<For each={props.result.columns}>
								{(c, i) => {
									const info = () => props.columnInfo?.(c.name);
									const off = () => props.hidden.hidden().has(i());
									const sorted = () => (props.sort?.col === c.name ? props.sort : null);
									const toggle = () => props.hidden.toggle(i());
									return (
										<th
											classList={{ collapsed: off() }}
											title={off() ? c.name : headerTitle(c.name, c.type, info())}
										>
											<div class="th">
												<Show
													when={!off()}
													fallback={
														<button
															type="button"
															class="ico fold"
															title={`Expand ${c.name}`}
															onClick={toggle}
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
															<button type="button" class="label" onClick={() => onSort()(c.name)}>
																<span class="name">{c.name}</span>
																<span class="type">{c.type}</span>
															</button>
														)}
													</Show>
													<Show when={info()?.primaryKey}>
														<span class="pk" title="Primary key">
															<Icon name="key" size={11} />
														</span>
													</Show>
													<Show when={props.onSort}>
														{(onSort) => (
															<button
																type="button"
																class="ico"
																classList={{ on: !!sorted() }}
																title={
																	sorted()
																		? `Sorted ${sorted()?.dir}, click to change`
																		: `Sort by ${c.name}`
																}
																onClick={() => onSort()(c.name)}
															>
																<Icon name={sorted()?.dir ?? "sort"} />
															</button>
														)}
													</Show>
													<button
														type="button"
														class="ico fold"
														title={`Collapse ${c.name}`}
														onClick={toggle}
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
								const cells = row.map(cell);
								return (
									<tr>
										<td class="rn">{(props.offset ?? 0) + r() + 1}</td>
										{cells}
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
	);
}
