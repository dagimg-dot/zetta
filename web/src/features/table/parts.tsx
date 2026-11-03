import { type JSX, Show } from "solid-js";
import type { RefAction } from "../../lib/api";

export function Section(props: { title: string; note?: JSX.Element; children: JSX.Element }) {
	return (
		<section class="info-section">
			<header>
				<h2>{props.title}</h2>
				<Show when={props.note}>
					<span class="note">{props.note}</span>
				</Show>
			</header>
			{props.children}
		</section>
	);
}

export function None(props: { children: JSX.Element }) {
	return <p class="info-none">{props.children}</p>;
}

/** Both refuse the write while rows still point here, so neither is worth a badge on every key. */
const blocks = (a: RefAction) => a === "NO ACTION" || a === "RESTRICT";

/** Shows only the actions that change other rows: cascade, set null and set default. */
export function RefActions(props: { onDelete: RefAction; onUpdate: RefAction }) {
	const tone = (a: RefAction) => (a === "CASCADE" ? "warn" : "set");
	return (
		<span class="ref-actions">
			<Show when={!blocks(props.onDelete)}>
				<span class={`ref-action ${tone(props.onDelete)}`}>
					on delete {props.onDelete.toLowerCase()}
				</span>
			</Show>
			<Show when={!blocks(props.onUpdate)}>
				<span class={`ref-action ${tone(props.onUpdate)}`}>
					on update {props.onUpdate.toLowerCase()}
				</span>
			</Show>
		</span>
	);
}
