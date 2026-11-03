import { createListCollection } from "@ark-ui/solid/collection";
import { Select } from "@ark-ui/solid/select";
import { createMemo, For } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./icons";

export interface ChoiceOption<T extends string> {
	value: T;
	label: string;
}

/** A short fixed list, such as a filter condition, drawn like the column picker beside it. */
export function Choice<T extends string>(props: {
	options: ChoiceOption<T>[];
	value: T;
	onChange: (value: T) => void;
	label: string;
	class?: string;
}) {
	const collection = createMemo(() => createListCollection({ items: props.options }));

	return (
		<Select.Root
			class={`choice ${props.class ?? ""}`}
			collection={collection()}
			value={[props.value]}
			positioning={{ placement: "bottom-start", gutter: 4 }}
			onValueChange={(d) => {
				const v = d.value[0];
				const known = props.options.find((o) => o.value === v);
				if (known) props.onChange(known.value);
			}}
		>
			<Select.Control>
				<Select.Trigger class="choice-trigger" aria-label={props.label}>
					<Select.ValueText />
					<Select.Indicator class="choice-indicator">
						<Icon name="chevron" class="down" />
					</Select.Indicator>
				</Select.Trigger>
			</Select.Control>
			<Portal>
				<Select.Positioner>
					<Select.Content class="pop list choice-list">
						<For each={collection().items}>
							{(o) => (
								<Select.Item item={o} class="pop-item">
									<Select.ItemText class="label">{o.label}</Select.ItemText>
									<Select.ItemIndicator class="tick">
										<Icon name="check" />
									</Select.ItemIndicator>
								</Select.Item>
							)}
						</For>
					</Select.Content>
				</Select.Positioner>
			</Portal>
		</Select.Root>
	);
}
