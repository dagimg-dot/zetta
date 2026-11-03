import { CopyButton } from "../../components/ui/CopyButton";
import { SqlText } from "../../components/ui/SqlText";
import type { TableDetail } from "../../lib/api";
import { plural } from "../../lib/format";

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
				<SqlText text={props.detail.ddl} />
			</pre>
		</div>
	);
}
