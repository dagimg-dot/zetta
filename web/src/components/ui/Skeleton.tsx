import { For } from "solid-js";
import "./skeleton.css";

const WIDTHS = [68, 92, 54, 84, 40, 76, 60, 88, 48];

/** The sidebar while the table list is on its way. index.html draws the same rows before any script runs. */
export function SkeletonTree(props: { label: string }) {
	return (
		<div class="sk-tree" role="status" aria-label={props.label}>
			<For each={WIDTHS}>
				{(w) => (
					<div class="sk-row">
						<span class="sk-bar" style={{ width: `${w}%` }} />
					</div>
				)}
			</For>
		</div>
	);
}

/** A pane of text on its way. It fades in late, so fast loads never flash it. */
export function SkeletonLines(props: { label: string }) {
	return (
		<div class="sk-lines" role="status" aria-label={props.label}>
			<For each={WIDTHS}>{(w) => <span class="sk-bar" style={{ width: `${w}%` }} />}</For>
		</div>
	);
}
