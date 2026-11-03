import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { type BrowseParams, browse } from "../../lib/api";
import { createRequest } from "../../lib/request";
import { ErrorBox } from "../ui/ErrorBox";
import { Icon, Loader } from "../ui/icons";
import { tip } from "../ui/Tip";
import { matchColumns } from "./hidden";
import { ValueLine } from "./Marked";
import { clip, type PeekTarget, peekParams } from "./referenced";

/** Waits this long after the cursor settles, so holding an arrow key does not fetch every cell. */
const DELAY_MS = 150;

/** Past this many columns the referenced row gets a filter, like "Rows pointing here". */
const FILTER_COLUMNS_AT = 8;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The row a foreign key points to, shown in the inspector so "who is this" needs no page change.
 * A key with no matching row says so, which is a finding in itself on a database without
 * enforced keys.
 */
export function Peek(props: { target: PeekTarget; label: string }) {
	const want = createMemo(() => peekParams(props.target), undefined, { equals: same });
	const [key, setKey] = createSignal<BrowseParams | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(timer));
	createEffect(
		on(want, (p) => {
			clearTimeout(timer);
			timer = setTimeout(() => setKey(p), DELAY_MS);
		}),
	);
	const row = createRequest((p: BrowseParams, signal) => browse(p, signal), key);
	/** Only an answer for the key on show counts; anything else is still on its way. */
	const settled = () => same(key(), want()) && !row.loading();
	const result = () => (settled() && same(row.dataKey(), want()) ? row.data() : undefined);

	const [query, setQuery] = createSignal("");
	createEffect(
		on(
			() => props.target.table,
			() => setQuery(""),
			{ defer: true },
		),
	);
	const fields = createMemo(() => {
		const r = result();
		const values = r?.rows[0];
		if (!r || !values) return [];
		const all = r.columns.map((c, i) => ({ ...c, value: values[i] ?? null }));
		return matchColumns(all, query());
	});

	const where = () => `${props.target.column} = ${props.target.value}`;

	return (
		<section class="peek" aria-label={`Referenced row in ${props.label}`}>
			<div class="peek-head">
				<span>Points to</span>
				<span class="mono table">{props.label}</span>
				<span class="mono where" {...tip(clip(where()), undefined, "bottom")}>
					{clip(where())}
				</span>
				<Show when={result()?.rows.length && (result()?.columns.length ?? 0) > FILTER_COLUMNS_AT}>
					<span class="refs-find">
						<Icon name="search" size={12} />
						<input
							type="search"
							aria-label={`Find columns of the row in ${props.label}`}
							placeholder="Find columns"
							autocomplete="off"
							spellcheck={false}
							value={query()}
							onInput={(e) => setQuery(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape" && query()) {
									e.preventDefault();
									setQuery("");
								}
							}}
						/>
					</span>
				</Show>
			</div>
			<Switch>
				<Match when={!settled()}>
					<div class="peek-note">
						<Loader size={12} />
						<span>Loading the row</span>
					</div>
				</Match>
				<Match when={row.error()}>{(err) => <ErrorBox error={err()} inline />}</Match>
				<Match when={result() && !result()?.rows.length}>
					<div class="peek-note">
						No row in <span class="mono">{props.label}</span> has{" "}
						<span class="mono">{clip(where())}</span>
					</div>
				</Match>
				<Match when={result()}>
					{(r) => (
						<>
							<Show when={r().rows.length > 1}>
								<div class="peek-note warn">More than one row matches; this is the first.</div>
							</Show>
							<dl class="peek-row" tabIndex={0}>
								<For each={fields()} fallback={<div class="refs-empty">No matching columns</div>}>
									{(f) => (
										<div class="peek-field">
											<dt>
												<span class="mono">{f.name}</span>
												<span class="type">{f.type}</span>
											</dt>
											<dd
												class="mono"
												{...tip(
													f.value && f.value.length > 40 ? clip(f.value) : undefined,
													undefined,
													"left",
												)}
											>
												<ValueLine value={f.value} type={f.type} />
											</dd>
										</div>
									)}
								</For>
							</dl>
						</>
					)}
				</Match>
			</Switch>
		</section>
	);
}
