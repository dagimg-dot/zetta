import { createEffect, createSignal } from "solid-js";
import { pageSizes } from "../url";
import { Choice } from "./Choice";
import { IconButton } from "./Tip";

/**
 * Page size, first/previous/next/last and a page box you can type into. Without a known total,
 * "next" follows whether the page came back full, and "last" waits for the count.
 */
export function Pager(props: {
	offset: number;
	limit: number;
	/** Rows on the current page. */
	shown: number;
	total: number | null;
	busy: boolean;
	onOffset: (offset: number) => void;
	onLimit: (limit: number) => void;
}) {
	const page = () => Math.floor(props.offset / props.limit) + 1;
	const pages = () =>
		props.total === null ? null : Math.max(1, Math.ceil(props.total / props.limit));
	const hasNext = () => {
		const t = props.total;
		return t === null ? props.shown >= props.limit : props.offset + props.limit < t;
	};

	const [draft, setDraft] = createSignal(String(page()));
	createEffect(() => setDraft(String(page())));

	const go = (p: number) => {
		const last = pages();
		const clamped = Math.max(1, last === null ? p : Math.min(p, last));
		const offset = (clamped - 1) * props.limit;
		setDraft(String(clamped));
		if (offset !== props.offset) props.onOffset(offset);
	};

	const commit = () => {
		const n = Number.parseInt(draft(), 10);
		if (Number.isFinite(n)) go(n);
		else setDraft(String(page()));
	};

	return (
		<div class="pager">
			<Choice
				class="page-size"
				label="Rows per page"
				options={pageSizes.map((n) => ({ value: String(n), label: `${n} rows` }))}
				value={String(props.limit)}
				onChange={(v) => props.onLimit(Number(v))}
			/>
			<fieldset class="pager-group">
				<legend class="sr-only">Pages</legend>
				<IconButton
					class="pg-btn"
					icon="first"
					label="First page"
					placement="top"
					disabled={props.busy || page() === 1}
					onClick={() => go(1)}
				/>
				<IconButton
					class="pg-btn"
					icon="prev"
					label="Previous page"
					kbd="["
					name="prev-page"
					placement="top"
					disabled={props.busy || page() === 1}
					onClick={() => go(page() - 1)}
				/>
				<label class="pg-page">
					<span class="sr-only">Page</span>
					<input
						type="text"
						inputmode="numeric"
						class="pg-input"
						value={draft()}
						size={Math.max(1, draft().length)}
						onInput={(e) => setDraft(e.currentTarget.value.replace(/\D/g, ""))}
						onKeyDown={(e) => {
							if (e.key === "Enter") commit();
							else if (e.key === "Escape") {
								setDraft(String(page()));
								e.currentTarget.blur();
							}
						}}
						onBlur={commit}
						onFocus={(e) => e.currentTarget.select()}
					/>
					<span class="pg-of">of {pages()?.toLocaleString() ?? "…"}</span>
				</label>
				<IconButton
					class="pg-btn"
					icon="next"
					label="Next page"
					kbd="]"
					name="next-page"
					placement="top"
					disabled={props.busy || !hasNext()}
					onClick={() => go(page() + 1)}
				/>
				<IconButton
					class="pg-btn"
					icon="last"
					label="Last page"
					placement="top"
					disabled={props.busy || pages() === null || page() === pages()}
					onClick={() => go(pages() ?? page())}
				/>
			</fieldset>
		</div>
	);
}
