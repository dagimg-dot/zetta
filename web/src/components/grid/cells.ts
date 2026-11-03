import { edges, markOf } from "../../lib/value";
import { whitespace } from "./values";

/** Body cells are built directly so large results do not create a reactive scope per cell. */
export function cell(
	v: string | null,
	type: string,
	numeric: boolean,
	link: boolean,
): HTMLTableCellElement {
	const td = document.createElement("td");
	const mark = markOf(v, type);
	if (v === null) {
		td.className = "null";
		td.textContent = mark;
		return td;
	}
	if (mark !== null) {
		const span = document.createElement("span");
		span.className = "mark";
		span.textContent = mark;
		td.append(span);
		return td;
	}
	if (numeric) td.className = "num";
	const { lead, body, trail } = edges(v);
	if (!lead && !trail && !v.includes("\n")) {
		td.textContent = v;
	} else {
		if (lead) td.append(whitespace(lead));
		body.split("\n").forEach((line, i) => {
			if (i > 0) {
				const nl = document.createElement("span");
				nl.className = "nl";
				nl.textContent = "↵";
				td.append(nl);
			}
			td.append(line);
		});
		if (trail) td.append(whitespace(trail));
	}
	if (v.length > 40) td.dataset.tip = v.length > 400 ? `${v.slice(0, 400)}…` : v;
	if (link) {
		// Clicks are handled by the table; the keyboard uses O on the cursor cell.
		const go = document.createElement("span");
		go.className = "fk-go";
		go.dataset.tip = "Open the referenced row";
		go.dataset.tipKbd = "O";
		go.textContent = "↗";
		td.append(go);
	}
	return td;
}
