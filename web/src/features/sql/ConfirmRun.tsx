import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../../components/ui/Button";
import { SqlText } from "../../components/ui/SqlText";
import { ApiError, countRows } from "../../lib/api";
import { plural } from "../../lib/format";
import type { Destructive } from "../../lib/sql";
import { catalogView } from "../../stores/catalog";
import "./confirm-run.css";

/** How long a row count may take before the dialog stops waiting for it. */
const countLimit = 3000;

/**
 * Asks before a run that would destroy data, saying what it would destroy and how many rows are at
 * stake. Cancel comes first in the dialog and so takes the focus, which keeps a reflexive Enter from
 * confirming. Counts arrive when they can and never hold up the answer.
 */
export function ConfirmRun(props: {
	database: string | undefined;
	actions: readonly Destructive[];
	onClose: (confirmed: boolean) => void;
}) {
	let dialog: HTMLDialogElement | undefined;
	let gaveUp = false;
	const stop = new AbortController();
	const timer = setTimeout(() => {
		gaveUp = true;
		stop.abort();
	}, countLimit);
	onCleanup(() => {
		clearTimeout(timer);
		stop.abort();
	});

	const [counts, setCounts] = createSignal<Record<number, string>>({});
	const note = (i: number, text: string) => setCounts((c) => ({ ...c, [i]: text }));

	onMount(() => {
		dialog?.showModal();
		const defaultSchema = catalogView().defaultSchema;
		props.actions.forEach((a, i) => {
			if (!a.table) return;
			note(i, "counting rows");
			countRows({ schema: a.table.schema ?? defaultSchema, table: a.table.name }, stop.signal).then(
				(r) => note(i, plural(r.count, "row")),
				(err: unknown) =>
					note(
						i,
						gaveUp || (err instanceof ApiError && err.code === "timeout")
							? "too many to count quickly"
							: "row count unavailable",
					),
			);
		});
	});

	// Not left to the close event, which a browser may hold back while the page is out of sight.
	const finish = (run: boolean) => {
		dialog?.close();
		props.onClose(run);
	};
	const statements = () => [...new Set(props.actions.map((a) => a.statement))];

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Esc already closes a modal dialog; this only adds the backdrop click.
		<dialog
			class="confirm-run"
			ref={dialog}
			role="alertdialog"
			aria-labelledby="confirm-run-title"
			aria-describedby="confirm-run-list"
			onCancel={(e) => {
				e.preventDefault();
				finish(false);
			}}
			onClick={(e) => {
				// A click on the backdrop lands on the dialog itself, outside its box.
				if (e.target === e.currentTarget) finish(false);
			}}
		>
			<h2 id="confirm-run-title">
				{statements().length > 1 ? "These statements destroy data" : "This statement destroys data"}
			</h2>
			<Show when={props.database}>
				{(name) => (
					<p class="where">
						In <span class="mono">{name()}</span>
					</p>
				)}
			</Show>
			<ul id="confirm-run-list">
				<For each={props.actions}>
					{(a, i) => (
						<li>
							<span>
								{a.what} <span class="mono target">{a.target}</span>
								<Show when={a.cascade}> and whatever depends on it</Show>
							</span>
							<Show when={counts()[i()]}>{(c) => <span class="count">{c()}</span>}</Show>
						</li>
					)}
				</For>
			</ul>
			<pre class="mono">
				<SqlText text={statements().join(";\n")} />
			</pre>
			<footer>
				<Button onClick={() => finish(false)}>Cancel</Button>
				<Button variant="danger" icon="warn" onClick={() => finish(true)}>
					Run anyway
				</Button>
			</footer>
		</dialog>
	);
}
