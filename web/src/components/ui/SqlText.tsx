import { createMemo, type JSX } from "solid-js";
import "./sql-text.css";

const KEYWORDS = new Set(
	`add after alter always and as asc before begin by cascade check collate column comment constraint create cycle default deferrable deferred delete desc distinct do each end execute exists false for foreign from function generated grant identity if immediate in include index initially insert instead into is key like match no not null of on or order partial primary procedure references restrict returns row rowid select set statement strict table temp temporary trigger true unique update using values view when where with without`.split(
		" ",
	),
);

const TOKEN =
	/(--[^\n]*)|('(?:[^']|'')*')|("(?:[^"]|"")*")|([A-Za-z_][A-Za-z0-9_$]*)|(\d+(?:\.\d+)?)/g;

/** Light SQL colouring: keywords, strings, quoted names, numbers and comments. Everything else stays plain text. */
export function SqlText(props: { text: string }) {
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
