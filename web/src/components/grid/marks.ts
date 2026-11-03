/** Past this many characters a run of whitespace is kept as it is but no longer marked. */
const MARK_AT_MOST = 64;

/**
 * Spaces and tabs as typed, each with a · or → drawn over it, so they can be seen and a copy or a
 * text selection still gets the real characters. Built as DOM nodes so the grid can use it too.
 */
export function whitespace(run: string): HTMLSpanElement {
	const out = document.createElement("span");
	out.className = "ws";
	const chars = [...run];
	for (const ch of chars.slice(0, MARK_AT_MOST)) {
		const c = document.createElement("span");
		c.className = ch === "\t" ? "tab" : "sp";
		c.textContent = ch;
		out.append(c);
	}
	if (chars.length > MARK_AT_MOST) out.append(chars.slice(MARK_AT_MOST).join(""));
	return out;
}
