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

export function ErrorBox(props: { error: ApiError }) {
	return (
		<div class="error" role="alert">
			<Icon name="alert" />
			<div>
				<div class="code">{codeLabel[props.error.code] ?? props.error.code}</div>
				<div class="msg">{props.error.message}</div>
			</div>
		</div>
	);
}
