import { For } from "solid-js";
import { Button } from "./Button";
import type { IconName } from "./icons";

export interface Segment<T extends string> {
	value: T;
	/** Shown as text, or, with an icon, as the accessible name and tooltip. */
	label: string;
	icon?: IconName;
}

/** A row of mutually exclusive choices, such as the theme or a value's view. */
export function Segmented<T extends string>(props: {
	legend: string;
	options: Segment<T>[];
	value: T;
	onChange: (value: T) => void;
	/** The key that cycles the choices, shown in each icon's tooltip. */
	kbd?: string;
	class?: string;
}) {
	return (
		<fieldset class={`segmented ${props.class ?? ""}`}>
			<legend class="sr-only">{props.legend}</legend>
			<For each={props.options}>
				{(o) =>
					o.icon ? (
						<Button
							variant="bare"
							class="seg"
							icon={o.icon}
							label={o.label}
							kbd={props.kbd}
							tipSide="top"
							pressed={props.value === o.value}
							onClick={() => props.onChange(o.value)}
						/>
					) : (
						<Button
							variant="bare"
							class="seg"
							pressed={props.value === o.value}
							onClick={() => props.onChange(o.value)}
						>
							{o.label}
						</Button>
					)
				}
			</For>
		</fieldset>
	);
}
