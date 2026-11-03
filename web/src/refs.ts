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
