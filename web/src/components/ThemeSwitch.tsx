import { For } from "solid-js";
import { setTheme, type ThemePref, theme } from "../theme";
import { Icon, type IconName } from "./icons";

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
					<button
						type="button"
						aria-pressed={theme() === o.value}
						aria-label={`Theme: ${o.label}`}
						title={`${o.label} (T cycles)`}
						onClick={() => setTheme(o.value)}
					>
						<Icon name={o.icon} />
					</button>
				)}
			</For>
		</fieldset>
	);
}
