import { For } from "solid-js";
import { Icon } from "./icons";

const groups: { title: string; keys: [string[], string][] }[] = [
	{
		title: "Anywhere",
		keys: [
			[["/"], "Search tables"],
			[["d"], "Data tab"],
			[["s"], "SQL tab"],
			[["f"], "Filter the rows"],
			[["g"], "Focus the grid"],
			[["["], "Previous page"],
			[["]"], "Next page"],
			[["t"], "Cycle the theme: system, light, dark"],
			[["?"], "This list"],
		],
	},
	{
		title: "In the grid",
		keys: [
			[["↑", "↓", "←", "→"], "Move between cells"],
			[["Enter"], "Open or close the inspector"],
			[["C"], "Copy the cell"],
			[["H"], "Hide the column"],
			[["O"], "Follow the foreign key in the cell"],
			[["Shift", "click"], "Add a header to the sort"],
			[["Esc"], "Close the inspector"],
		],
	},
	{
		title: "In the SQL editor",
		keys: [
			[["Ctrl", "↵"], "Run, or run the selection"],
			[["Esc"], "Leave the editor"],
		],
	},
];

export function Shortcuts(props: { ref: (el: HTMLDialogElement) => void }) {
	return (
		<dialog class="shortcuts" ref={props.ref} aria-labelledby="shortcuts-title">
			<header>
				<span id="shortcuts-title">Keyboard shortcuts</span>
				<span class="spacer" />
				<form method="dialog">
					<button type="submit" class="btn quiet icon-only" aria-label="Close">
						<Icon name="close" />
					</button>
				</form>
			</header>
			<dl>
				<For each={groups}>
					{(g) => (
						<>
							<h3>{g.title}</h3>
							<For each={g.keys}>
								{([keys, what]) => (
									<>
										<dt>
											<For each={keys}>{(k) => <kbd>{k}</kbd>}</For>
										</dt>
										<dd>{what}</dd>
									</>
								)}
							</For>
						</>
					)}
				</For>
			</dl>
		</dialog>
	);
}
