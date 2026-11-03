/** Names a table that points here, leaving out the schema when it is the one on show. */
export function refName(ref: { schema: string; table: string }, here: string): string {
	return ref.schema === here ? ref.table : `${ref.schema}.${ref.table}`;
}

/** The references whose table or column contains the query, ignoring case. */
export function matchRefs<T extends { label: string; detail?: string }>(
	refs: T[],
	query: string,
): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return refs;
	return refs.filter(
		(r) => r.label.toLowerCase().includes(q) || r.detail?.toLowerCase().includes(q),
	);
}

/**
 * How many foreign keys a table takes part in. A key from the table to itself is in both its
 * outgoing and incoming lists, and counts once.
 */
export function relationshipCount(d: {
	schema: string;
	name: string;
	foreignKeys: unknown[];
	referencedBy: { schema: string; table: string }[];
}): number {
	const fromElsewhere = d.referencedBy.filter((r) => r.schema !== d.schema || r.table !== d.name);
	return d.foreignKeys.length + fromElsewhere.length;
}
