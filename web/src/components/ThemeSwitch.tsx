import { For } from "solid-js";
import { setTheme, type ThemePref, theme } from "../theme";
import { Button } from "./Button";
import type { IconName } from "./icons";

const options: { value: ThemePref; label: string; icon: IconName }[] = [
	{ value: "system", label: "Match the system", icon: "monitor" },
	{ value: "light", label: "Light", icon: "sun" },
	{ value: "dark", label: "Dark", icon: "moon" },
];

export function ThemeSwitch() {
	return (
		<fieldset class="theme-switch">
			<legend class="sr-only">Theme</legend>
			<For each={options}>
				{(o) => (
					<Button
						variant="bare"
						class="theme-btn"
						icon={o.icon}
						label={`Theme: ${o.label}`}
						kbd="T"
						tipSide="top"
						pressed={theme() === o.value}
						onClick={() => setTheme(o.value)}
					/>
				)}
			</For>
		</fieldset>
	);
}
