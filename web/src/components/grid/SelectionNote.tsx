import { Show } from "solid-js";
import { Button } from "../ui/Button";
import { Icon } from "../ui/icons";
import type { Selection } from "./selection";

/** The status bar's selection count, or the note a copy just left. */
export function SelectionNote(props: { selection: Selection; total: number }) {
	const n = () => props.selection.rows().size;
	return (
		<Show
			when={props.selection.note()}
			fallback={
				<Show when={n()}>
					<span class="st-selected">
						<span class="st-num">{n().toLocaleString()}</span>
						<span class="st-word">of {props.total.toLocaleString()} selected</span>
						<Button
							variant="bare"
							class="st-clear"
							icon="close"
							iconSize={10}
							label="Clear the selection"
							kbd="Esc"
							tipSide="top"
							onClick={() => props.selection.clear()}
						/>
					</span>
				</Show>
			}
		>
			<span class="st-copied">
				<Icon name="check" size={11} />
				{props.selection.note()}
			</span>
		</Show>
	);
}
