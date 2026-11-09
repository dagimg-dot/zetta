import { For, Show } from "solid-js";
import "./grid-skeleton.css";

const COLUMNS = [12, 22, 30, 16, 24, 14].map((chars) => ({ name: "", type: "", chars }));
const ROWS = Array.from({ length: 30 }, (_, r) => r);
const MAX_CHARS = 36;

/** Cell bars vary by position, so the rows read as data and not as stripes. */
const fill = (row: number, col: number) => 40 + ((row * 7 + col * 13) % 50);

/**
 * The grid's frame while its first rows are on the way, under the real column names once they are
 * known. It fades in late, so fast loads never flash it.
 */
export function GridSkeleton(props: {
	label: string;
	columns?: readonly { name: string; type: string }[];
}) {
	const columns = () =>
		props.columns?.length
			? props.columns.map((c) => ({
					...c,
					chars: Math.min(c.name.length + c.type.length + 2, MAX_CHARS),
				}))
			: COLUMNS;
	return (
		<div class="work">
			<div class="grid-skeleton mono" role="status" aria-label={props.label}>
				<div class="gs-line gs-head">
					<span class="gs-rn" />
					<For each={columns()}>
						{(c) => (
							<span class="gs-cell" style={{ width: `calc(${c.chars}ch + 24px)` }}>
								<Show when={c.name} fallback={<span class="sk-bar" style={{ width: "60%" }} />}>
									<span class="gs-name">{c.name}</span>
									<span class="gs-type">{c.type}</span>
								</Show>
							</span>
						)}
					</For>
				</div>
				<For each={ROWS}>
					{(r) => (
						<div class="gs-line">
							<span class="gs-rn" />
							<For each={columns()}>
								{(c, k) => (
									<span class="gs-cell" style={{ width: `calc(${c.chars}ch + 24px)` }}>
										<span class="sk-bar" style={{ width: `${fill(r, k())}%` }} />
									</span>
								)}
							</For>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}
