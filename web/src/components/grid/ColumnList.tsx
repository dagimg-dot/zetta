import { Popover } from "@ark-ui/solid/popover";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Button, type ButtonProps } from "../ui/Button";
import { Icon } from "../ui/icons";
import type { Hidden } from "./hidden";
import { matchColumns, showOnly } from "./hidden";

/**
 * Every column of a result as a checklist with a search, for keeping a handful of a wide table's
 * columns in one go. The grid's header menu opens the same list through `open`.
 */
export function ColumnList(props: {
	columns: readonly { name: string; type: string }[];
	hidden: Hidden;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [query, setQuery] = createSignal("");
	const [note, setNote] = createSignal("");
	let search: HTMLInputElement | undefined;

	const total = () => props.columns.length;
	const shown = () => props.columns.filter((c) => !props.hidden.hidden().has(c.name)).length;
	const matches = createMemo(() => matchColumns(props.columns, query()));

	const toggle = (name: string, show: boolean, box: HTMLInputElement) => {
		if (!show && shown() <= 1) {
			box.checked = true;
			setNote("The last column stays shown");
			return;
		}
		const next = new Set(props.hidden.hidden());
		if (show) next.delete(name);
		else next.add(name);
		props.hidden.set(next);
		setNote("");
	};

	const showMatching = () => {
		const next = showOnly(
			props.columns.map((c) => c.name),
			matches().map((c) => c.name),
		);
		if (next) props.hidden.set(next);
		setNote("");
	};

	return (
		<Popover.Root
			open={props.open}
			onOpenChange={(d) => {
				props.onOpenChange(d.open);
				if (!d.open) {
					setQuery("");
					setNote("");
				}
			}}
			positioning={{ placement: "top-end", gutter: 6 }}
			initialFocusEl={() => search ?? null}
		>
			<Popover.Trigger
				asChild={(p) => (
					<Button {...(p() as ButtonProps)} variant="quiet" size="sm" icon="columns">
						<Show when={shown() < total()} fallback="Columns">
							{shown().toLocaleString()} of {total().toLocaleString()}
							<span class="wide-only"> columns</span>
						</Show>
					</Button>
				)}
			/>
			<Portal>
				<Popover.Positioner>
					<Popover.Content class="pop cols-pop">
						<Popover.Title class="pop-head">
							<span>Columns</span>
							<span class="type">
								{shown().toLocaleString()} of {total().toLocaleString()} shown
							</span>
						</Popover.Title>
						<span class="refs-find cols-find">
							<Icon name="search" size={12} />
							<input
								ref={search}
								type="search"
								aria-label="Find columns by name or type"
								placeholder="Find columns"
								autocomplete="off"
								spellcheck={false}
								value={query()}
								onInput={(e) => setQuery(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === "Escape" && query()) {
										e.preventDefault();
										e.stopPropagation();
										setQuery("");
									}
								}}
							/>
						</span>
						<div class="cols-list">
							<fieldset>
								<legend class="sr-only">Shown columns</legend>
								<For each={matches()} fallback={<div class="pop-empty">No matching columns</div>}>
									{(c) => (
										<label class="pop-item cols-item">
											<input
												type="checkbox"
												checked={!props.hidden.hidden().has(c.name)}
												onChange={(e) => toggle(c.name, e.currentTarget.checked, e.currentTarget)}
											/>
											<span class="name mono">{c.name}</span>
											<span class="cols-type">{c.type}</span>
										</label>
									)}
								</For>
							</fieldset>
						</div>
						<div class="cols-foot">
							<span class="note" role="status">
								{note()}
							</span>
							<span class="spacer" />
							<Show when={query().trim()}>
								<Button size="sm" disabled={!matches().length} onClick={showMatching}>
									Only matching
								</Button>
							</Show>
							<Button
								size="sm"
								disabled={!props.hidden.hidden().size}
								onClick={() => {
									props.hidden.set(new Set());
									setNote("");
								}}
							>
								Show all
							</Button>
						</div>
					</Popover.Content>
				</Popover.Positioner>
			</Portal>
		</Popover.Root>
	);
}
