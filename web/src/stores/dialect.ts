import { createSignal } from "solid-js";
import type { Adapter } from "../lib/api";

/** The connected database's kind, which decides how SQL is lexed, split and coloured. */
const [dialect, setDialect] = createSignal<Adapter>("postgres");

export { dialect, setDialect };
