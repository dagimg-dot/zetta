import { type JSX, Show, splitProps } from "solid-js";
import { Icon, type IconName, Loader } from "./icons";
import { Kbd } from "./Kbd";
import { type TipSide, tip } from "./Tip";

/**
 * How a button looks. `bare` drops the shared look for a control drawn by its own class, such as
 * a pager step or a theme segment, so it still gets the icon, loader and tooltip handling.
 */
export type ButtonVariant = "default" | "quiet" | "primary" | "danger" | "bare";

interface Own {
	variant?: ButtonVariant;
	/** `sm` for a button inside a bar, a note or a row of small controls. */
	size?: "sm";
	icon?: IconName;
	iconSize?: number;
	/**
	 * Names a button that shows only its icon: it becomes the accessible name and the tooltip. A
	 * button with text needs none.
	 */
	label?: string;
	/**
	 * The shortcut that presses it, like `Mod+Enter`: drawn beside the text, or in the tooltip of
	 * an icon-only button.
	 */
	kbd?: string;
	/** A tooltip for a button with text, when the text does not say enough on its own. */
	tip?: string;
	tipSide?: TipSide;
	/** Its work is running: the loader takes the icon's place and the button waits, still legible. */
	busy?: boolean;
	pressed?: boolean;
	type?: "button" | "submit";
	class?: string;
	disabled?: boolean;
	children?: JSX.Element;
}

export type ButtonProps = Own &
	Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, keyof Own | "aria-pressed" | "aria-busy">;

/** The app's one button: text or icon-only, with an optional shortcut, tooltip and busy state. */
export function Button(props: ButtonProps) {
	const [own, rest] = splitProps(props, [
		"variant",
		"size",
		"icon",
		"iconSize",
		"label",
		"kbd",
		"tip",
		"tipSide",
		"busy",
		"pressed",
		"type",
		"class",
		"disabled",
		"children",
	]);
	const iconOnly = !("children" in props);
	const variant = () => own.variant ?? (iconOnly ? "quiet" : "default");
	const cls = () => {
		const v = variant();
		const out = v === "bare" ? [] : ["btn"];
		if (v !== "default" && v !== "bare") out.push(v);
		if (iconOnly && v !== "bare") out.push("icon-only");
		if (own.size && v !== "bare") out.push(own.size);
		if (own.class) out.push(own.class);
		return out.join(" ");
	};

	return (
		<button
			type={own.type ?? "button"}
			class={cls()}
			disabled={own.disabled || own.busy}
			aria-label={iconOnly ? own.label : undefined}
			aria-pressed={own.pressed}
			aria-busy={own.busy || undefined}
			{...tip(
				iconOnly ? own.label : own.tip,
				iconOnly ? own.kbd : undefined,
				own.tipSide ?? (iconOnly ? "bottom" : "top"),
			)}
			{...rest}
		>
			<Show
				when={own.busy}
				fallback={<Show when={own.icon}>{(i) => <Icon name={i()} size={own.iconSize} />}</Show>}
			>
				<Loader size={own.iconSize ?? (iconOnly ? 12 : 14)} />
			</Show>
			{own.children}
			<Show when={!iconOnly && own.kbd}>{(k) => <Kbd keys={k()} />}</Show>
		</button>
	);
}
