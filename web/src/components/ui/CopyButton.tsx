import { createSignal, onCleanup, splitProps } from "solid-js";
import { copyText } from "../../lib/clipboard";
import { announce } from "../../stores/announce";
import { Button, type ButtonProps } from "./Button";

/**
 * A button that copies text and says how it went: a check on success, an alert on failure, and an
 * announcement either way. Its label never changes, so it keeps its width.
 */
export function CopyButton(
	props: Omit<ButtonProps, "onClick" | "icon"> & {
		text: () => string;
		/** Named in the announcement, as in "Copied the DDL". */
		what: string;
	},
) {
	const [own, rest] = splitProps(props, ["text", "what"]);
	const [state, setState] = createSignal<"idle" | "done" | "failed">("idle");
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(timer));

	const copy = async () => {
		const ok = await copyText(own.text());
		setState(ok ? "done" : "failed");
		announce(ok ? `Copied ${own.what}` : "Copy failed");
		clearTimeout(timer);
		timer = setTimeout(() => setState("idle"), 1200);
	};

	return (
		<Button
			{...rest}
			icon={state() === "done" ? "check" : state() === "failed" ? "alert" : "copy"}
			onClick={copy}
		/>
	);
}
