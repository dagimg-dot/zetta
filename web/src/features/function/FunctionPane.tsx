import { createMemo, For, Show } from "solid-js";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/CopyButton";
import { ErrorBox } from "../../components/ui/ErrorBox";
import { Icon } from "../../components/ui/icons";
import { SkeletonLines } from "../../components/ui/Skeleton";
import { SqlText } from "../../components/ui/SqlText";
import { type FunctionDetail, getFunction } from "../../lib/api";
import { createRequest, createResponseCache } from "../../lib/request";
import { openInSql } from "../../stores/sql-draft";
import { view } from "../../stores/view";
import "./function-pane.css";

/** Going back to a function shows it at once, and it refreshes behind that. */
const seen = createResponseCache<FunctionDetail>(32);

function facts(d: FunctionDetail): string[] {
	const out = d.returns ? [`returns ${d.returns}`] : [];
	out.push(d.language, d.volatility);
	if (d.strict) out.push("strict");
	if (d.securityDefiner) out.push("security definer");
	out.push(`owner ${d.owner}`);
	return out;
}

export function FunctionPane() {
	const target = createMemo(
		() => {
			const v = view();
			return v.schema !== null && v.fn !== null
				? { schema: v.schema, name: v.fn, args: v.args }
				: null;
		},
		undefined,
		{ equals: (a, b) => a?.schema === b?.schema && a?.name === b?.name && a?.args === b?.args },
	);

	const detail = createRequest(
		(t: { schema: string; name: string; args: string }, signal) =>
			getFunction(t.schema, t.name, t.args, signal),
		() => (view().tab === "data" ? target() : null),
		seen,
	);

	/** Only the detail for the open function counts; a slower answer for the previous one is ignored. */
	const current = () => {
		const k = detail.dataKey();
		const t = target();
		return k && t && k.schema === t.schema && k.name === t.name && k.args === t.args
			? detail.data()
			: undefined;
	};

	return (
		<section class="pane" id="pane-data" role="tabpanel" aria-labelledby="tab-data">
			<Show when={target()}>
				{(t) => (
					<>
						<header class="fn-head">
							<div class="fn-title">
								<Icon name="function" size={14} />
								<h1>
									<span class="fn-schema">{t().schema}.</span>
									{t().name}
									<span class="fn-args">({t().args})</span>
								</h1>
								<Show when={current()?.kind !== "function" && current()?.kind}>
									{(kind) => <span class="badge">{kind()}</span>}
								</Show>
								<span class="spacer" />
								<Show when={current()?.call}>
									{(call) => (
										<Button
											icon="play"
											tip="Puts a call in the SQL tab, ready to fill in and run"
											onClick={() => openInSql(call())}
										>
											Open in SQL
										</Button>
									)}
								</Show>
								<Show when={current()?.definition}>
									{(text) => (
										<CopyButton variant="quiet" text={text} what="the definition">
											Copy
										</CopyButton>
									)}
								</Show>
							</div>
							<ul class="fn-facts" aria-label="About this function">
								<For each={current() ? facts(current() as FunctionDetail) : []}>
									{(f) => <li>{f}</li>}
								</For>
							</ul>
							<Show when={current()?.comment}>
								<p class="fn-comment">{current()?.comment}</p>
							</Show>
						</header>
						<Show
							when={current()}
							fallback={
								<Show
									when={detail.error()}
									fallback={<SkeletonLines label="Loading the function" />}
								>
									{(err) => <ErrorBox error={err()} />}
								</Show>
							}
						>
							{(d) => (
								<Show
									when={d().definition}
									fallback={
										<p class="fn-none">
											An aggregate has no single statement that creates it. Its arguments are{" "}
											<span class="mono">({d().signature})</span>.
										</p>
									}
								>
									{(text) => (
										// biome-ignore lint/a11y/noNoninteractiveTabindex: a long definition scrolls, and a scrollable region must be reachable by keyboard.
										<pre class="fn-def mono" tabIndex={0}>
											<SqlText text={text()} />
										</pre>
									)}
								</Show>
							)}
						</Show>
					</>
				)}
			</Show>
		</section>
	);
}
