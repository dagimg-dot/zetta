/**
 * How a key is written on a key cap. Shortcuts are named once, like `Mod+Enter`, and drawn for the
 * platform: `Mod` is Command on a Mac and Ctrl elsewhere, matching handlers that accept either.
 */

export interface KeyCap {
	/** What the cap shows. */
	text: string;
	/** What a screen reader says. */
	name: string;
}

const named: Record<string, { mac: KeyCap; other: KeyCap }> = {
	mod: { mac: { text: "⌘", name: "Command" }, other: { text: "Ctrl", name: "Control" } },
	ctrl: { mac: { text: "⌃", name: "Control" }, other: { text: "Ctrl", name: "Control" } },
	shift: { mac: { text: "⇧", name: "Shift" }, other: { text: "Shift", name: "Shift" } },
	alt: { mac: { text: "⌥", name: "Option" }, other: { text: "Alt", name: "Alt" } },
};

const same: Record<string, KeyCap> = {
	enter: { text: "↵", name: "Enter" },
	esc: { text: "Esc", name: "Escape" },
	escape: { text: "Esc", name: "Escape" },
	space: { text: "Space", name: "Space" },
	tab: { text: "Tab", name: "Tab" },
	arrowup: { text: "↑", name: "Up arrow" },
	arrowdown: { text: "↓", name: "Down arrow" },
	arrowleft: { text: "←", name: "Left arrow" },
	arrowright: { text: "→", name: "Right arrow" },
	pageup: { text: "PgUp", name: "Page up" },
	pagedown: { text: "PgDn", name: "Page down" },
	home: { text: "Home", name: "Home" },
	end: { text: "End", name: "End" },
};

export function isMac(): boolean {
	if (typeof navigator === "undefined") return false;
	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	return /mac|iphone|ipad/i.test(data?.platform || navigator.platform || "");
}

/** `Mod+Shift+K` as its keys. A lone `+` is the plus key. */
export function splitKeys(combo: string): string[] {
	if (combo === "+") return ["+"];
	return combo.split("+").filter(Boolean);
}

export function keyCap(key: string, mac: boolean): KeyCap {
	const k = key.toLowerCase();
	const platform = named[k];
	if (platform) return mac ? platform.mac : platform.other;
	const fixed = same[k];
	if (fixed) return fixed;
	// Letters are printed in capitals, as on the keyboard; the shortcut is still the plain key.
	return /^[a-z]$/.test(k)
		? { text: k.toUpperCase(), name: k.toUpperCase() }
		: { text: key, name: key };
}
