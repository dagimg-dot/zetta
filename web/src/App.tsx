import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Shortcuts } from "./components/layout/Shortcuts";
import { Sidebar } from "./components/layout/Sidebar";
import { Unauthorized } from "./components/layout/Unauthorized";
import { Button } from "./components/ui/Button";
import { TipLayer, tip } from "./components/ui/Tip";
import { SqlPane } from "./features/sql/SqlPane";
import { starterSql } from "./features/sql/starter";
import { TablePane } from "./features/table/TablePane";
import { getCatalog, getMeta, onUnauthorized } from "./lib/api";
import { createRequest } from "./lib/request";
import { announce, announcement } from "./stores/announce";
import { cycleTheme } from "./stores/theme";
import { setView, type Tab, view } from "./stores/view";
import "./components/layout/shell.css";

function typing(): boolean {
	const el = document.activeElement;
	return (
		el instanceof HTMLInputElement ||
		el instanceof HTMLTextAreaElement ||
		el instanceof HTMLSelectElement ||
		(el instanceof HTMLElement && el.isContentEditable)
	);
}

export function App() {
	const [unauthorized, setUnauthorized] = createSignal(false);
	const [navOpen, setNavOpen] = createSignal(false);
	onCleanup(onUnauthorized(() => setUnauthorized(true)));

	let search: HTMLInputElement | undefined;
	let filter: HTMLInputElement | undefined;
	let editor: HTMLTextAreaElement | undefined;
	let shortcuts: HTMLDialogElement | undefined;

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

	const showTab = (t: Tab) => {
		if (view().tab !== t) setView({ tab: t }, "push");
	};

	/** The raw WHERE box when it is open, otherwise the builder: its first value, or a new filter. */
	const focusFilter = () => {
		if (filter?.isConnected) return filter.focus();
		const value = document.querySelector<HTMLElement>(
			"#pane-data .q-filters .q-value, #pane-data .q-filters select",
		);
		if (value) return value.focus();
		document.querySelector<HTMLButtonElement>("#pane-data .q-compact button")?.click();
	};

	const clickPager = (which: "Prev" | "Next") => {
		const btn = document.querySelector<HTMLButtonElement>(
			`#pane-data .status [data-name="${which === "Prev" ? "prev" : "next"}-page"]`,
		);
		if (btn && !btn.disabled) btn.click();
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" && navOpen()) {
			setNavOpen(false);
			return;
		}
		if (e.ctrlKey || e.metaKey || e.altKey || typing() || shortcuts?.open) return;
		switch (e.key) {
			case "/":
				setNavOpen(true);
				queueMicrotask(() => {
					search?.focus();
					search?.select();
				});
				break;
			case "?":
				shortcuts?.showModal();
				break;
			case "t":
				announce(`Theme: ${cycleTheme()}`);
				break;
			case "d":
				showTab("data");
				break;
			case "s":
				showTab("sql");
				queueMicrotask(() => editor?.focus());
				break;
			case "f":
				if (view().tab !== "data" || view().pane !== "rows")
					setView({ tab: "data", pane: "rows" }, "push");
				queueMicrotask(focusFilter);
				break;
			case "g":
				document.querySelector<HTMLElement>(`#pane-${view().tab} table[role="grid"]`)?.focus();
				break;
			case "[":
				if (view().tab === "data") clickPager("Prev");
				break;
			case "]":
				if (view().tab === "data") clickPager("Next");
				break;
			default:
				return;
		}
		e.preventDefault();
	};
	onMount(() => addEventListener("keydown", onKey));
	onCleanup(() => removeEventListener("keydown", onKey));

	const tab = (t: Tab, label: string) => (
		<button
			type="button"
			class="tab"
			role="tab"
			id={`tab-${t}`}
			aria-selected={view().tab === t}
			aria-controls={`pane-${t}`}
			tabIndex={view().tab === t ? 0 : -1}
			{...tip(`${label} tab`, t === "data" ? "D" : "S", "bottom")}
			onClick={() => showTab(t)}
			onKeyDown={(e) => {
				if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
					const next: Tab = view().tab === "data" ? "sql" : "data";
					showTab(next);
					queueMicrotask(() => document.getElementById(`tab-${next}`)?.focus());
					e.preventDefault();
				}
			}}
		>
			{label}
		</button>
	);

	return (
		<Show when={!unauthorized()} fallback={<Unauthorized />}>
			<div class="app" classList={{ "nav-open": navOpen() }}>
				<Sidebar
					meta={meta.data()}
					catalog={catalog.data()}
					error={catalog.error()}
					loading={catalog.loading()}
					onRefresh={catalog.refetch}
					onOpen={() => setNavOpen(false)}
					searchRef={(el) => {
						search = el;
					}}
				/>
				<div class="scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
				<main>
					<div class="tabs">
						<Button
							class="menu-btn"
							icon="menu"
							iconSize={14}
							label="Show tables"
							aria-expanded={navOpen()}
							onClick={() => setNavOpen(!navOpen())}
						/>
						<div role="tablist" aria-label="View" class="view-tabs">
							{tab("data", "Data")}
							{tab("sql", "SQL")}
						</div>
						<span class="spacer" />
						<Button
							class="tool"
							icon="help"
							iconSize={14}
							label="Keyboard shortcuts"
							kbd="?"
							onClick={() => shortcuts?.showModal()}
						/>
					</div>
					<TablePane
						active={view().tab === "data"}
						approxRows={approxRows}
						filterRef={(el) => {
							filter = el;
						}}
					/>
					<SqlPane
						active={view().tab === "sql"}
						database={meta.data()?.database}
						readOnly={meta.data()?.readOnly ?? false}
						starter={starterSql(catalog.data(), meta.data()?.adapter, view())}
						onSchemaChange={catalog.refetch}
						editorRef={(el) => {
							editor = el;
						}}
					/>
				</main>
			</div>
			<Shortcuts
				ref={(el) => {
					shortcuts = el;
				}}
			/>
			<TipLayer />
			<div class="sr-only" aria-live="polite" aria-atomic="true">
				{announcement()}
			</div>
		</Show>
	);
}
