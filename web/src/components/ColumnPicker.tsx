import { createListCollection } from "@ark-ui/solid/collection";
import { Combobox } from "@ark-ui/solid/combobox";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./icons";

export interface ColumnChoice {
	name: string;
	type: string;
	primaryKey?: boolean;
}

/**
 * Picks a column by typing part of its name. The list shows each column's type, so wide tables
 * stay searchable where a native select would be a long scroll.
 */
export function ColumnPicker(props: {
	columns: ColumnChoice[];
	value: string;
	onChange: (name: string) => void;
	label: string;
	class?: string;
}) {
	const [query, setQuery] = createSignal("");

	const collection = createMemo(() => {
		const q = query().trim().toLowerCase();
		const items = q ? props.columns.filter((c) => c.name.toLowerCase().includes(q)) : props.columns;
		return createListCollection({ items, itemToString: (c) => c.name, itemToValue: (c) => c.name });
	});

	const typeOf = () => props.columns.find((c) => c.name === props.value)?.type ?? "";

	return (
		<Combobox.Root
			class={`picker ${props.class ?? ""}`}
			collection={collection()}
			value={[props.value]}
			defaultInputValue={props.value}
			openOnClick
			inputBehavior="autohighlight"
			selectionBehavior="replace"
			positioning={{ placement: "bottom-start", gutter: 4, sameWidth: false }}
			onValueChange={(d) => {
				const [name] = d.value;
				if (name) props.onChange(name);
			}}
			onInputValueChange={(d) => setQuery(d.reason === "input-change" ? d.inputValue : "")}
			onOpenChange={(d) => {
				if (!d.open) setQuery("");
			}}
		>
			<Combobox.Control class="picker-control">
				<Combobox.Input class="picker-input mono" aria-label={props.label} spellcheck={false} />
				<span class="picker-type" aria-hidden="true">
					{typeOf()}
				</span>
				<Combobox.Trigger class="picker-trigger" aria-label={`Choose ${props.label.toLowerCase()}`}>
					<Icon name="chevron" class="down" />
				</Combobox.Trigger>
			</Combobox.Control>
			<Portal>
				<Combobox.Positioner>
					<Combobox.Content class="pop list">
						<Show
							when={collection().items.length}
							fallback={<div class="pop-empty">No column matches</div>}
						>
							<For each={collection().items}>
								{(c) => (
									<Combobox.Item item={c} class="pop-item">
										<Combobox.ItemText class="mono name">{c.name}</Combobox.ItemText>
										<Show when={c.primaryKey}>
											<Icon name="key" class="pk" />
										</Show>
										<span class="type">{c.type}</span>
										<Combobox.ItemIndicator class="tick">
											<Icon name="check" />
										</Combobox.ItemIndicator>
									</Combobox.Item>
								)}
							</For>
						</Show>
					</Combobox.Content>
				</Combobox.Positioner>
			</Portal>
		</Combobox.Root>
	);
}
