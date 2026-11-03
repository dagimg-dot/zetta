import { createMemo, For, type JSX, Show } from "solid-js";
import type { Constraint, IndexInfo, RefAction, TableDetail, TableKind } from "../api";
import { plural } from "../format";
import { openTable } from "../url";
import { formatBytes } from "../value";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { tip } from "./Tip";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function Section(props: { title: string; note?: JSX.Element; children: JSX.Element }) {
	return (
		<section class="info-section">
			<header>
				<h2>{props.title}</h2>
				<Show when={props.note}>
					<span class="note">{props.note}</span>
				</Show>
			</header>
			{props.children}
		</section>
	);
}

const nouns: Record<TableKind, string> = {
	table: "table",
	view: "view",
	materialized_view: "materialized view",
	foreign_table: "foreign table",
};

/** What to call the relation in a sentence, so a view is not called a table. */
export function kindNoun(kind: TableKind): string {
	return nouns[kind];
}

function None(props: { children: JSX.Element }) {
	return <p class="info-none">{props.children}</p>;
}

/** Both refuse the write while rows still point here, so neither is worth a badge on every key. */
const blocks = (a: RefAction) => a === "NO ACTION" || a === "RESTRICT";

/** Shows only the actions that change other rows: cascade, set null and set default. */
export function RefActions(props: { onDelete: RefAction; onUpdate: RefAction }) {
	const tone = (a: RefAction) => (a === "CASCADE" ? "warn" : "set");
	return (
		<span class="ref-actions">
			<Show when={!blocks(props.onDelete)}>
				<span class={`ref-action ${tone(props.onDelete)}`}>
					on delete {props.onDelete.toLowerCase()}
				</span>
			</Show>
			<Show when={!blocks(props.onUpdate)}>
				<span class={`ref-action ${tone(props.onUpdate)}`}>
					on update {props.onUpdate.toLowerCase()}
				</span>
			</Show>
		</span>
	);
}

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
				<Sql text={props.c.definition} />
			</code>
		</li>
	);
}

export function IndexesPane(props: { detail: TableDetail }) {
	const hasStats = () => props.detail.indexes.some((i) => i.scans !== null || i.sizeBytes !== null);
	const unused = () => props.detail.indexes.filter((i) => i.scans === 0 && !i.primary && !i.unique);

	return (
		<div class="sheet">
			<Section
				title="Indexes"
				note={
					props.detail.indexes.length ? (
						<Show when={props.detail.sizeBytes} fallback={`${props.detail.indexes.length}`}>
							{(s) => (
								<>
									{props.detail.indexes.length} · {formatBytes(s().indexes)} of{" "}
									{formatBytes(s().total)} on disk
								</>
							)}
						</Show>
					) : undefined
				}
			>
				<Show
					when={props.detail.indexes.length}
					fallback={
						<None>
							<Show
								when={props.detail.kind !== "view"}
								fallback="A view has no indexes of its own; filters run on the tables it reads."
							>
								No indexes. Every filter on this {kindNoun(props.detail.kind)} reads all of it
								{props.detail.kind === "table" ? "; a primary key would add one." : "."}
							</Show>
						</None>
					}
				>
					<Show when={unused().length}>
						<p class="info-hint">
							<Icon name="warn" />
							<span>
								{unused().length === 1 ? "One index has" : `${unused().length} indexes have`} not
								been scanned since the statistics were last reset. Unused indexes still cost every
								write.
							</span>
						</p>
					</Show>
					<ul class="info-list">
						<For each={props.detail.indexes}>{(ix) => <IndexRow ix={ix} stats={hasStats()} />}</For>
					</ul>
				</Show>
			</Section>
		</div>
	);
}

function IndexRow(props: { ix: IndexInfo; stats: boolean }) {
	return (
		<li classList={{ unused: props.ix.scans === 0 && !props.ix.primary && !props.ix.unique }}>
			<div class="line">
				<span class="mono strong">{props.ix.name}</span>
				<Show when={props.ix.primary}>
					<span class="key pk">
						<Icon name="key" />
						primary
					</span>
				</Show>
				<Show when={props.ix.unique && !props.ix.primary}>
					<span class="key">unique</span>
				</Show>
				<Show when={props.ix.predicate}>
					<span class="key quiet">partial</span>
				</Show>
				<span class="kind">{props.ix.method}</span>
				<span class="spacer" />
				<Show when={props.stats}>
					<span class="figures">
						<Show when={props.ix.scans !== null}>
							<span {...tip(`${props.ix.scans?.toLocaleString()} scans`)}>
								{props.ix.scans === 0
									? "never scanned"
									: `${compact.format(props.ix.scans ?? 0)} scans`}
							</span>
						</Show>
						<Show when={props.ix.sizeBytes !== null}>
							<span>{formatBytes(props.ix.sizeBytes ?? 0)}</span>
						</Show>
					</span>
				</Show>
			</div>
			<div class="line">
				<span class="cols">
					<For each={props.ix.columns}>{(col) => <span class="chip mono">{col}</span>}</For>
				</span>
				<Show when={props.ix.predicate}>
					<span class="where mono">where {props.ix.predicate}</span>
				</Show>
			</div>
			<Show when={props.ix.definition}>
				{(def) => (
					<code class="def-line">
						<Sql text={def()} />
					</code>
				)}
			</Show>
		</li>
	);
}

export function TriggersPane(props: { detail: TableDetail }) {
	return (
		<div class="sheet">
			<Section
				title="Triggers"
				note={props.detail.triggers.length ? `${props.detail.triggers.length}` : undefined}
			>
				<Show
					when={props.detail.triggers.length}
					fallback={
						<None>
							No triggers. Writes to this {kindNoun(props.detail.kind)} run no hidden code.
						</None>
					}
				>
					<ul class="info-list">
						<For each={props.detail.triggers}>
							{(t) => (
								<li classList={{ disabled: !t.enabled }}>
									<div class="line">
										<Icon name="bolt" class="bolt" />
										<span class="mono strong">{t.name}</span>
										<Show when={!t.enabled}>
											<span class="key quiet">disabled</span>
										</Show>
									</div>
									<p class="sentence">
										Runs <b>{t.timing.toLowerCase()}</b>{" "}
										<For each={t.events}>
											{(e, i) => (
												<>
													{i() > 0 && (i() === t.events.length - 1 ? " or " : ", ")}
													<b>{e.toLowerCase()}</b>
												</>
											)}
										</For>
										, once {t.level === "ROW" ? "for each row" : "per statement"}
										<Show when={t.function}>
											{(f) => (
												<>
													, calling <span class="mono">{f()}</span>
												</>
											)}
										</Show>
										.
									</p>
									<pre class="def-block">
										<Sql text={t.definition} />
									</pre>
								</li>
							)}
						</For>
					</ul>
				</Show>
			</Section>
		</div>
	);
}

export function DdlPane(props: { detail: TableDetail }) {
	return (
		<div class="sheet ddl">
			<div class="ddl-bar">
				<span class="note">
					{plural(props.detail.ddl.split("\n").length, "line")}, from the catalog
				</span>
				<span class="spacer" />
				<CopyButton variant="quiet" text={() => props.detail.ddl} what="the DDL">
					Copy
				</CopyButton>
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a long statement scrolls, and a scrollable region must be reachable by keyboard. */}
			<pre class="def-block ddl-text" tabIndex={0}>
				<Sql text={props.detail.ddl} />
			</pre>
		</div>
	);
}

const KEYWORDS = new Set(
	`add after alter always and as asc before begin by cascade check collate column comment constraint create cycle default deferrable deferred delete desc distinct do each end execute exists false for foreign from function generated grant identity if immediate in include index initially insert instead into is key like match no not null of on or order partial primary procedure references restrict returns row rowid select set statement strict table temp temporary trigger true unique update using values view when where with without`.split(
		" ",
	),
);

const TOKEN =
	/(--[^\n]*)|('(?:[^']|'')*')|("(?:[^"]|"")*")|([A-Za-z_][A-Za-z0-9_$]*)|(\d+(?:\.\d+)?)/g;

/** Light SQL colouring: keywords, strings, quoted names, numbers and comments. Everything else stays plain text. */
export function Sql(props: { text: string }) {
	const parts = createMemo(() => {
		const out: JSX.Element[] = [];
		let at = 0;
		for (const m of props.text.matchAll(TOKEN)) {
			const i = m.index ?? 0;
			if (i > at) out.push(props.text.slice(at, i));
			const [s, comment, str, quoted, word, num] = m;
			if (comment) out.push(<span class="tk-c">{s}</span>);
			else if (str) out.push(<span class="tk-s">{s}</span>);
			else if (quoted) out.push(<span class="tk-q">{s}</span>);
			else if (word && KEYWORDS.has(word.toLowerCase())) out.push(<span class="tk-k">{s}</span>);
			else if (num) out.push(<span class="tk-n">{s}</span>);
			else out.push(s);
			at = i + s.length;
		}
		if (at < props.text.length) out.push(props.text.slice(at));
		return out;
	});
	return <>{parts()}</>;
}
