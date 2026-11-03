import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { announce, announcement } from "./announce";
import { getCatalog, getMeta, onUnauthorized } from "./api";
import { DataPane } from "./components/DataPane";
import { Icon } from "./components/icons";
import { Shortcuts } from "./components/Shortcuts";
import { Sidebar } from "./components/Sidebar";
import { SqlPane } from "./components/SqlPane";
import { Unauthorized } from "./components/Unauthorized";
import { createRequest } from "./request";
import { cycleTheme } from "./theme";
import { setView, type Tab, view } from "./url";

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

	const clickPager = (which: "Prev" | "Next") => {
		const btn = document.querySelector<HTMLButtonElement>(
			`#pane-data .status button[title^="${which === "Prev" ? "Previous" : "Next"}"]`,
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
				showTab("data");
				queueMicrotask(() => filter?.focus());
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
			title={`${label} (${t === "data" ? "D" : "S"})`}
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
						<button
							type="button"
							class="btn quiet icon-only menu-btn"
							aria-label="Show tables"
							aria-expanded={navOpen()}
							onClick={() => setNavOpen(!navOpen())}
						>
							<Icon name="menu" size={14} />
						</button>
						<div role="tablist" aria-label="View" style={{ display: "flex", gap: "2px" }}>
							{tab("data", "Data")}
							{tab("sql", "SQL")}
						</div>
						<span class="spacer" />
						<Show when={view().table}>
							<span class="where">
								<Icon name="table" />
								<span>
									{view().schema}.<b>{view().table}</b>
								</span>
							</span>
						</Show>
						<button
							type="button"
							class="btn quiet icon-only tool"
							aria-label="Keyboard shortcuts"
							title="Keyboard shortcuts (?)"
							onClick={() => shortcuts?.showModal()}
						>
							<Icon name="help" size={14} />
						</button>
					</div>
					<DataPane
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
			<div class="sr-only" aria-live="polite" aria-atomic="true">
				{announcement()}
			</div>
		</Show>
	);
}
