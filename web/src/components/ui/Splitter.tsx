import { createSignal } from "solid-js";
import type { Width } from "../../stores/layout";
import { tip } from "./Tip";

/** Arrow keys move this far; Shift moves four times as far. */
const STEP = 16;

/**
 * A drag handle on a panel's edge. `edge` says which edge it sits on, so dragging away from the
 * panel widens it. Arrow keys resize it, Home and End jump to the limits, and a double click or
 * Enter puts it back to its first width.
 */
export function Splitter(props: { width: Width; edge: "left" | "right"; label: string }) {
	const [dragging, setDragging] = createSignal(false);
	const grow = () => (props.edge === "right" ? 1 : -1);

	const onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const start = props.width.value();
		setDragging(true);
		document.body.classList.add("resizing");
		const move = (m: PointerEvent) => props.width.set(start + (m.clientX - startX) * grow());
		const end = () => {
			setDragging(false);
			document.body.classList.remove("resizing");
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", end);
			el.removeEventListener("pointercancel", end);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", end);
		el.addEventListener("pointercancel", end);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		const w = props.width;
		const step = e.shiftKey ? STEP * 4 : STEP;
		if (e.key === "ArrowRight") w.set(w.value() + step * grow());
		else if (e.key === "ArrowLeft") w.set(w.value() - step * grow());
		else if (e.key === "Home") w.set(w.min);
		else if (e.key === "End") w.set(w.max());
		else if (e.key === "Enter") w.reset();
		else return;
		e.preventDefault();
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or be dragged; a focusable separator is the ARIA window splitter pattern.
		<div
			class="splitter"
			classList={{ [props.edge]: true, dragging: dragging() }}
			role="separator"
			aria-orientation="vertical"
			aria-label={props.label}
			aria-valuenow={props.width.value()}
			aria-valuemin={props.width.min}
			aria-valuemax={Math.round(props.width.max())}
			tabIndex={0}
			{...tip(`${props.label}. Double-click to reset`, undefined, props.edge)}
			onPointerDown={onPointerDown}
			onDblClick={() => props.width.reset()}
			onKeyDown={onKeyDown}
		/>
	);
}
