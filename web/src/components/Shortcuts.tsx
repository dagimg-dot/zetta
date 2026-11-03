import { For, Show } from "solid-js";
import { Button } from "./Button";
import { Kbd } from "./Kbd";

/** Each shortcut once: the keys, as `Mod+Enter`, and what they do. `click` adds a mouse click. */
interface Shortcut {
	keys: string[];
	click?: boolean;
	what: string;
}

const groups: { title: string; keys: Shortcut[] }[] = [
	{
		title: "Anywhere",
		keys: [
			{ keys: ["/"], what: "Search tables" },
			{ keys: ["d"], what: "Data tab" },
			{ keys: ["s"], what: "SQL tab" },
			{ keys: ["f"], what: "Filter the rows" },
			{ keys: ["g"], what: "Focus the grid" },
			{ keys: ["["], what: "Previous page" },
			{ keys: ["]"], what: "Next page" },
			{ keys: ["t"], what: "Cycle the theme: system, light, dark" },
			{ keys: ["?"], what: "This list" },
		],
	},
	{
		title: "In the grid",
		keys: [
			{ keys: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], what: "Move between cells" },
			{ keys: ["Home", "End"], what: "First or last column" },
			{ keys: ["Mod+ArrowUp", "Mod+ArrowDown"], what: "First or last row" },
			{ keys: ["PageUp", "PageDown"], what: "Move a screen up or down" },
			{ keys: ["Enter"], what: "Open or close the inspector" },
			{ keys: ["C"], what: "Copy the cell" },
			{ keys: ["Shift+Space"], what: "Select or unselect the row" },
			{ keys: ["Shift+ArrowUp", "Shift+ArrowDown"], what: "Extend the row selection" },
			{ keys: ["Mod+A"], what: "Select every row" },
			{ keys: ["Mod+C"], what: "Copy the selected rows, ready to paste into a spreadsheet" },
			{ keys: ["Shift+F10"], what: "Row menu: copy as JSON, CSV, TSV or Markdown" },
			{ keys: ["H"], what: "Hide the column" },
			{ keys: ["O"], what: "Follow the foreign key in the cell" },
			{ keys: ["Shift"], click: true, what: "Add a header to the sort" },
			{ keys: ["Esc"], what: "Close the inspector, then clear the selection" },
		],
	},
	{
		title: "In the SQL editor",
		keys: [
			{ keys: ["Mod+Enter"], what: "Run, or run the selection" },
			{ keys: ["Esc"], what: "Leave the editor" },
		],
	},
];

export function Shortcuts(props: { ref: (el: HTMLDialogElement) => void }) {
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Esc already closes a modal dialog; this only adds the backdrop click.
		<dialog
			class="shortcuts"
			ref={props.ref}
			aria-labelledby="shortcuts-title"
			onClick={(e) => {
				// A click on the backdrop lands on the dialog itself, outside its box.
				if (e.target === e.currentTarget) e.currentTarget.close();
			}}
		>
			<header>
				<span id="shortcuts-title">Keyboard shortcuts</span>
				<span class="spacer" />
				<form method="dialog">
					<Button type="submit" icon="close" label="Close" kbd="Esc" />
				</form>
			</header>
			<dl>
				<For each={groups}>
					{(g) => (
						<>
							<h3>{g.title}</h3>
							<For each={g.keys}>
								{(k) => (
									<>
										<dt>
											<For each={k.keys}>
												{(combo, i) => (
													<>
														<Show when={i() > 0}>
															<span class="or">or</span>
														</Show>
														<Kbd keys={combo} />
													</>
												)}
											</For>
											<Show when={k.click}>
												<span class="click">click</span>
											</Show>
										</dt>
										<dd>{k.what}</dd>
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
