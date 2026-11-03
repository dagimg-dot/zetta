import { For } from "solid-js";
import { isMac, keyCap, splitKeys } from "../../lib/keys";
import "./kbd.css";

const mac = isMac();

/**
 * A shortcut as key caps, one cap per key: `Mod+Enter` draws as ⌘ ↵ on a Mac and Ctrl ↵ elsewhere.
 * The caps are drawn for the eye; screen readers hear the key names instead.
 */
export function Kbd(props: { keys: string; class?: string }) {
	const caps = () => splitKeys(props.keys).map((k) => keyCap(k, mac));
	return (
		<kbd class={props.class ? `keys ${props.class}` : "keys"}>
			<span class="caps" aria-hidden="true">
				<For each={caps()}>{(c) => <kbd>{c.text}</kbd>}</For>
			</span>
			<span class="sr-only">
				{caps()
					.map((c) => c.name)
					.join(" ")}
			</span>
		</kbd>
	);
}
