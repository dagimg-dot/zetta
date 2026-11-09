import "./styles/index.css";
import { render } from "solid-js/web";
import { App } from "./App";

const root = document.getElementById("root");
if (root) {
	// The shell in index.html stands in until now; render only ever appends.
	root.replaceChildren();
	render(() => <App />, root);
}
