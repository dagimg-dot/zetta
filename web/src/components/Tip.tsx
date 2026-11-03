import { Tooltip as Ark, useTooltip } from "@ark-ui/solid/tooltip";
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Kbd } from "./Kbd";

export type TipSide = "top" | "right" | "bottom" | "left";

/** Hover time before a tooltip opens. Focus, and moving on from an open tooltip, skip it. */
const OPEN_DELAY = 450;
/** How long after a tooltip closes the next one still opens at once. */
const WARM = 300;

/**
 * The attributes that give an element its tooltip, in place of `title`: a label, and a shortcut
 * drawn as key caps when it has one. Plain DOM can set the same `data-tip` attributes directly.
 */
export function tip(label: string | undefined, kbd?: string, side?: TipSide) {
	return {
		"data-tip": label || undefined,
		"data-tip-kbd": kbd,
		"data-tip-side": side,
	};
}

interface Shown {
	el: HTMLElement;
	label: string;
	kbd: string | undefined;
	side: TipSide;
}

function read(el: HTMLElement): Shown | null {
	const label = el.dataset.tip;
	if (!label) return null;
	return {
		el,
		label,
		kbd: el.dataset.tipKbd || undefined,
		side: (el.dataset.tipSide as TipSide | undefined) ?? "top",
	};
}

/**
 * The one tooltip of the app. It watches the document for elements marked by `tip()` and shows a
 * single shared tooltip over whichever is hovered or keyboard focused, so a sidebar of hundreds of
 * tables or a grid of plain DOM cells pays nothing per element. Ark draws and places it.
 */
export function TipLayer() {
	const [shown, setShown] = createSignal<Shown | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closedAt = 0;
	let watch: ReturnType<typeof setInterval> | undefined;

	const close = () => {
		clearTimeout(timer);
		clearInterval(watch);
		if (shown()) closedAt = performance.now();
		setShown(null);
	};

	const open = (next: Shown) => {
		clearTimeout(timer);
		setShown(next);
		// A trigger can be removed under the pointer, by a rerender or a click that navigates.
		clearInterval(watch);
		watch = setInterval(() => {
			if (!next.el.isConnected) close();
		}, 250);
	};

	const target = (e: Event) =>
		(e.target as Element | null)?.closest?.<HTMLElement>("[data-tip]") ?? null;

	const onOver = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		const el = target(e);
		if (!el || el === shown()?.el) return;
		const next = read(el);
		if (!next) return;
		clearTimeout(timer);
		if (shown() || performance.now() - closedAt < WARM) open(next);
		else timer = setTimeout(() => open(next), OPEN_DELAY);
	};

	const onOut = (e: PointerEvent) => {
		const el = target(e);
		if (!el) return;
		const to = e.relatedTarget as Node | null;
		if (to && el.contains(to)) return;
		if (shown()?.el === el) close();
		else clearTimeout(timer);
	};

	const onFocusIn = (e: FocusEvent) => {
		const el = target(e);
		if (!el || el !== e.target || !el.matches(":focus-visible")) return;
		const next = read(el);
		if (next) open(next);
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" && shown()) close();
	};

	onMount(() => {
		const opts = { capture: true, passive: true };
		document.addEventListener("pointerover", onOver, opts);
		document.addEventListener("pointerout", onOut, opts);
		document.addEventListener("pointerdown", close, opts);
		document.addEventListener("focusin", onFocusIn, opts);
		document.addEventListener("focusout", close, opts);
		document.addEventListener("keydown", onKey, opts);
		document.addEventListener("scroll", close, opts);
		document.addEventListener("wheel", close, opts);
		onCleanup(() => {
			document.removeEventListener("pointerover", onOver, opts);
			document.removeEventListener("pointerout", onOut, opts);
			document.removeEventListener("pointerdown", close, opts);
			document.removeEventListener("focusin", onFocusIn, opts);
			document.removeEventListener("focusout", close, opts);
			document.removeEventListener("keydown", onKey, opts);
			document.removeEventListener("scroll", close, opts);
			document.removeEventListener("wheel", close, opts);
			close();
		});
	});

	const api = useTooltip(() => ({
		open: shown() !== null,
		positioning: {
			placement: shown()?.side ?? "top",
			gutter: 8,
			overflowPadding: 8,
			getAnchorElement: () => shown()?.el ?? null,
		},
	}));

	// Moving straight from one tooltip to the next keeps it open, so it is placed again by hand.
	createEffect(
		on(shown, (s) => {
			if (s) api().reposition({ placement: s.side });
		}),
	);

	/** A modal dialog sits in the top layer, above any z-index, so a tip for its controls goes inside it. */
	const host = () => shown()?.el.closest<HTMLElement>("dialog[open]") ?? document.body;

	return (
		<Ark.RootProvider value={api} lazyMount>
			<Show when={host()} keyed>
				{(mount) => (
					<Portal mount={mount}>
						<Ark.Positioner>
							<Ark.Content class="tip">
								<Ark.Arrow class="tip-arrow">
									<Ark.ArrowTip />
								</Ark.Arrow>
								<Show when={shown()}>
									{(s) => (
										<>
											<span class="tip-label">{s().label}</span>
											<Show when={s().kbd}>{(k) => <Kbd keys={k()} />}</Show>
										</>
									)}
								</Show>
							</Ark.Content>
						</Ark.Positioner>
					</Portal>
				)}
			</Show>
		</Ark.RootProvider>
	);
}
