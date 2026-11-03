import { createSignal } from "solid-js";

const [message, setMessage] = createSignal("");

/** Text for the polite live region, so screen readers hear loads and results. */
export { message as announcement };

export function announce(text: string): void {
	// Clearing first makes a repeat of the same text announce again.
	setMessage("");
	queueMicrotask(() => setMessage(text));
}
