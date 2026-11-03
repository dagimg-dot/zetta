import { createSignal } from "solid-js";

export type ThemePref = "system" | "light" | "dark";

const KEY = "zetta.theme";
const order: ThemePref[] = ["system", "light", "dark"];

function load(): ThemePref {
	try {
		const v = localStorage.getItem(KEY);
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

/** "system" removes the attribute, so the stylesheet's color-scheme follows the OS. */
function apply(pref: ThemePref): void {
	if (pref === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = pref;
}

const [theme, setThemeSignal] = createSignal<ThemePref>(load());
apply(theme());

export { theme };

export function setTheme(pref: ThemePref): void {
	setThemeSignal(pref);
	apply(pref);
	try {
		if (pref === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, pref);
	} catch {
		// Storage can be blocked; the choice then lasts for this page only.
	}
}

export function cycleTheme(): ThemePref {
	const next = order[(order.indexOf(theme()) + 1) % order.length] ?? "system";
	setTheme(next);
	return next;
}
