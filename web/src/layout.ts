import { type Accessor, createSignal } from "solid-js";

/**
 * A panel width the viewer drags, kept in this browser like the theme. It is written to a CSS
 * variable on the root, so the stylesheet keeps doing the layout.
 */
export interface Width {
	value: Accessor<number>;
	min: number;
	/** The widest it may go now; it follows the window. */
	max: () => number;
	initial: number;
	set: (px: number) => void;
	reset: () => void;
}

export function clamp(px: number, min: number, max: number): number {
	return Math.round(Math.min(Math.max(px, min), Math.max(min, max)));
}

function createWidth(
	key: string,
	cssVar: string,
	initial: number,
	min: number,
	max: () => number,
): Width {
	const load = () => {
		try {
			const n = Number(localStorage.getItem(key));
			return Number.isFinite(n) && n > 0 ? n : initial;
		} catch {
			return initial;
		}
	};
	const [value, setValue] = createSignal(clamp(load(), min, max()));
	const apply = (px: number) =>
		globalThis.document?.documentElement.style.setProperty(cssVar, `${px}px`);
	apply(value());

	const save = (px: number) => {
		try {
			if (px === initial) localStorage.removeItem(key);
			else localStorage.setItem(key, String(px));
		} catch {
			// Storage can be blocked; the width then lasts for this page only.
		}
	};

	const set = (px: number) => {
		const next = clamp(px, min, max());
		setValue(next);
		apply(next);
		save(next);
	};

	return { value, min, max, initial, set, reset: () => set(initial) };
}

/** The window's width, or no limit where there is no window, as in tests. */
const viewport = () => globalThis.innerWidth ?? Number.POSITIVE_INFINITY;

export const sidebarWidth = createWidth("zetta.sidebar", "--sidebar-width", 264, 180, () =>
	Math.min(560, viewport() * 0.5),
);

export const inspectorWidth = createWidth("zetta.inspector", "--inspector-width", 380, 260, () =>
	Math.min(960, viewport() * 0.7),
);
