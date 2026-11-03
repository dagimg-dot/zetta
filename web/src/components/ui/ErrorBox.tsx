import { type JSX, Show } from "solid-js";
import type { ApiError } from "../../lib/api";
import { Icon } from "./icons";
import "./error-box.css";

const codeLabel: Record<string, string> = {
	db_error: "Database error",
	bad_request: "Bad request",
	read_only: "Read-only mode",
	connect_failed: "Cannot reach the database",
	too_large: "Request too large",
	not_found: "Not found",
	network: "Cannot reach zetta",
	internal: "Internal error",
	unauthorized: "Unauthorized",
	timeout: "Timed out",
};

/**
 * The message, without the severity Postgres puts first (the heading already says it), and the
 * "LINE n:" block with its caret, kept apart so the caret stays under the line it marks.
 */
function split(message: string): { text: string; where: string | null } {
	const text = message.replace(/^(ERROR|FATAL|PANIC):\s+/, "");
	const at = text.search(/\nLINE \d+: /);
	return at < 0 ? { text, where: null } : { text: text.slice(0, at), where: text.slice(at + 1) };
}

const codeHint: Record<string, string> = {
	read_only: "zetta was started with --read-only, so writes are refused.",
	network: "The zetta process may have stopped. Restart it and reload this page.",
	connect_failed: "Check that the database is running and reachable from zetta.",
};

/** A long line scrolls sideways; this brings the caret into view rather than the line's start. */
function toCaret(el: HTMLPreElement) {
	requestAnimationFrame(() => {
		const text = [...el.childNodes].find((n) => n.textContent?.includes("^"));
		const at = text?.textContent?.lastIndexOf("^") ?? -1;
		if (!text || at < 0) return;
		const range = document.createRange();
		range.setStart(text, at);
		range.setEnd(text, at + 1);
		const x = range.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
		el.scrollLeft = x - el.clientWidth / 2;
	});
}

export function ErrorBox(props: { error: ApiError; inline?: boolean; children?: JSX.Element }) {
	return (
		<div class="error" classList={{ inline: !!props.inline }} role="alert">
			<Icon name="alert" />
			<div class="body">
				<div class="code">{codeLabel[props.error.code] ?? props.error.code}</div>
				<div class="msg">{split(props.error.message).text}</div>
				<Show when={split(props.error.message).where}>
					{(where) => (
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a long line scrolls sideways, and a scrollable region must be reachable by keyboard.
						<pre class="where" tabIndex={0} ref={toCaret}>
							{where()}
						</pre>
					)}
				</Show>
				<Show when={codeHint[props.error.code]}>{(hint) => <div class="hint">{hint()}</div>}</Show>
				<Show when={props.children}>
					<div class="actions">{props.children}</div>
				</Show>
			</div>
		</div>
	);
}
