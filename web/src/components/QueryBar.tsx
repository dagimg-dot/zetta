import { For, Show } from "solid-js";
import { compileBuilder } from "../api";
import {
	type Builder,
	type Category,
	categoryOf,
	encodeBuilder,
	type Filter,
	type Op,
	opInfo,
	opsFor,
	type SortKey,
} from "../query";
import { createRequest } from "../request";
import { Choice } from "./Choice";
import { type ColumnChoice, ColumnPicker } from "./ColumnPicker";
import { Icon } from "./icons";
import { Kbd } from "./Kbd";
import { tip } from "./Tip";

const placeholders: Record<Category, string> = {
	number: "number",
	time: "2024-01-31",
	text: "text",
	bool: "",
	json: "text",
	other: "value",
};

export function QueryBar(props: {
	columns: ColumnChoice[];
	draft: Builder;
	setDraft: (b: Builder) => void;
	dirty: boolean;
	onApply: () => void;
	onRevert: () => void;
	onClear: () => void;
	/** Removing a filter or sort reloads the rows at once, as Clear does; it needs no Apply. */
	onRemoveFilter: (i: number) => void;
	onRemoveSort: (i: number) => void;
	onEditSql: () => void;
}) {
	const typeOf = (name: string) => props.columns.find((c) => c.name === name)?.type ?? "";
	const empty = () => !props.draft.filters.length && !props.draft.sorts.length;

	const update = (patch: Partial<Builder>) => props.setDraft({ ...props.draft, ...patch });
	const setFilter = (i: number, patch: Partial<Filter>) =>
		update({ filters: props.draft.filters.map((f, k) => (k === i ? { ...f, ...patch } : f)) });
	const setSort = (i: number, patch: Partial<SortKey>) =>
		update({ sorts: props.draft.sorts.map((s, k) => (k === i ? { ...s, ...patch } : s)) });

	const addFilter = () => {
		const col = props.columns[0];
		if (!col) return;
		const op = opsFor(categoryOf(col.type))[0]?.op ?? "eq";
		update({ filters: [...props.draft.filters, { c: col.name, op, v: "" }] });
		focusLast(".q-filters .q-value, .q-filters .picker-input");
	};
	const addSort = () => {
		const used = new Set(props.draft.sorts.map((s) => s.c));
		const col = props.columns.find((c) => !used.has(c.name)) ?? props.columns[0];
		if (!col) return;
		update({ sorts: [...props.draft.sorts, { c: col.name, d: "asc" }] });
		focusLast(".q-sorts .picker-input");
	};
	const moveSort = (i: number, by: -1 | 1) => {
		const s = [...props.draft.sorts];
		const j = i + by;
		const a = s[i];
		const b = s[j];
		if (!a || !b) return;
		s[i] = b;
		s[j] = a;
		update({ sorts: s });
	};

	/** A new column picks the first operator that suits its type, unless the current one still does. */
	const changeColumn = (i: number, name: string) => {
		const f = props.draft.filters[i];
		if (!f) return;
		const allowed = opsFor(categoryOf(typeOf(name)));
		const op: Op = allowed.some((o) => o.op === f.op) ? f.op : (allowed[0]?.op ?? "eq");
		setFilter(i, { c: name, op, v: opInfo(op).value ? f.v : "" });
	};

	const onKey = (e: KeyboardEvent) => {
		// An open column list owns Enter and Escape: they pick or close it, not the whole builder.
		if (e.defaultPrevented || (e.target as HTMLElement).getAttribute("aria-expanded") === "true")
			return;
		if (e.key === "Enter") {
			e.preventDefault();
			props.onApply();
		} else if (e.key === "Escape") {
			props.onRevert();
		}
	};

	/** The server compiles the builder, so the preview is exactly the SQL that runs, values included. */
	const preview = createRequest(compileBuilder, () => encodeBuilder(props.draft) || null);
	const sql = () => {
		const q = encodeBuilder(props.draft);
		const c = preview.data();
		if (!q || !c || preview.dataKey() !== q) return "";
		return [c.where && `WHERE ${c.where}`, c.order && `ORDER BY ${c.order}`]
			.filter(Boolean)
			.join("  ");
	};

	return (
		<fieldset
			class="query"
			aria-label="Filter and sort rows"
			classList={{ compact: empty() }}
			onKeyDown={onKey}
		>
			<Show
				when={!empty()}
				fallback={
					<div class="q-compact">
						<button
							type="button"
							class="btn quiet"
							onClick={addFilter}
							disabled={!props.columns.length}
						>
							<Icon name="filter" />
							Filter
						</button>
						<button
							type="button"
							class="btn quiet"
							onClick={addSort}
							disabled={!props.columns.length}
						>
							<Icon name="sort" />
							Sort
						</button>
						<span class="spacer" />
						<button type="button" class="btn quiet" onClick={() => props.onEditSql()}>
							<Icon name="code" />
							Edit as SQL
						</button>
					</div>
				}
			>
				<div class="q-grid">
					<section class="q-filters" aria-label="Filters">
						<header class="q-head">
							<span class="q-title">Filter</span>
							<Show
								when={props.draft.filters.length > 1}
								fallback={<span class="q-note">rows where</span>}
							>
								<span class="q-note">rows matching</span>
								<Choice
									class="q-match"
									label="Combine filters with"
									options={[
										{ value: "all", label: "all" },
										{ value: "any", label: "any" },
									]}
									value={props.draft.match}
									onChange={(match) => update({ match })}
								/>
								<span class="q-note">of</span>
							</Show>
						</header>
						<Show when={props.draft.filters.length} fallback={<p class="q-empty">Every row.</p>}>
							<ol class="q-rows">
								<For each={props.draft.filters}>
									{(f, i) => {
										const cat = () => categoryOf(typeOf(f.c));
										return (
											<li class="q-row">
												<ColumnPicker
													class="q-col"
													label="Column"
													columns={props.columns}
													value={f.c}
													onChange={(name) => changeColumn(i(), name)}
												/>
												<Choice
													class="q-op"
													label="Condition"
													options={opsFor(cat()).map((o) => ({ value: o.op, label: o.label }))}
													value={f.op}
													onChange={(op) => setFilter(i(), { op })}
												/>
												<Show
													when={opInfo(f.op).value}
													fallback={<span class="q-value q-novalue" />}
												>
													<input
														type="text"
														class="q-value mono"
														aria-label={`Value for ${f.c}`}
														placeholder={f.op === "in" ? "a, b, c" : placeholders[cat()]}
														value={f.v}
														autocomplete="off"
														spellcheck={false}
														onInput={(e) => setFilter(i(), { v: e.currentTarget.value })}
													/>
												</Show>
												<button
													type="button"
													class="ico"
													aria-label={`Remove the filter on ${f.c}`}
													onClick={() => props.onRemoveFilter(i())}
												>
													<Icon name="close" />
												</button>
											</li>
										);
									}}
								</For>
							</ol>
						</Show>
						<button type="button" class="btn quiet q-add" onClick={addFilter}>
							<Icon name="plus" />
							Add filter
						</button>
					</section>

					<section class="q-sorts" aria-label="Sort">
						<header class="q-head">
							<span class="q-title">Sort</span>
							<Show when={props.draft.sorts.length > 1}>
								<span class="q-note">first key wins</span>
							</Show>
						</header>
						<Show when={props.draft.sorts.length} fallback={<p class="q-empty">Database order.</p>}>
							<ol class="q-rows">
								<For each={props.draft.sorts}>
									{(s, i) => (
										<li class="q-row">
											<ColumnPicker
												class="q-col"
												label="Sort column"
												columns={props.columns}
												value={s.c}
												onChange={(name) => setSort(i(), { c: name })}
											/>
											<button
												type="button"
												class="btn q-dir"
												aria-label={`Direction: ${s.d === "asc" ? "ascending" : "descending"}`}
												onClick={() => setSort(i(), { d: s.d === "asc" ? "desc" : "asc" })}
											>
												<Icon name={s.d} />
												{s.d === "asc" ? "Ascending" : "Descending"}
											</button>
											<Show when={props.draft.sorts.length > 1}>
												<button
													type="button"
													class="ico"
													aria-label={`Move ${s.c} up`}
													disabled={i() === 0}
													onClick={() => moveSort(i(), -1)}
												>
													<Icon name="up" />
												</button>
											</Show>
											<button
												type="button"
												class="ico"
												aria-label={`Remove the sort on ${s.c}`}
												onClick={() => props.onRemoveSort(i())}
											>
												<Icon name="close" />
											</button>
										</li>
									)}
								</For>
							</ol>
						</Show>
						<button type="button" class="btn quiet q-add" onClick={addSort}>
							<Icon name="plus" />
							Add sort
						</button>
					</section>
				</div>

				<footer class="q-foot">
					<code class="q-sql" {...tip(sql())}>
						{sql() || "No conditions yet"}
					</code>
					<button type="button" class="btn quiet" onClick={() => props.onEditSql()}>
						<Icon name="code" />
						Edit as SQL
					</button>
					<button type="button" class="btn quiet" onClick={() => props.onClear()}>
						Clear
					</button>
					<button
						type="button"
						class="btn"
						classList={{ primary: props.dirty }}
						disabled={!props.dirty}
						onClick={() => props.onApply()}
					>
						Apply
						<Kbd keys="Enter" />
					</button>
				</footer>
			</Show>
		</fieldset>
	);
}

function focusLast(selector: string) {
	queueMicrotask(() => {
		const all = document.querySelectorAll<HTMLElement>(selector);
		all[all.length - 1]?.focus();
	});
}
