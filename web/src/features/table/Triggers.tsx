import { For, Show } from "solid-js";
import { Icon } from "../../components/ui/icons";
import { SqlText } from "../../components/ui/SqlText";
import type { TableDetail } from "../../lib/api";
import { kindNoun } from "../../lib/format";
import { None, Section } from "./parts";

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
										<SqlText text={t.definition} />
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
