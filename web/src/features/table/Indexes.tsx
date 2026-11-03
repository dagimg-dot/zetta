import { For, Show } from "solid-js";
import { Icon } from "../../components/ui/icons";
import { SqlText } from "../../components/ui/SqlText";
import { tip } from "../../components/ui/Tip";
import type { IndexInfo, TableDetail } from "../../lib/api";
import { formatBytes, kindNoun } from "../../lib/format";
import { None, Section } from "./parts";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

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
						<SqlText text={def()} />
					</code>
				)}
			</Show>
		</li>
	);
}
