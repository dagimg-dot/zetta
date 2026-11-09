import type { Catalog, Meta } from "./api";

/** What the last visit learned, so the next one can draw the table list before asking. */
export interface Boot {
	meta: Meta;
	catalog: Catalog;
}

const KEY = "zetta.boot";
/** A catalog this long would cost more to store and parse on every load than it saves. */
const MAX_CHARS = 512 * 1024;

function wellFormed(value: unknown): value is Boot {
	const b = value as Partial<Boot> | null;
	return (
		typeof b?.meta?.database === "string" &&
		Array.isArray(b.catalog?.schemas) &&
		b.catalog.schemas.every((s) => Array.isArray(s.tables) && Array.isArray(s.functions))
	);
}

export function loadBoot(): Boot | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
		return wellFormed(value) ? value : null;
	} catch {
		// Storage can be blocked or hold junk; the first load then just waits for the server.
		return null;
	}
}

export function saveBoot(boot: Boot): void {
	try {
		const text = JSON.stringify(boot);
		if (text.length <= MAX_CHARS) localStorage.setItem(KEY, text);
		else localStorage.removeItem(KEY);
	} catch {
		// As in loadBoot: without storage the next load waits for the server.
	}
}

/** A port can serve a different database from one run to the next. */
export function sameDatabase(a: Meta, b: Meta): boolean {
	return a.adapter === b.adapter && a.database === b.database;
}
