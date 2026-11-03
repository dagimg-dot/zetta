import { type JSX, Show } from "solid-js";
import type { ApiError } from "../api";
import { Icon } from "./icons";

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
};

const codeHint: Record<string, string> = {
	read_only: "zetta was started with --read-only, so writes are refused.",
	network: "The zetta process may have stopped. Restart it and reload this page.",
	connect_failed: "Check that the database is running and reachable from zetta.",
};

export function ErrorBox(props: { error: ApiError; inline?: boolean; children?: JSX.Element }) {
	return (
		<div class="error" classList={{ inline: !!props.inline }} role="alert">
			<Icon name="alert" />
			<div class="body">
				<div class="code">{codeLabel[props.error.code] ?? props.error.code}</div>
				<div class="msg">{props.error.message}</div>
				<Show when={codeHint[props.error.code]}>{(hint) => <div class="hint">{hint()}</div>}</Show>
				<Show when={props.children}>
					<div class="actions">{props.children}</div>
				</Show>
			</div>
		</div>
	);
}
