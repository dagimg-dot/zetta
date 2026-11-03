import { setTheme, type ThemePref, theme } from "../theme";
import { type Segment, Segmented } from "./Segmented";

const options: Segment<ThemePref>[] = [
	{ value: "system", label: "Theme: Match the system", icon: "monitor" },
	{ value: "light", label: "Theme: Light", icon: "sun" },
	{ value: "dark", label: "Theme: Dark", icon: "moon" },
];

export function ThemeSwitch() {
	return <Segmented legend="Theme" options={options} value={theme()} onChange={setTheme} kbd="T" />;
}
