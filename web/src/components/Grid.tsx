import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";
import { announce } from "../announce";
import type { Column, ResultColumn, ResultSet } from "../api";
import { copyRich, copyText } from "../clipboard";
import { hiddenRuns } from "../columns";
import { type FormatId, fileName, format, htmlTable, pick } from "../copy";
import { plural } from "../format";
import { whitespace } from "../marks";
import type { SortKey } from "../query";
import { refName } from "../refs";
import { blobBytes, edges, formatBytes, isBlob, isNumericType } from "../value";
import { Button } from "./Button";
import { type HeaderActions, HeaderMenu, type HeaderTarget } from "./HeaderMenu";
import { Inspector, type InspectorAction } from "./Inspector";
import { Icon } from "./icons";
import { RowMenu, type RowTarget } from "./RowMenu";
import { tip } from "./Tip";

export interface LinkTarget {
	schema: string;
	table: string;
	column: string;
}

/** What the grid knows about foreign keys, so a value can take you to its row. */
export interface Links {
	/** The schema of the table on show, so references from it can leave the schema out. */
	schema: string;
	/** Where a single-column foreign key in this table points. */
	outgoing: (column: string) => LinkTarget | undefined;
	/** Columns in other tables that point at this column. */
	incoming: (column: string) => LinkTarget[];
	follow: (target: LinkTarget, value: string) => void;
	filterBy: (column: string, value: string | null) => void;
}

/**
 * Which columns are hidden, by name, so the choice survives a new page of rows and can live in the
 * URL. The rows view keeps it there; the SQL tab keeps it in memory with `createHidden`.
 */
export interface Hidden {
	hidden: () => ReadonlySet<string>;
	set: (next: ReadonlySet<string>) => void;
}

export function createHidden(): Hidden {
	const [hidden, set] = createSignal<ReadonlySet<string>>(new Set());
	return { hidden, set };
}

/**
 * Rows picked for copying, by index into the loaded result. It is plain data rather than marks on
 * elements, because the grid draws only the rows in view. It also carries the short note a copy
 * leaves in the status bar.
 */
export function createSelection() {
	const [rows, setRows] = createSignal<ReadonlySet<number>>(new Set());
	const [note, setNote] = createSignal("");
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(timer));
	return {
		rows,
		set: (next: ReadonlySet<number>) => setRows(next),
		clear() {
			if (rows().size) setRows(new Set<number>());
		},
		note,
		tell(text: string) {
			clearTimeout(timer);
			setNote(text);
			announce(text);
			timer = setTimeout(() => setNote(""), 2400);
		},
	};
}

export type Selection = ReturnType<typeof createSelection>;

/** The status bar's selection count, or the note a copy just left. */
export function SelectionNote(props: { selection: Selection; total: number }) {
	const n = () => props.selection.rows().size;
	return (
		<Show
			when={props.selection.note()}
			fallback={
				<Show when={n()}>
					<span class="st-selected">
						<span class="st-num">{n().toLocaleString()}</span>
						<span class="st-word">of {props.total.toLocaleString()} selected</span>
						<Button
							variant="bare"
							class="st-clear"
							icon="close"
							iconSize={10}
							label="Clear the selection"
							kbd="Esc"
							tipSide="top"
							onClick={() => props.selection.clear()}
						/>
					</span>
				</Show>
			}
		>
			<span class="st-copied">
				<Icon name="check" size={11} />
				{props.selection.note()}
			</span>
		</Show>
	);
}

let gridSeq = 0;

/** Longer values are not offered as filters: they would not fit in a URL. */
const MAX_FILTER_VALUE = 1000;

/** Rows drawn above and below the visible ones, so a fast scroll does not show blank space. */
const OVERSCAN = 12;

/** Body cells are built directly so large results do not create a reactive scope per cell. */
function cell(
	v: string | null,
	type: string,
	numeric: boolean,
	link: boolean,
): HTMLTableCellElement {
	const td = document.createElement("td");
	if (v === null) {
		td.className = "null";
		td.textContent = "NULL";
		return td;
	}
	// Blobs, empty text and text of only spaces would otherwise look alike, or like nothing.
	const blank = v.trim() === "";
	if (isBlob(v, type) || blank) {
		const mark = document.createElement("span");
		mark.className = "mark";
		mark.textContent = !blank
			? `blob · ${formatBytes(blobBytes(v))}`
			: v === ""
				? "empty"
				: `blank · ${plural([...v].length, "char")}`;
		td.append(mark);
		return td;
	}
	if (numeric) td.className = "num";
	const { lead, body, trail } = edges(v);
	if (!lead && !trail && !v.includes("\n")) {
		td.textContent = v;
	} else {
		if (lead) td.append(whitespace(lead));
		body.split("\n").forEach((line, i) => {
			if (i > 0) {
				const nl = document.createElement("span");
				nl.className = "nl";
				nl.textContent = "↵";
				td.append(nl);
			}
			td.append(line);
		});
		if (trail) td.append(whitespace(trail));
	}
	if (v.length > 40) td.dataset.tip = v.length > 400 ? `${v.slice(0, 400)}…` : v;
	if (link) {
		// Clicks are handled by the table; the keyboard uses O on the cursor cell.
		const go = document.createElement("span");
		go.className = "fk-go";
		go.dataset.tip = "Open the referenced row";
		go.dataset.tipKbd = "O";
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

/** The full name on its own line, then what the catalog says about it: a long name is cut in the header. */
function headerTitle(name: string, type: string, info: Column | undefined): string {
	if (!info) return `${name}\n${type}`;
	const parts = [info.type || type];
	if (info.primaryKey) parts.push("primary key");
	if (!info.nullable) parts.push("not null");
	if (info.default !== null) parts.push(`default ${info.default}`);
	return `${name}\n${parts.join(" · ")}`;
}

interface Cursor {
	row: number;
	col: number;
}

export function Grid(props: {
	result: ResultSet;
	hidden: Hidden;
	selection: Selection;
	label: string;
	/** What an empty result says; the status bar says the same. */
	empty?: string;
	offset?: number;
	sorts?: SortKey[];
	/** `additive` is true for shift-click, which adds a secondary sort key. */
	onSort?: (col: string, additive: boolean) => void;
	columnInfo?: (name: string) => Column | undefined;
	links?: Links;
	/** Turns on the column menu: sort, filter, hide and copy, from a header button or a right-click. */
	actions?: Pick<HeaderActions, "sort" | "filter" | "open" | "columns">;
	stale?: boolean;
}) {
	const id = `g${++gridSeq}`;
	let host: HTMLDivElement | undefined;
	let table: HTMLTableElement | undefined;
	/** The cells of the rows currently drawn, by row index. Rows off screen have none. */
	const cells = new Map<number, HTMLTableCellElement[]>();
	let focusAfterRender: string | null = null;

	const [cursor, setCursor] = createSignal<Cursor | null>(null);
	const [scrollTop, setScrollTop] = createSignal(0);
	const [viewHeight, setViewHeight] = createSignal(600);
	const [rowHeight, setRowHeight] = createSignal(29);
	const [inspecting, setInspecting] = createSignal(false);
	const [menu, setMenu] = createSignal<HeaderTarget | null>(null);
	const [rowMenu, setRowMenu] = createSignal<RowTarget | null>(null);
	/** Where a shift-click or Shift+arrow range starts. */
	let anchor: number | null = null;

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
	const hiddenIdx = createMemo(() => {
		const h = props.hidden.hidden();
		return new Set(props.result.columns.flatMap((c, i) => (h.has(c.name) ? [i] : [])));
	});
	const visibleCols = createMemo(() =>
		props.result.columns.map((_, i) => i).filter((i) => !hiddenIdx().has(i)),
	);
	const runs = createMemo(() => hiddenRuns(props.result.columns.map((_, i) => hiddenIdx().has(i))));
	/** The run a hidden column belongs to, by the index of its stub. */
	const runOf = (i: number) => {
		for (const [start, members] of runs()) if (members.includes(i)) return start;
		return -1;
	};

	/**
	 * Bumps whenever drawn rows go stale: a new result, or links and number columns that arrive after
	 * it. Row keys carry it, so rows that stay in view are reused while scrolling and rebuilt here.
	 */
	let generation = 0;
	const gen = createMemo(() => {
		props.result;
		numeric();
		linked();
		return ++generation;
	});

	/**
	 * Column widths from every row, not just the drawn ones, so columns hold still while scrolling.
	 * Cells are monospace, so a character count in `ch` is the width; long values stop at the cap.
	 */
	/** The row-number column fits the largest number on the page, so spare width goes to the filler. */
	const rnDigits = () => ((props.offset ?? 0) + props.result.rows.length).toLocaleString().length;

	const colChars = createMemo(() => {
		const { columns, rows } = props.result;
		const widest = columns.map(() => 0);
		for (const row of rows) {
			for (let k = 0; k < row.length; k++) {
				const v = row[k];
				const blob = v != null && isBlob(v, columns[k]?.type);
				const n = v === null || v === undefined ? 4 : blob ? 16 : Math.min(v.length, 60);
				if (n > (widest[k] ?? 0)) widest[k] = n;
			}
		}
		return widest.map((n, k) => n + (linked()[k] ? 2 : 0));
	});

	/** Only the rows in view, plus overscan, are in the DOM; spacers stand in for the rest. */
	const range = createMemo(() => {
		const n = props.result.rows.length;
		const h = rowHeight();
		const first = Math.max(0, Math.floor(scrollTop() / h) - OVERSCAN);
		const last = Math.min(n, Math.ceil((scrollTop() + viewHeight()) / h) + OVERSCAN);
		return { first, last: Math.max(first, last) };
	});

	const rowKeys = createMemo(() => {
		const g = gen();
		const { first, last } = range();
		const keys: string[] = [];
		for (let r = first; r < last; r++) keys.push(`${g}:${r}`);
		return keys;
	});

	const headHeight = () => table?.tHead?.offsetHeight ?? 34;

	/** Scrolls by arithmetic, since a row far off screen has no element to scroll to yet. */
	const revealRow = (row: number) => {
		if (!host) return;
		const h = rowHeight();
		const top = row * h;
		const room = host.clientHeight - headHeight();
		if (top < host.scrollTop) host.scrollTop = top;
		else if (top + h > host.scrollTop + room) host.scrollTop = top + h - room;
		setScrollTop(host.scrollTop);
	};

	onMount(() => {
		if (!host) return;
		const el = host;
		setViewHeight(el.clientHeight);
		const ro = new ResizeObserver(() => setViewHeight(el.clientHeight));
		ro.observe(el);
		onCleanup(() => ro.disconnect());
	});

	createEffect(
		on(
			() => props.result,
			() => {
				if (host) host.scrollTop = 0;
				setScrollTop(0);
				props.selection.clear();
				anchor = null;
				// Every row is one line high, so one drawn row gives the height of them all.
				queueMicrotask(() => {
					const tr = table?.tBodies[0]?.querySelector<HTMLTableRowElement>("tr[data-row]");
					const h = tr?.getBoundingClientRect().height;
					if (h && Math.abs(h - rowHeight()) > 0.5) setRowHeight(h);
				});
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

	/**
	 * Moves the cursor after scrolling its row into the drawn range, so the cell exists by the time
	 * the effect below marks it. Scrolling from an effect instead would mark before the rows draw.
	 */
	const place = (at: Cursor) => {
		revealRow(at.row);
		setCursor(at);
	};

	createEffect(() => {
		rowKeys();
		const cur = cursor();
		untrack(() => {
			for (const row of cells.values()) for (const td of row) td.classList.remove("cur");
			for (const tr of host?.querySelectorAll("tr.cur-row") ?? []) tr.classList.remove("cur-row");
			if (!cur || !table) {
				table?.removeAttribute("aria-activedescendant");
				return;
			}
			const td = cells.get(cur.row)?.[cur.col];
			if (!td) return;
			td.classList.add("cur");
			td.id = `${id}-${cur.row}-${cur.col}`;
			td.parentElement?.classList.add("cur-row");
			table.setAttribute("aria-activedescendant", td.id);
		});
	});

	/**
	 * Follows the cursor only when it moves. Scrolling redraws rows, and following on a redraw would
	 * pull the view back to the cursor while it is still within the overscan.
	 */
	createEffect(
		on(
			cursor,
			(cur) => {
				if (cur)
					cells.get(cur.row)?.[cur.col]?.scrollIntoView({ block: "nearest", inline: "nearest" });
			},
			{ defer: true },
		),
	);

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
			incoming: incomingFor(col.name, value),
			peek: peekFor(col.name, value),
		};
	});

	/** Whether a value can travel in a URL as a filter: blobs compare as bytes, and huge text will not fit. */
	const filterable = (column: string, value: string | null) =>
		value === null ||
		(value.length <= MAX_FILTER_VALUE && !isBlob(value, props.columnInfo?.(column)?.type ?? ""));

	const actionsFor = (column: string, value: string | null): InspectorAction[] => {
		const links = props.links;
		if (!links || !filterable(column, value)) return [];
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
		return out;
	};

	/** The row a foreign key value points to, for the inspector to show in place. */
	const peekFor = (column: string, value: string | null) => {
		const links = props.links;
		const target = links?.outgoing(column);
		if (!links || !target || value === null || !filterable(column, value)) return undefined;
		return { target: { ...target, value }, label: refName(target, links.schema) };
	};

	/** One action per column elsewhere that points at this one, named by its table. */
	const incomingFor = (column: string, value: string | null): InspectorAction[] => {
		const links = props.links;
		if (!links || value === null || !filterable(column, value)) return [];
		return links.incoming(column).map((ref) => ({
			label: refName(ref, links.schema),
			detail: ref.column,
			icon: "next",
			run: () => links.follow(ref, value),
		}));
	};

	const followAt = (at: Cursor) => {
		const col = props.result.columns[at.col];
		const value = props.result.rows[at.row]?.[at.col];
		const target = col && props.links?.outgoing(col.name);
		if (target && value !== undefined && value !== null && filterable(col.name, value))
			props.links?.follow(target, value);
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
		place({ row, col: cols[pos] ?? 0 });
	};

	const pageRows = () => Math.max(1, Math.floor((viewHeight() - headHeight()) / rowHeight()) - 1);

	const copyCurrent = async () => {
		const cur = cursor();
		if (!cur) return;
		const v = props.result.rows[cur.row]?.[cur.col];
		if (v === undefined) return;
		const name = props.result.columns[cur.col]?.name;
		// The inspector's Copy is off for NULL too: there is no text to copy.
		if (v === null) return props.selection.tell("NULL has no text to copy");
		props.selection.tell((await copyText(v)) ? `Copied ${name}` : "Copy failed");
	};

	const selectRows = (from: number, to: number, add = false) => {
		const next = new Set(add ? props.selection.rows() : []);
		for (let r = Math.min(from, to); r <= Math.max(from, to); r++) next.add(r);
		props.selection.set(next);
	};

	/** Picks a row: alone, toggled in or out with ctrl, or as a range from the anchor with shift. */
	const pickRow = (row: number, how: "only" | "toggle" | "range") => {
		if (how === "range" && anchor !== null) {
			selectRows(anchor, row);
			return;
		}
		if (how === "toggle") {
			const next = new Set(props.selection.rows());
			if (!next.delete(row)) next.add(row);
			props.selection.set(next);
		} else {
			selectRows(row, row);
		}
		anchor = row;
	};

	const selectAll = () => {
		const n = props.result.rows.length;
		if (!n) return;
		selectRows(0, n - 1);
		anchor = 0;
	};

	/** The selected rows in order, or the cursor's row when nothing is selected. */
	const copyTargets = (): number[] => {
		const picked = [...props.selection.rows()].sort((a, b) => a - b);
		if (picked.length) return picked;
		const cur = cursor();
		return cur ? [cur.row] : [];
	};

	const visibleRows = (rows: number[]) =>
		pick(
			{
				columns: props.result.columns.map((c) => ({
					name: c.name,
					type: props.columnInfo?.(c.name)?.type || c.type,
				})),
				rows: props.result.rows,
			},
			rows,
			visibleCols(),
		);

	const rowsNoun = (n: number) => (n === 1 ? "1 row" : `${n.toLocaleString()} rows`);

	/** Without a format, copies TSV with an HTML table beside it, for spreadsheets. */
	const copyRows = async (as?: FormatId) => {
		const rows = copyTargets();
		if (!rows.length) return;
		const t = visibleRows(rows);
		const f = as ? format(as) : null;
		const ok = f
			? await copyText(f.write(t))
			: await copyRich(format("tsv").write(t), htmlTable(t));
		props.selection.tell(
			ok ? `Copied ${rowsNoun(rows.length)}${f ? ` as ${f.label}` : ""}` : "Copy failed",
		);
	};

	const saveRows = (as: FormatId) => {
		const rows = copyTargets();
		if (!rows.length) return;
		const f = format(as);
		const name = fileName(props.label, f);
		const url = URL.createObjectURL(new Blob([f.write(visibleRows(rows))], { type: f.mime }));
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		props.selection.tell(`Saved ${rowsNoun(rows.length)} to ${name}`);
	};

	/** Opens the row menu. A row outside the selection becomes the selection first, as in a file manager. */
	const openRowMenu = (row: number, col: number | null, at: { x: number; y: number }) => {
		if (!props.selection.rows().has(row)) pickRow(row, "only");
		const column = col === null ? undefined : props.result.columns[col];
		const value = col === null ? undefined : props.result.rows[row]?.[col];
		setRowMenu({
			at,
			rows: props.selection.rows().size,
			cell:
				column && value !== undefined
					? {
							column: column.name,
							actions: actionsFor(column.name, value),
							incoming: incomingFor(column.name, value),
						}
					: null,
		});
	};

	const openRowMenuAtCursor = () => {
		const cur = cursor();
		if (!cur) return;
		const rect = cells.get(cur.row)?.[cur.col]?.getBoundingClientRect();
		openRowMenu(cur.row, cur.col, rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 });
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.target !== table) return;
		const mod = e.ctrlKey || e.metaKey;
		const from = cursor()?.row ?? 0;
		/** Shift with a row move extends the selection from where the cursor started. */
		const extend = () => {
			if (!e.shiftKey) return;
			if (anchor === null || !props.selection.rows().size) anchor = from;
			selectRows(anchor, cursor()?.row ?? from);
		};
		switch (e.key) {
			case "ArrowDown":
				move(1, 0, mod);
				extend();
				break;
			case "ArrowUp":
				move(-1, 0, mod);
				extend();
				break;
			case "ArrowRight":
				move(0, 1, mod);
				break;
			case "ArrowLeft":
				move(0, -1, mod);
				break;
			case "Home":
				move(mod ? -1 : 0, -1, true);
				if (mod) extend();
				break;
			case "End":
				move(mod ? 1 : 0, 1, true);
				if (mod) extend();
				break;
			case "PageDown":
				move(pageRows(), 0);
				extend();
				break;
			case "PageUp":
				move(-pageRows(), 0);
				extend();
				break;
			case " ":
				if (e.shiftKey) {
					if (!cursor()) move(0, 0);
					pickRow(cursor()?.row ?? 0, "toggle");
					break;
				}
				if (!cursor()) move(0, 0);
				setInspecting(!inspecting());
				break;
			case "Enter":
				if (!cursor()) move(0, 0);
				setInspecting(!inspecting());
				break;
			case "Escape":
				if (inspecting()) setInspecting(false);
				else if (props.selection.rows().size) props.selection.clear();
				else return;
				break;
			case "a":
				if (!mod) return;
				selectAll();
				break;
			case "c":
				if (mod && window.getSelection()?.toString()) return;
				if (mod && props.selection.rows().size) void copyRows();
				else void copyCurrent();
				break;
			case "ContextMenu":
				openRowMenuAtCursor();
				break;
			case "F10":
				if (!e.shiftKey) return;
				openRowMenuAtCursor();
				break;
			case "h": {
				const cur = cursor();
				if (!cur || mod) return;
				if (flipColumn(cur.col)) move(0, 0);
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
		if (!td || !tr?.dataset.row || td.classList.contains("rn") || td.classList.contains("fill"))
			return null;
		const row = Number(tr.dataset.row);
		const col = td.cellIndex - 1;
		return col >= 0 && row >= 0 ? { row, col } : null;
	};

	/** The row of a row-number cell. */
	const numberAt = (target: EventTarget | null): number | null => {
		const td = (target as HTMLElement | null)?.closest?.("td.rn");
		const row = (td?.parentElement as HTMLTableRowElement | null)?.dataset.row;
		return row === undefined ? null : Number(row);
	};

	const how = (e: MouseEvent) =>
		e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "only";

	const onClick = (e: MouseEvent) => {
		const numbered = numberAt(e.target);
		if (numbered !== null) {
			pickRow(numbered, how(e));
			const col = cursor()?.col ?? visibleCols()[0] ?? 0;
			place({ row: numbered, col });
			table?.focus({ preventScroll: true });
			return;
		}
		const at = cellAt(e.target);
		if (!at) return;
		if ((e.target as HTMLElement).closest(".fk-go")) {
			followAt(at);
			return;
		}
		if (e.shiftKey || e.ctrlKey || e.metaKey) pickRow(at.row, how(e));
		else {
			props.selection.clear();
			anchor = at.row;
		}
		place(at);
		if (!window.getSelection()?.toString()) table?.focus({ preventScroll: true });
	};

	/** Keeps a shift-click on the row numbers from selecting text. */
	const onMouseDown = (e: MouseEvent) => {
		if (e.shiftKey && numberAt(e.target) !== null) e.preventDefault();
	};

	/** Leaves the browser's menu alone while text is selected, so the text can still be copied. */
	const onContextMenu = (e: MouseEvent) => {
		if (window.getSelection()?.toString()) return;
		const numbered = numberAt(e.target);
		const at = numbered === null ? cellAt(e.target) : null;
		const row = numbered ?? at?.row;
		if (row === undefined) return;
		e.preventDefault();
		place({ row, col: at?.col ?? cursor()?.col ?? visibleCols()[0] ?? 0 });
		openRowMenu(row, at?.col ?? null, { x: e.clientX, y: e.clientY });
	};

	const closeRowMenu = (restoreFocus: boolean) => {
		setRowMenu(null);
		if (restoreFocus) queueMicrotask(() => table?.focus({ preventScroll: true }));
	};

	const onDblClick = (e: MouseEvent) => {
		const at = cellAt(e.target);
		if (!at) return;
		place(at);
		setInspecting(true);
	};

	const onFocus = () => {
		if (!cursor()) move(0, 0);
	};

	const closeInspector = () => {
		setInspecting(false);
		table?.focus({ preventScroll: true });
	};

	/** Hides or shows a column. The last one shown stays, so the grid never goes blank. */
	const flipColumn = (i: number): boolean => {
		const name = props.result.columns[i]?.name;
		if (name === undefined) return false;
		const hiding = !hiddenIdx().has(i);
		if (hiding && visibleCols().length <= 1) {
			props.selection.tell("The last column stays shown");
			return false;
		}
		const next = new Set(props.hidden.hidden());
		if (hiding) next.add(name);
		else next.delete(name);
		props.hidden.set(next);
		return true;
	};

	/** A hidden column lands in a run, so focus goes to that run's stub. */
	const toggleColumn = (i: number, name: string, collapsing: boolean) => {
		if (!flipColumn(i)) return;
		queueMicrotask(() => {
			const stub = props.result.columns[runOf(i)]?.name;
			if (collapsing && stub !== undefined) focusHeader(stub, "expand");
			else focusHeader(name);
		});
	};

	const runLabel = (members: number[], name: string) =>
		members.length > 1
			? `Show ${members.length} hidden columns: ${members.map((m) => props.result.columns[m]?.name).join(", ")}`
			: `Show column ${name}`;

	/** Shows every column in the run whose stub is at `start`. */
	const showRun = (start: number) => {
		const members = runs().get(start) ?? [];
		const names = new Set(members.map((i) => props.result.columns[i]?.name));
		const first = props.result.columns[start]?.name;
		props.hidden.set(new Set([...props.hidden.hidden()].filter((n) => !names.has(n))));
		if (first !== undefined) queueMicrotask(() => focusHeader(first));
	};

	/** A run draws as one narrow stub at its first column; the rest of it collapses to nothing. */
	const collapseCss = () => {
		const at = (i: number, part: string) => `table[data-grid="${id}"] ${part}:nth-child(${i + 2})`;
		const stubs = [...runs().keys()].map((i) => at(i, "td"));
		const rest = [...runs().values()].flatMap((m) => m.slice(1).map((i) => at(i, "col")));
		return [
			stubs.length
				? `${stubs.join(",")}{width:30px;min-width:30px;max-width:30px;padding:0;font-size:0;background:var(--surface-chrome)}`
				: "",
			rest.length ? `${rest.join(",")}{visibility:collapse}` : "",
		].join("");
	};

	onCleanup(() => cells.clear());

	return (
		<div class="work">
			<div
				class="grid"
				ref={host}
				classList={{ stale: !!props.stale }}
				onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
			>
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
						aria-multiselectable="true"
						onKeyDown={onKey}
						onClick={onClick}
						onMouseDown={onMouseDown}
						onContextMenu={onContextMenu}
						onDblClick={onDblClick}
						onFocus={onFocus}
					>
						<colgroup>
							<col style={{ width: `calc(${rnDigits()}ch + 24px)` }} />
							<For each={props.result.columns}>
								{(_, i) => (
									<col
										style={{
											width: hiddenIdx().has(i())
												? undefined
												: `calc(${colChars()[i()] ?? 0}ch + 24px)`,
										}}
									/>
								)}
							</For>
							<col />
						</colgroup>
						<thead>
							<tr>
								<th class="rn" scope="col">
									<span aria-hidden="true">#</span>
									<span class="sr-only">Row</span>
								</th>
								<For each={props.result.columns}>
									{(c, i) => {
										const info = () => props.columnInfo?.(c.name);
										const off = () => hiddenIdx().has(i());
										const run = () => runs().get(i());
										const sortAt = () => props.sorts?.findIndex((s) => s.c === c.name) ?? -1;
										const sorted = () => props.sorts?.[sortAt()] ?? null;
										return (
											<th
												scope="col"
												classList={{ collapsed: off(), num: numeric()[i()] && !off() }}
												{...tip(
													off()
														? undefined
														: props.actions
															? undefined
															: headerTitle(c.name, c.type, info()),
													undefined,
													"bottom",
												)}
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
															<Show when={run()}>
																{(members) => (
																	<Button
																		variant="bare"
																		class="ico fold"
																		classList={{ many: members().length > 1 }}
																		icon="unfold"
																		// The count makes this a button with text, so it is named and tipped directly.
																		aria-label={runLabel(members(), c.name)}
																		tip={runLabel(members(), c.name)}
																		tipSide="bottom"
																		data-expand={c.name}
																		onClick={() => showRun(i())}
																	>
																		<Show when={members().length > 1}>
																			<span class="run-n">{members().length}</span>
																		</Show>
																	</Button>
																)}
															</Show>
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
																	{...tip(headerTitle(c.name, c.type, info()), undefined, "bottom")}
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
															<span class="pk" {...tip("Primary key", undefined, "bottom")}>
																<Icon name="key" size={11} />
															</span>
														</Show>
														<Show when={props.actions}>
															<Button
																variant="bare"
																class="ico more"
																classList={{ open: menu()?.name === c.name }}
																icon="more"
																label={`Column actions for ${c.name}`}
																kbd="Shift+F10"
																tabIndex={-1}
																aria-haspopup="menu"
																onClick={(e) => {
																	const th = e.currentTarget.closest("th");
																	if (th) openMenu(c, th);
																}}
															/>
														</Show>
														<Button
															variant="bare"
															class="ico fold"
															icon="fold"
															label={`Hide column ${c.name}`}
															kbd="H"
															tabIndex={-1}
															onClick={() => toggleColumn(i(), c.name, true)}
														/>
													</Show>
												</div>
											</th>
										);
									}}
								</For>
								{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: header cells take no focus; this one only holds the width a narrow table leaves. */}
								<th class="fill" aria-hidden="true" />
							</tr>
						</thead>
						<tbody>
							{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: these rows are not focusable; spacer rows only hold the height of rows not drawn; assistive tech reads row positions from aria-rowindex instead. */}
							<tr class="pad" aria-hidden="true">
								<td style={{ height: `${range().first * rowHeight()}px` }} />
							</tr>
							<For each={rowKeys()}>
								{(key) => {
									const r = Number(key.slice(key.indexOf(":") + 1));
									const row = untrack(() => props.result.rows[r]) ?? [];
									const num = untrack(numeric);
									const link = untrack(linked);
									const cols = props.result.columns;
									const tds = row.map((v, k) =>
										cell(v, cols[k]?.type ?? "", num[k] ?? false, link[k] ?? false),
									);
									cells.set(r, tds);
									onCleanup(() => {
										if (cells.get(r) === tds) cells.delete(r);
									});
									return (
										<tr
											data-row={r}
											aria-rowindex={r + 2}
											classList={{ sel: props.selection.rows().has(r) }}
											aria-selected={props.selection.rows().has(r)}
										>
											<td class="rn">{((props.offset ?? 0) + r + 1).toLocaleString()}</td>
											{tds}
											<td class="fill" aria-hidden="true" />
										</tr>
									);
								}}
							</For>
							{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: these rows are not focusable; spacer rows only hold the height of rows not drawn; assistive tech reads row positions from aria-rowindex instead. */}
							<tr class="pad" aria-hidden="true">
								<td
									style={{
										height: `${(props.result.rows.length - range().last) * rowHeight()}px`,
									}}
								/>
							</tr>
						</tbody>
					</table>
					<Show when={!props.result.rows.length}>
						<div class="none">{props.empty ?? "No rows"}</div>
					</Show>
				</Show>
			</div>
			<Show when={inspected()}>
				{(c) => (
					<Inspector
						cell={c()}
						onClose={closeInspector}
						onMove={(dRow, dCol) => move(dRow, dCol)}
					/>
				)}
			</Show>
			<RowMenu
				target={rowMenu()}
				actions={{
					copyCell: () => void copyCurrent(),
					copyRows: (as) => void copyRows(as),
					save: saveRows,
					selectAll,
					inspect: () => setInspecting(true),
				}}
				onClose={closeRowMenu}
			/>
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
							columns: a().columns,
							copy: async (name) => {
								props.selection.tell(
									(await copyText(name)) ? `Copied the name ${name}` : "Copy failed",
								);
							},
						}}
						onClose={closeMenu}
					/>
				)}
			</Show>
		</div>
	);
}
