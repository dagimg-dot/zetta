import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/CopyButton";
import { ErrorBox } from "../../components/ui/ErrorBox";
import { Icon } from "../../components/ui/icons";
import { Segmented } from "../../components/ui/Segmented";
import { SqlText } from "../../components/ui/SqlText";
import { ApiError, type ResultSet, runQuery, type TableDetail } from "../../lib/api";
import { formatMs } from "../../lib/format";
import { type Field, type FieldMode, initialMode, insertSql } from "../../lib/insert";
import { announce } from "../../stores/announce";
import { dialect } from "../../stores/dialect";
import { setView } from "../../stores/view";
import { None, Section } from "./parts";
import "./insert.css";

const modes: { value: FieldMode; label: string }[] = [
	{ value: "value", label: "Value" },
	{ value: "null", label: "NULL" },
	{ value: "default", label: "Default" },
];

type Outcome = { ok: true; result: ResultSet } | { ok: false; error: ApiError };

function freshFields(d: TableDetail): Record<string, Field> {
	const soleKey = d.columns.filter((c) => c.primaryKey).length === 1;
	return Object.fromEntries(
		d.columns.map((c) => [c.name, { mode: initialMode(c, soleKey), value: "" }]),
	);
}

/** A form with a field per column that writes one row into the table. */
export function InsertPane(props: { detail: TableDetail; readOnly: boolean }) {
	/** Changes only when the table or its columns do, so a refresh behind the form keeps what was typed. */
	const shape = createMemo(
		() =>
			`${props.detail.schema}\0${props.detail.name}\0${props.detail.columns.map((c) => c.name).join("\0")}`,
	);
	const [fields, setFields] = createSignal<Record<string, Field>>(freshFields(props.detail));
	const [busy, setBusy] = createSignal(false);
	const [outcome, setOutcome] = createSignal<Outcome | null>(null);
	let controller: AbortController | undefined;
	onCleanup(() => controller?.abort());

	createEffect(
		on(
			shape,
			() => {
				controller?.abort();
				setFields(freshFields(props.detail));
				setOutcome(null);
				setBusy(false);
			},
			{ defer: true },
		),
	);

	const field = (name: string): Field => fields()[name] ?? { mode: "value", value: "" };
	const patch = (name: string, next: Partial<Field>) =>
		setFields((all) => ({ ...all, [name]: { ...field(name), ...next } }));

	const sql = createMemo(() =>
		insertSql(
			{ schema: props.detail.schema, table: props.detail.name },
			props.detail.columns.map((c) => ({ name: c.name, field: field(c.name) })),
			dialect(),
			props.detail.kind === "table",
		),
	);

	const submit = async (e: Event) => {
		e.preventDefault();
		if (busy() || props.readOnly) return;
		controller?.abort();
		const ctl = new AbortController();
		controller = ctl;
		setBusy(true);
		setOutcome(null);
		try {
			const result = await runQuery(sql(), { exact: false }, ctl.signal);
			if (ctl.signal.aborted) return;
			setOutcome({ ok: true, result });
			setFields(freshFields(props.detail));
			announce(`Inserted a row into ${props.detail.name}`);
		} catch (err) {
			if (ctl.signal.aborted) return;
			setOutcome({
				ok: false,
				error: err instanceof ApiError ? err : new ApiError("internal", String(err), 0),
			});
		} finally {
			if (controller === ctl) setBusy(false);
		}
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
	};

	const reset = () => {
		setFields(freshFields(props.detail));
		setOutcome(null);
	};

	return (
		<form class="sheet insert" onSubmit={submit} onKeyDown={onKey}>
			<Show when={props.readOnly}>
				<p class="info-hint">
					<Icon name="lock" />
					zetta was started with --read-only, so the database refuses new rows. The statement below
					can still be copied.
				</p>
			</Show>

			<Section title="New row" note={`${props.detail.columns.length}`}>
				<Show
					when={props.detail.columns.length}
					fallback={<None>This table has no columns to fill in.</None>}
				>
					<div class="info-scroll">
						<table class="info-table insert-table">
							<thead>
								<tr>
									<th>Column</th>
									<th>Type</th>
									<th>Set to</th>
									<th class="wide">Value</th>
								</tr>
							</thead>
							<tbody>
								<For each={props.detail.columns}>
									{(c) => {
										const f = () => field(c.name);
										const id = () => `insert-${c.name}`;
										return (
											<tr>
												<td class="mono strong">
													<div class="key-row">
														<label for={id()}>{c.name}</label>
														<Show when={c.primaryKey}>
															<span class="key pk">
																<Icon name="key" />
																PK
															</span>
														</Show>
													</div>
												</td>
												<td class="mono type">
													{c.type}
													<Show when={!c.nullable || c.primaryKey}>
														<span class="muted"> not null</span>
													</Show>
												</td>
												<td>
													<Segmented
														legend={`What ${c.name} gets`}
														options={modes}
														value={f().mode}
														onChange={(mode) => patch(c.name, { mode })}
													/>
												</td>
												<td class="wide">
													<input
														type="text"
														id={id()}
														class="mono"
														spellcheck={false}
														autocomplete="off"
														value={f().mode === "value" ? f().value : ""}
														placeholder={
															f().mode === "null"
																? "NULL"
																: f().mode === "default"
																	? (c.default ?? "default")
																	: ""
														}
														onInput={(e) =>
															patch(c.name, { mode: "value", value: e.currentTarget.value })
														}
													/>
												</td>
											</tr>
										);
									}}
								</For>
							</tbody>
						</table>
					</div>
				</Show>
			</Section>

			<Section title="Statement">
				<pre class="def-block insert-sql">
					<SqlText text={sql()} />
				</pre>
				<div class="insert-bar">
					<Button
						type="submit"
						variant="primary"
						icon="plus"
						kbd="Mod+Enter"
						busy={busy()}
						disabled={props.readOnly}
					>
						Insert row
					</Button>
					<Button variant="quiet" onClick={reset}>
						Clear
					</Button>
					<span class="spacer" />
					<CopyButton variant="quiet" text={sql} what="the statement">
						Copy
					</CopyButton>
				</div>
			</Section>

			<Show when={outcome()}>
				{(o) => {
					const value = o();
					if (!value.ok) return <ErrorBox error={value.error} />;
					const r = value.result;
					return (
						<div class="insert-done" role="status">
							<p>
								<Icon name="check" />
								Inserted {r.rowCount === 1 || !r.rows.length ? "a row" : `${r.rowCount} rows`} in{" "}
								{formatMs(r.elapsedMs)}.
								<Button
									variant="quiet"
									size="sm"
									icon="go"
									onClick={() => setView({ pane: "rows" }, "push")}
								>
									Show rows
								</Button>
							</p>
							<Show when={r.rows[0]}>
								{(row) => (
									<div class="info-scroll">
										<table class="info-table">
											<tbody>
												<For each={r.columns}>
													{(col, i) => (
														<tr>
															<td class="mono strong">{col.name}</td>
															<td class="mono">
																<Show
																	when={row()[i()] !== null}
																	fallback={<span class="muted">null</span>}
																>
																	{row()[i()]}
																</Show>
															</td>
														</tr>
													)}
												</For>
											</tbody>
										</table>
									</div>
								)}
							</Show>
						</div>
					);
				}}
			</Show>
		</form>
	);
}
