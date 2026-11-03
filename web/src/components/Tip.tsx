import { Tooltip } from "@ark-ui/solid/tooltip";
import { type JSX, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon, type IconName, Loader } from "./icons";

/** Hover and focus delays shared by every tooltip, so moving along a toolbar feels like one control. */
const timing = { openDelay: 450, closeDelay: 80 };

export function TipContent(props: { label: JSX.Element; kbd?: string }) {
	return (
		<Portal>
			<Tooltip.Positioner>
				<Tooltip.Content class="tip">
					<span>{props.label}</span>
					<Show when={props.kbd}>
						<kbd>{props.kbd}</kbd>
					</Show>
				</Tooltip.Content>
			</Tooltip.Positioner>
		</Portal>
	);
}

/** An icon-only button whose name shows as a tooltip on hover and keyboard focus. */
export function IconButton(props: {
	icon: IconName;
	label: string;
	kbd?: string;
	size?: number;
	class?: string;
	pressed?: boolean;
	disabled?: boolean;
	/** Shows the loader in place of the icon while the button's work runs. */
	busy?: boolean;
	placement?: "top" | "bottom" | "left" | "right";
	/** Set as data-name, for shortcuts that press the button. */
	name?: string;
	onClick: () => void;
}) {
	return (
		<Tooltip.Root {...timing} positioning={{ placement: props.placement ?? "bottom", gutter: 6 }}>
			<Tooltip.Trigger
				type="button"
				class={props.class ?? "btn quiet icon-only"}
				aria-label={props.label}
				aria-pressed={props.pressed}
				data-name={props.name}
				disabled={props.disabled}
				aria-busy={props.busy || undefined}
				onClick={() => props.onClick()}
			>
				<Show when={props.busy} fallback={<Icon name={props.icon} size={props.size} />}>
					<Loader size={props.size ?? 12} />
				</Show>
			</Tooltip.Trigger>
			<TipContent label={props.label} kbd={props.kbd} />
		</Tooltip.Root>
	);
}
