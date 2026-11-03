import { render } from "solid-js/web";
import { App } from "./App";
import "./fonts.css";
import "./tokens.css";
import "./styles.css";

const root = document.getElementById("root");
if (root) render(() => <App />, root);
