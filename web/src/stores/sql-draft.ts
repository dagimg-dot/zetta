import { createSignal } from "solid-js";
import { setView } from "./view";

const [sqlDraft, setSqlDraft] = createSignal<string | null>(null);

export { sqlDraft };

/** Hands a statement to the SQL tab and goes there, without running it. */
export function openInSql(text: string): void {
	setSqlDraft(text);
	setView({ tab: "sql" }, "push");
}

export function clearSqlDraft(): void {
	setSqlDraft(null);
}
