import {
	batch,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	on,
	onCleanup,
	Show,
	splitProps,
} from "solid-js";
import { SqlLine } from "../../components/ui/SqlText";
import { complete, enterAccepts, type Ranked, rank } from "../../lib/sql-complete";
import { escapeHtml, highlightLines } from "../../lib/sql-highlight";
import { catalogView, loadColumns } from "../../stores/catalog";
import { dialect } from "../../stores/dialect";
import { Completions, type Placement } from "./Completions";
import "./sql-editor.css";

/** How long typing must pause before a list opens by itself, as CodeMirror waits. */
const openDelay = 100;
/** Rows Page Up and Page Down move by. */
const page = 8;

/** Calls a Solid event handler prop, which may be a function or a [function, data] pair. */
function call<E extends Event>(handler: unknown, e: E): void {
	if (typeof handler === "function") handler(e);
	else if (Array.isArray(handler) && typeof handler[0] === "function") handler[0](handler[1], e);
}

/** Past this many characters, about 2,000 lines, the layer shows plain text, so colouring never slows typing. */
const maxHighlight = 100_000;

type TextareaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement>;

export interface SqlEditorProps extends Omit<TextareaProps, "value" | "ref"> {
	value: string;
	/** The [start, end) of the statement Run would send, shaded line by line. */
	current?: readonly [number, number] | null;
	/** The [start, end) the last error points at. */
	error?: readonly [number, number] | null;
	ref?: (el: HTMLTextAreaElement) => void;
}

/** Where each line of `text` starts. */
function lineStarts(text: string): number[] {
	const out = [0];
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
	return out;
}

/** The line that holds offset `at`, by binary search over `starts`. */
function lineAt(starts: readonly number[], at: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((starts[mid] ?? 0) <= at) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * A textarea over a coloured copy of its own text. Typing, selection, undo, IME and screen readers
 * stay the browser's own; the textarea's letters are transparent, and the layer beneath draws the
 * same letters in colour, wrapped and scrolled the same way.
 */
export function SqlEditor(props: SqlEditorProps) {
	const [own, rest] = splitProps(props, [
		"value",
		"current",
		"error",
		"ref",
		"class",
		"onScroll",
		"onInput",
		"onKeyDown",
		"onBlur",
		"onMouseDown",
	]);
	let layer: HTMLDivElement | undefined;
	let input: HTMLTextAreaElement | undefined;

	const lines = createMemo(() =>
		own.value.length > maxHighlight
			? own.value.split("\n").map(escapeHtml)
			: highlightLines(own.value, dialect(), { error: own.error }),
	);
	const starts = createMemo(() => lineStarts(own.value));
	/** The first and last line of the current statement, or -1 to -1 for none. */
	const first = createMemo(() => (own.current ? lineAt(starts(), own.current[0]) : -1));
	const last = createMemo(() => (own.current ? lineAt(starts(), own.current[1]) : -1));
	const isShaded = (i: number) => i >= first() && i <= last() && first() >= 0;

	// Completion: a request opens the list, and what it shows follows the text and the caret.
	const listId = createUniqueId();
	const [caret, setCaret] = createSignal(0);
	const [request, setRequest] = createSignal<{ explicit: boolean } | null>(null);
	const [selected, setSelected] = createSignal(0);
	const [placement, setPlacement] = createSignal<Placement>({ left: 0, top: 0 });
	let timer: ReturnType<typeof setTimeout> | undefined;
	let accepting = false;
	/** A row was chosen with the keys, which is what lets Enter take a guess. */
	let moved = false;
	onCleanup(() => clearTimeout(timer));

	const result = createMemo(() => {
		const r = request();
		if (!r) return null;
		const c = complete(own.value, caret(), dialect(), catalogView(), r.explicit);
		if (!c) return null;
		for (const m of c.missing) loadColumns(m.schema, m.table);
		return { ...c, items: rank(c.candidates, c.typed) };
	});
	/** The list shows while it has rows, while columns load, or after Ctrl+Space even when empty. */
	const shown = createMemo(() => {
		const r = result();
		return r && (r.items.length > 0 || r.missing.length > 0 || request()?.explicit) ? r : null;
	});

	const close = () => {
		clearTimeout(timer);
		setRequest(null);
	};
	const open = (explicit: boolean) => {
		clearTimeout(timer);
		moved = false;
		batch(() => {
			setSelected(0);
			setRequest({ explicit });
		});
	};
	/** Opens by itself once typing pauses, as long as focus stays here. */
	const soon = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (input && document.activeElement === input && input.selectionStart === input.selectionEnd)
				open(false);
		}, openDelay);
	};

	// An auto-opened list closes once nothing completes here; a requested one stays to say so.
	createEffect(() => {
		if (request() && !shown()) close();
	});
	// A new word starts the choice over at the top; columns arriving do not.
	createEffect(
		on(
			() => result()?.typed,
			() => {
				moved = false;
				setSelected(0);
			},
			{ defer: true },
		),
	);
	createEffect(() => {
		const r = shown();
		if (r) setPlacement(place(r.from));
	});

	/** The viewport box of the letter at `index`, read off the layer, which lays it out like the textarea. */
	const letterBox = (index: number): DOMRect | null => {
		if (!layer) return null;
		const line = lineAt(starts(), index);
		const el = layer.children[line] as HTMLElement | undefined;
		if (!el) return null;
		let offset = index - (starts()[line] ?? 0);
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const len = node.textContent?.length ?? 0;
			if (offset <= len) {
				const range = document.createRange();
				range.setStart(node, offset);
				range.collapse(true);
				return range.getClientRects()[0] ?? range.getBoundingClientRect();
			}
			offset -= len;
		}
		const box = el.getBoundingClientRect();
		const pad = Number.parseFloat(getComputedStyle(el).paddingLeft) || 0;
		return new DOMRect(box.left + pad, box.top, 0, box.height);
	};
	/** Under the word being completed, or above it when the viewport has more room there. */
	const place = (index: number): Placement => {
		const box = letterBox(index);
		if (!box) return { left: 0, top: 0 };
		const left = Math.max(8, Math.min(box.left - 6, window.innerWidth - 228));
		const below = window.innerHeight - box.bottom;
		return below < 260 && box.top > below
			? { left, bottom: window.innerHeight - box.top + 2 }
			: { left, top: box.bottom + 2 };
	};

	const accept = (item: Ranked | undefined) => {
		const r = shown();
		if (!item || !r || !input) return;
		close();
		input.focus();
		input.setSelectionRange(r.from, r.to);
		// insertText keeps the browser's undo stack, so one Ctrl+Z takes the whole completion back.
		accepting = true;
		const done = document.execCommand("insertText", false, item.insert);
		accepting = false;
		if (!done) {
			input.setRangeText(item.insert, r.from, r.to, "end");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
	};

	const onInput: JSX.EventHandler<HTMLTextAreaElement, InputEvent> = (e) => {
		const el = e.currentTarget;
		batch(() => {
			call(own.onInput, e);
			setCaret(el.selectionStart);
		});
		if (accepting || e.isComposing) return;
		if (el.selectionStart !== el.selectionEnd) return close();
		// Paste, drop, undo and redo put text in without anyone writing it.
		if (/^(insertFrom|history)/.test(e.inputType)) return close();
		if (request()) return;
		const ch = el.value[el.selectionStart - 1] ?? "";
		if (e.inputType === "insertText" && /[\p{L}\p{N}_$." \x60[ ]/u.test(ch)) soon();
	};

	const onKeyDown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (e) => {
		if (e.isComposing || e.keyCode === 229) return call(own.onKeyDown, e);
		const mod = e.ctrlKey || e.metaKey;
		if (mod && (e.key === " " || e.code === "Space")) {
			e.preventDefault();
			setCaret(e.currentTarget.selectionStart);
			open(true);
			return;
		}
		const r = shown();
		if (r) {
			const n = r.items.length;
			const pick = r.items[selected()];
			if (e.key === "Enter" && mod) close();
			else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				return close();
			} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				if (n > 0) {
					e.preventDefault();
					moved = true;
					return setSelected((selected() + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
				}
			} else if (e.key === "PageDown" || e.key === "PageUp") {
				if (n > 0) {
					e.preventDefault();
					const step = e.key === "PageDown" ? page : -page;
					moved = true;
					return setSelected(Math.max(0, Math.min(n - 1, selected() + step)));
				}
			} else if (e.key === "Tab" && !e.shiftKey && !mod && pick) {
				e.preventDefault();
				return accept(pick);
			} else if (e.key === "Enter" && !e.shiftKey && !e.altKey && pick) {
				const current = own.value.slice(r.from, r.to);
				if (enterAccepts(r, pick, current, { moved, explicit: !!request()?.explicit })) {
					e.preventDefault();
					return accept(pick);
				}
				close();
			} else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) close();
		}
		call(own.onKeyDown, e);
	};

	const follow = () => {
		if (!layer || !input) return;
		layer.scrollTop = input.scrollTop;
		layer.scrollLeft = input.scrollLeft;
		const r = shown();
		if (r) setPlacement(place(r.from));
	};

	return (
		<div class="sql-editor">
			<div class="sql-layer mono" ref={layer} aria-hidden="true">
				<For each={lines()}>{(html, i) => <SqlLine html={html} current={isShaded(i())} />}</For>
			</div>
			<textarea
				{...rest}
				ref={(el) => {
					input = el;
					own.ref?.(el);
				}}
				class={own.class ? `sql-input mono ${own.class}` : "sql-input mono"}
				value={own.value}
				aria-autocomplete="list"
				aria-controls={shown() ? listId : undefined}
				aria-activedescendant={shown()?.items.length ? `${listId}-${selected()}` : undefined}
				onInput={onInput}
				onKeyDown={onKeyDown}
				onCompositionEnd={() => soon()}
				onMouseDown={(e) => {
					close();
					call(own.onMouseDown, e);
				}}
				onBlur={(e) => {
					close();
					call(own.onBlur, e);
				}}
				onScroll={(e) => {
					follow();
					call(own.onScroll, e);
				}}
			/>
			<Show when={shown()}>
				{(r) => (
					<Completions
						id={listId}
						items={r().items}
						selected={selected()}
						loading={r().missing.length > 0}
						at={placement()}
						onPick={(i) => accept(r().items[i])}
						onHover={setSelected}
					/>
				)}
			</Show>
		</div>
	);
}
