import { Menu, useMenu } from "@ark-ui/solid/menu";
import { createEffect, For, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { type FormatId, formats } from "../copy";
import type { InspectorAction } from "./Inspector";
import { Icon, type IconName } from "./icons";
import { Kbd } from "./Kbd";

export interface RowTarget {
	/** Where the menu opens: the pointer, or the cursor cell for the keyboard. */
	at: { x: number; y: number };
	/** Rows the copy actions take. */
	rows: number;
	/** The cell that was right-clicked; none for a row number. */
	cell: { column: string; actions: InspectorAction[]; incoming: InspectorAction[] } | null;
}

/** More references than this go into their own submenu, so a much-referenced key keeps the menu short. */
const INLINE_REFS = 3;

export interface RowActions {
	copyCell: () => void;
	copyRows: (as?: FormatId) => void;
	save: (as: FormatId) => void;
	selectAll: () => void;
	inspect: () => void;
}

/** One menu for the rows of a grid, opened by a right-click, the menu key or Shift+F10. */
export function RowMenu(props: {
	target: RowTarget | null;
	actions: RowActions;
	onClose: (restoreFocus: boolean) => void;
}) {
	const menu = useMenu(() => ({
		open: props.target !== null,
		positioning: { placement: "bottom-start", gutter: 2 },
		onOpenChange: (d) => {
			if (!d.open) props.onClose(true);
		},
		onSelect: (d) => select(d.value),
	}));

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
		const [verb, arg = ""] = v.split(":");
		const a = props.actions;
		if (verb === "cell") a.copyCell();
		else if (verb === "rows") a.copyRows();
		else if (verb === "as") a.copyRows(arg as FormatId);
		else if (verb === "save") a.save(arg as FormatId);
		else if (verb === "all") a.selectAll();
		else if (verb === "inspect") a.inspect();
		else if (verb === "act") props.target?.cell?.actions[Number(arg)]?.run();
		else if (verb === "ref") props.target?.cell?.incoming[Number(arg)]?.run();
	};

	const rowsLabel = () => {
		const n = props.target?.rows ?? 0;
		return n === 1 ? "1 row" : `${n.toLocaleString()} rows`;
	};

	const item = (v: string, label: string, icon?: IconName, kbd?: string, detail?: string) => (
		<Menu.Item value={v} class="pop-item">
			<span class="pop-icon">
				<Show when={icon}>{(i) => <Icon name={i()} />}</Show>
			</span>
			<span class="label">{label}</span>
			<Show when={detail}>{(d) => <span class="type">{d()}</span>}</Show>
			<Show when={kbd}>{(k) => <Kbd keys={k()} />}</Show>
		</Menu.Item>
	);

	/** A few references sit in the menu under one label, each named by its table. */
	const refsGroup = (refs: InspectorAction[]) => (
		<Menu.ItemGroup>
			<Menu.ItemGroupLabel class="pop-group">Rows pointing here</Menu.ItemGroupLabel>
			<For each={refs}>{(a, i) => item(`ref:${i()}`, a.label, a.icon, undefined, a.detail)}</For>
		</Menu.ItemGroup>
	);

	const refsMenu = (refs: InspectorAction[]) => (
		<Menu.Root
			positioning={{ placement: "right-start", gutter: 2 }}
			onSelect={(d) => select(d.value)}
		>
			<Menu.TriggerItem class="pop-item">
				<span class="pop-icon">
					<Icon name="next" />
				</span>
				<span class="label">Rows pointing here</span>
				<span class="type">{refs.length.toLocaleString()}</span>
				<span class="pop-sub">
					<Icon name="chevron" />
				</span>
			</Menu.TriggerItem>
			<Portal>
				<Menu.Positioner>
					<Menu.Content class="pop menu list refs" aria-label="Rows pointing here">
						<For each={refs}>
							{(a, i) => (
								<Menu.Item value={`ref:${i()}`} class="pop-item">
									<span class="label">{a.label}</span>
									<span class="type">{a.detail}</span>
								</Menu.Item>
							)}
						</For>
					</Menu.Content>
				</Menu.Positioner>
			</Portal>
		</Menu.Root>
	);

	/** "Copy as" and "Save as" list the same formats, from the table in copy.ts. */
	const formatMenu = (verb: "as" | "save", label: string, icon: IconName) => (
		<Menu.Root
			positioning={{ placement: "right-start", gutter: 2 }}
			onSelect={(d) => select(d.value)}
		>
			<Menu.TriggerItem class="pop-item">
				<span class="pop-icon">
					<Icon name={icon} />
				</span>
				<span class="label">{label}</span>
				<span class="pop-sub">
					<Icon name="chevron" />
				</span>
			</Menu.TriggerItem>
			<Portal>
				<Menu.Positioner>
					<Menu.Content class="pop menu" aria-label={label}>
						<For each={formats}>
							{(f) => (
								<Menu.Item value={`${verb}:${f.id}`} class="pop-item">
									<span class="label">{f.label}</span>
									<span class="type">.{f.ext}</span>
								</Menu.Item>
							)}
						</For>
					</Menu.Content>
				</Menu.Positioner>
			</Portal>
		</Menu.Root>
	);

	return (
		<Menu.RootProvider value={menu}>
			<Portal>
				<Menu.Positioner>
					<Menu.Content class="pop menu" aria-label="Rows">
						<Show when={props.target}>
							{(t) => (
								<>
									<div class="pop-head">
										<span>{t().rows > 1 ? `${rowsLabel()} selected` : "Row"}</span>
										<Show when={t().cell}>{(c) => <span class="type">{c().column}</span>}</Show>
									</div>
									<Show when={t().cell}>{item("cell", "Copy cell", "copy", "C")}</Show>
									{item("rows", t().rows > 1 ? `Copy ${rowsLabel()}` : "Copy row", "copy", "Mod+C")}
									{formatMenu("as", "Copy as", "code")}
									{formatMenu("save", "Save as file", "save")}
									<Show when={t().cell?.actions.length}>
										<Menu.Separator class="pop-sep" />
										<For each={t().cell?.actions}>
											{(a, i) => item(`act:${i()}`, a.label, a.icon, a.hint)}
										</For>
									</Show>
									<Show when={t().cell?.incoming.length ? t().cell?.incoming : undefined}>
										{(refs) => (
											<Show when={refs().length > INLINE_REFS} fallback={refsGroup(refs())}>
												{refsMenu(refs())}
											</Show>
										)}
									</Show>
									<Menu.Separator class="pop-sep" />
									{item("all", "Select all rows", undefined, "Mod+A")}
									<Show when={t().cell}>{item("inspect", "Inspect cell", "inspect", "Enter")}</Show>
								</>
							)}
						</Show>
					</Menu.Content>
				</Menu.Positioner>
			</Portal>
		</Menu.RootProvider>
	);
}
