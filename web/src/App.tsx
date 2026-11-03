import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { getCatalog, getMeta, onUnauthorized } from "./api";
import { DataPane } from "./components/DataPane";
import { Icon } from "./components/icons";
import { Sidebar } from "./components/Sidebar";
import { SqlPane } from "./components/SqlPane";
import { Unauthorized } from "./components/Unauthorized";
import { createRequest } from "./request";
import { setView, type Tab, view } from "./url";

export function App() {
	const [unauthorized, setUnauthorized] = createSignal(false);
	onCleanup(onUnauthorized(() => setUnauthorized(true)));

	const meta = createRequest(getMeta);
	const catalog = createRequest(getCatalog);
	meta.run(undefined);
	catalog.run(undefined);

	const approxRows = (schema: string, table: string): number | null => {
		const s = catalog.data()?.schemas.find((x) => x.name === schema);
		return s?.tables.find((t) => t.name === table)?.approxRows ?? null;
	};

	createEffect(() => {
		const v = view();
		const db = meta.data()?.database;
		const head = v.tab === "sql" ? "SQL" : v.table;
		document.title = [head, db, "zetta"].filter(Boolean).join(" · ");
	});

	const tab = (t: Tab, label: string) => (
		<button
			type="button"
			class="tab"
			classList={{ on: view().tab === t }}
			onClick={() => view().tab !== t && setView({ tab: t }, "push")}
		>
			{label}
		</button>
	);

	return (
		<Show when={!unauthorized()} fallback={<Unauthorized />}>
			<div class="app">
				<Sidebar
					meta={meta.data()}
					catalog={catalog.data()}
					error={catalog.error()}
					loading={catalog.loading()}
					onRefresh={catalog.refetch}
				/>
				<main>
					<div class="tabs">
						{tab("data", "Data")}
						{tab("sql", "SQL")}
						<span class="spacer" />
						<Show when={view().table}>
							<span class="where">
								<Icon name="table" class="inline" />
								{view().schema}.<b>{view().table}</b>
							</span>
						</Show>
					</div>
					<DataPane active={view().tab === "data"} approxRows={approxRows} />
					<SqlPane active={view().tab === "sql"} />
				</main>
			</div>
		</Show>
	);
}
