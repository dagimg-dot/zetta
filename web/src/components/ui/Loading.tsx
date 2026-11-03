import { Loader } from "./icons";
import "./loading.css";

/** A pane-sized wait: the loader over a short label. It fades in late, so fast loads never flash it. */
export function Loading(props: { label: string; size?: number }) {
	return (
		<div class="loading" role="status">
			<Loader size={props.size ?? 36} />
			<span>{props.label}</span>
		</div>
	);
}
