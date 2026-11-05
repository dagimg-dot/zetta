import { highlightHtml } from "../../lib/sql-highlight";
import { dialect } from "../../stores/dialect";
import "./sql-text.css";

/** SQL coloured by the connected database's lexer: keywords, strings, names, numbers, parameters and comments. */
export function SqlText(props: { text: string }) {
	return <span innerHTML={highlightHtml(props.text, dialect())} />;
}

/** One line of the editor's highlight layer, as HTML from highlightLines. */
export function SqlLine(props: { html: string; current?: boolean }) {
	return <div class="sql-line" classList={{ current: props.current }} innerHTML={props.html} />;
}
