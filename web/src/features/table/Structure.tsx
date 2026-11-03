import { createMemo, For, Show } from "solid-js";
import { Icon } from "../../components/ui/icons";
import { SqlText } from "../../components/ui/SqlText";
import { tip } from "../../components/ui/Tip";
import type { Constraint, TableDetail } from "../../lib/api";
import { openTable } from "../../stores/view";
import { None, Section } from "./parts";

export function StructurePane(props: { detail: TableDetail }) {
	const keys = createMemo(() => {
		const d = props.detail;
		const fk = new Map<string, { schema: string; table: string; column: string }>();
		for (const k of d.foreignKeys) {
			k.columns.forEach((c, i) => {
				fk.set(c, { schema: k.refSchema, table: k.refTable, column: k.refColumns[i] ?? "" });
			});
		}
		const unique = new Set<string>();
		for (const c of d.constraints)
			if (c.kind === "unique" && c.columns.length === 1 && c.columns[0]) unique.add(c.columns[0]);
		for (const ix of d.indexes)
			if (ix.unique && !ix.primary && ix.columns.length === 1 && ix.columns[0])
				unique.add(ix.columns[0]);
		const indexed = new Set<string>();
		for (const ix of d.indexes) if (ix.columns[0]) indexed.add(ix.columns[0]);
		return { fk, unique, indexed };
	});

	const others = () =>
		props.detail.constraints.filter((c) => c.kind !== "primary_key" && c.kind !== "foreign_key");

	return (
		<div class="sheet">
			<Section title="Columns" note={`${props.detail.columns.length}`}>
				<div class="info-scroll">
					<table class="info-table">
						<thead>
							<tr>
								<th class="n">#</th>
								<th>Name</th>
								<th>Type</th>
								<th>Null</th>
								<th>Default</th>
								<th>Keys</th>
								<Show when={props.detail.columns.some((c) => c.comment)}>
									<th>Comment</th>
								</Show>
							</tr>
						</thead>
						<tbody>
							<For each={props.detail.columns}>
								{(c, i) => {
									const fk = () => keys().fk.get(c.name);
									return (
										<tr>
											<td class="n">{i() + 1}</td>
											<td class="mono strong">{c.name}</td>
											<td class="mono type">{c.type}</td>
											<td>
												<Show when={c.nullable && !c.primaryKey} fallback={<span>not null</span>}>
													<span class="muted">null</span>
												</Show>
											</td>
											<td
												class="mono def"
												{...tip(
													(c.default?.length ?? 0) > 36 ? (c.default ?? undefined) : undefined,
												)}
											>
												<Show when={c.default !== null} fallback={<span class="muted">none</span>}>
													{c.default}
												</Show>
											</td>
											<td>
												<div class="key-row">
													<Show when={c.primaryKey}>
														<span class="key pk" {...tip("Primary key")}>
															<Icon name="key" />
															PK
														</span>
													</Show>
													<Show when={fk()}>
														{(t) => (
															<button
																type="button"
																class="key fk"
																{...tip(
																	`References ${t().schema}.${t().table}(${t().column}). Open it.`,
																)}
																onClick={() => openTable(t().schema, t().table)}
															>
																<Icon name="go" />
																<span class="mono">
																	{t().table}.{t().column}
																</span>
															</button>
														)}
													</Show>
													<Show when={!c.primaryKey && keys().unique.has(c.name)}>
														<span class="key" {...tip("No two rows share this value")}>
															unique
														</span>
													</Show>
													<Show
														when={
															!c.primaryKey &&
															!keys().unique.has(c.name) &&
															keys().indexed.has(c.name)
														}
													>
														<span class="key quiet" {...tip("Leads an index")}>
															indexed
														</span>
													</Show>
												</div>
											</td>
											<Show when={props.detail.columns.some((x) => x.comment)}>
												<td class="comment">{c.comment}</td>
											</Show>
										</tr>
									);
								}}
							</For>
						</tbody>
					</table>
				</div>
			</Section>

			<Section title="Constraints" note={others().length ? `${others().length}` : undefined}>
				<Show
					when={others().length}
					fallback={<None>No unique, check or exclusion constraints beyond the keys above.</None>}
				>
					<ul class="info-list">
						<For each={others()}>{(c) => <ConstraintRow c={c} />}</For>
					</ul>
				</Show>
			</Section>
		</div>
	);
}

const constraintLabel: Record<Constraint["kind"], string> = {
	primary_key: "primary key",
	foreign_key: "foreign key",
	unique: "unique",
	check: "check",
	exclusion: "exclusion",
};

function ConstraintRow(props: { c: Constraint }) {
	return (
		<li>
			<div class="line">
				<span class="kind">{constraintLabel[props.c.kind]}</span>
				<span class="mono strong">{props.c.name}</span>
				<Show when={props.c.columns.length}>
					<span class="cols">
						<For each={props.c.columns}>{(col) => <span class="chip mono">{col}</span>}</For>
					</span>
				</Show>
			</div>
			<code class="def-line">
				<SqlText text={props.c.definition} />
			</code>
		</li>
	);
}
