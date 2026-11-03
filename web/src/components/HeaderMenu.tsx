import { Menu, useMenu } from "@ark-ui/solid/menu";
import { Popover } from "@ark-ui/solid/popover";
import { batch, createEffect, createSignal, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { categoryOf, type Filter, type Op, opInfo, opsFor } from "../query";
import { Choice } from "./Choice";
import { Icon, type IconName } from "./icons";

export interface HeaderTarget {
	name: string;
	type: string;
	nullable: boolean;
	sort: "asc" | "desc" | null;
	/** Whether other columns are sorted too, so "add" differs from "sort by". */
	othersSorted: boolean;
	link: { schema: string; table: string } | null;
	/** Where the menu opens: under the header button, or at the pointer for a right-click. */
	at: { x: number; y: number };
	/** The header cell, for the filter popover to sit under. */
	rect: DOMRect;
	/** Primary key, not null, default: what the header has no room for. */
	facts: string[];
}

export interface HeaderActions {
	sort: (col: string, dir: "asc" | "desc" | null, additive: boolean) => void;
	filter: (f: Filter) => void;
	hide: (col: string) => void;
	copy: (col: string) => void;
	open: (schema: string, table: string) => void;
}

/**
 * One menu and one filter popover shared by every header of a grid. Each opens at the header that
 * asked, so a wide table does not mount a state machine per column.
 */
export function HeaderMenu(props: {
	target: HeaderTarget | null;
	actions: HeaderActions;
	onClose: (restoreFocus: boolean) => void;
}) {
	const [filtering, setFiltering] = createSignal<HeaderTarget | null>(null);
	const [op, setOp] = createSignal<Op>("eq");
	const [value, setValue] = createSignal("");
	let valueInput: HTMLInputElement | undefined;

	createEffect(
		on(filtering, (t) => {
			if (!t) return;
			setOp(opsFor(categoryOf(t.type))[0]?.op ?? "eq");
			setValue("");
		}),
	);

	const menu = useMenu(() => ({
		open: props.target !== null && filtering() === null,
		positioning: { placement: "bottom-start", gutter: 4 },
		onOpenChange: (d) => {
			if (!d.open && filtering() === null) props.onClose(true);
		},
		onSelect: (d) => select(d.value),
	}));

	// The menu has no trigger element, so it is placed at the header or pointer that opened it.
	createEffect(
		on(
			() => props.target?.at,
			(at) => {
				if (at)
					menu
						.api()
						.reposition({ getAnchorRect: () => ({ x: at.x, y: at.y, width: 0, height: 0 }) });
			},
		),
	);

	const select = (v: string) => {
		const t = props.target;
		if (!t) return;
		const [verb, arg] = v.split(":");
		if (verb === "sort")
			props.actions.sort(t.name, arg === "none" ? null : arg === "desc" ? "desc" : "asc", false);
		else if (verb === "add") props.actions.sort(t.name, "asc", true);
		else if (verb === "filter") setFiltering(t);
		else if (verb === "null") props.actions.filter({ c: t.name, op: "is_null", v: "" });
		else if (verb === "notnull") props.actions.filter({ c: t.name, op: "not_null", v: "" });
		else if (verb === "hide") props.actions.hide(t.name);
		else if (verb === "copy") props.actions.copy(t.name);
		else if (verb === "open" && t.link) props.actions.open(t.link.schema, t.link.table);
	};

	const apply = () => {
		const t = filtering();
		if (!t) return;
		props.actions.filter({ c: t.name, op: op(), v: value() });
		closeFilter();
	};

	/** Clears the target in the same batch, or the menu would reopen the moment the popover closes. */
	const closeFilter = () =>
		batch(() => {
			setFiltering(null);
			props.onClose(true);
		});

	const item = (v: string, label: string, icon?: IconName) => (
		<Menu.Item value={v} class="pop-item">
			<span class="pop-icon">
				<Show when={icon}>{(i) => <Icon name={i()} />}</Show>
			</span>
			<span class="label">{label}</span>
		</Menu.Item>
	);

	return (
		<>
			<Menu.RootProvider value={menu}>
				<Portal>
					<Menu.Positioner>
						<Menu.Content
							class="pop menu"
							aria-label={props.target ? `Column ${props.target.name}` : "Column"}
						>
							<Show when={props.target}>
								{(t) => (
									<>
										<div class="pop-head">
											<span class="mono">{t().name}</span>
											<span class="type">{t().type}</span>
										</div>
										<Show when={t().facts.length}>
											<div class="pop-facts">{t().facts.join(" · ")}</div>
										</Show>
										<Show when={t().sort !== "asc"}>
											{item("sort:asc", "Sort ascending", "asc")}
										</Show>
										<Show when={t().sort !== "desc"}>
											{item("sort:desc", "Sort descending", "desc")}
										</Show>
										<Show when={t().othersSorted && t().sort === null}>
											{item("add:asc", "Add to the sort", "plus")}
										</Show>
										<Show when={t().sort !== null}>
											{item("sort:none", "Remove the sort", "close")}
										</Show>
										<Menu.Separator class="pop-sep" />
										{item("filter", "Filter…", "filter")}
										<Show when={t().nullable}>
											{item("null", "Only NULL")}
											{item("notnull", "Hide NULL")}
										</Show>
										<Menu.Separator class="pop-sep" />
										<Show when={t().link}>{(l) => item("open", `Open ${l().table}`, "go")}</Show>
										{item("copy", "Copy name", "copy")}
										{item("hide", "Hide column", "fold")}
									</>
								)}
							</Show>
						</Menu.Content>
					</Menu.Positioner>
				</Portal>
			</Menu.RootProvider>

			<Popover.Root
				open={filtering() !== null}
				onOpenChange={(d) => {
					if (!d.open) closeFilter();
				}}
				positioning={{
					placement: "bottom-start",
					gutter: 4,
					getAnchorRect: () => {
						const r = filtering()?.rect;
						return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
					},
				}}
				initialFocusEl={() => valueInput ?? null}
			>
				<Portal>
					<Popover.Positioner>
						<Popover.Content class="pop filter-pop">
							<Show when={filtering()}>
								{(t) => (
									<form
										onSubmit={(e) => {
											e.preventDefault();
											apply();
										}}
									>
										<Popover.Title class="pop-head">
											<span>Filter</span>
											<span class="mono">{t().name}</span>
											<span class="type">{t().type}</span>
										</Popover.Title>
										<div class="filter-row">
											<Choice
												label="Condition"
												options={opsFor(categoryOf(t().type)).map((o) => ({
													value: o.op,
													label: o.label,
												}))}
												value={op()}
												onChange={setOp}
											/>
											<Show when={opInfo(op()).value}>
												<input
													ref={valueInput}
													type="text"
													class="mono"
													aria-label={`Value for ${t().name}`}
													placeholder={op() === "in" ? "a, b, c" : "value"}
													autocomplete="off"
													spellcheck={false}
													value={value()}
													onInput={(e) => setValue(e.currentTarget.value)}
												/>
											</Show>
										</div>
										<div class="filter-foot">
											<span class="note">Adds to the filters above the grid.</span>
											<span class="spacer" />
											<button type="submit" class="btn primary">
												Apply
												<kbd>↵</kbd>
											</button>
										</div>
									</form>
								)}
							</Show>
						</Popover.Content>
					</Popover.Positioner>
				</Portal>
			</Popover.Root>
		</>
	);
}
