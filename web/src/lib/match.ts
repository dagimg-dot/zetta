/**
 * How well typed text matches a name, best first. As in VS Code, the first typed letter must start
 * a word of the name, so `cu` finds customer_id and Customer but never `scuba`.
 */
export const Tier = {
	Exact: 0,
	Prefix: 1,
	/** The text runs whole from a word start, as `id` in customer_id. */
	WordRun: 2,
	/** Every letter starts a word, as `ci` for customer_id. */
	Initials: 3,
	/** The letters appear in order, the first at a word start. */
	Scattered: 4,
} as const;

export type Tier = (typeof Tier)[keyof typeof Tier];

export interface Match {
	tier: Tier;
	/** Lower is better within a tier: gaps between matched letters, then the name's length. */
	cost: number;
	/** The matched [start, end) ranges of the name, for drawing them in bold. */
	ranges: [number, number][];
}

/** True when `name[i]` starts a word: the first letter, after `_`, `$`, `.`, a space or a digit run, or a lower-to-upper step. */
function isWordStart(name: string, i: number): boolean {
	if (i === 0) return true;
	const prev = name.charCodeAt(i - 1);
	const c = name.charCodeAt(i);
	if (prev === 95 || prev === 36 || prev === 46 || prev === 32) return true;
	const prevDigit = prev >= 48 && prev <= 57;
	const digit = c >= 48 && c <= 57;
	if (prevDigit !== digit) return true;
	const prevLower = prev >= 97 && prev <= 122;
	const upper = c >= 65 && c <= 90;
	return prevLower && upper;
}

/** Collapses sorted positions into [start, end) ranges. */
function toRanges(positions: number[]): [number, number][] {
	const out: [number, number][] = [];
	for (const p of positions) {
		const last = out.at(-1);
		if (last && last[1] === p) last[1] = p + 1;
		else out.push([p, p + 1]);
	}
	return out;
}

/** Each letter of `text` at the next word start of `name` from `from`, or null. */
function initials(text: string, name: string, lower: string, from: number): number[] | null {
	const out: number[] = [];
	let i = from;
	for (const ch of text) {
		while (i < name.length && !(lower[i] === ch && isWordStart(name, i))) i++;
		if (i >= name.length) return null;
		out.push(i++);
	}
	return out;
}

/**
 * Matches `typed` against `name`, ignoring case. Empty text matches everything at the lowest cost.
 * `lower` is `name` lowercased, passed in so a caller matching many names lowercases each once.
 */
export function match(typed: string, name: string, lower = name.toLowerCase()): Match | null {
	if (!typed) return { tier: Tier.Prefix, cost: 0, ranges: [] };
	const text = typed.toLowerCase();
	if (text.length > name.length) return null;
	if (lower === text) return { tier: Tier.Exact, cost: 0, ranges: [[0, name.length]] };
	if (lower.startsWith(text))
		return { tier: Tier.Prefix, cost: name.length, ranges: [[0, text.length]] };

	for (let i = lower.indexOf(text, 1); i >= 0; i = lower.indexOf(text, i + 1)) {
		if (isWordStart(name, i))
			return { tier: Tier.WordRun, cost: i + name.length, ranges: [[i, i + text.length]] };
	}

	// The first letter must start a word; try each such start.
	let best: Match | null = null;
	for (let s = 0; s < name.length; s++) {
		if (lower[s] !== text[0] || !isWordStart(name, s)) continue;
		const at = initials(text, name, lower, s);
		if (at) {
			const cost = (at.at(-1) ?? 0) - s + name.length;
			if (!best || best.tier > Tier.Initials || cost < best.cost)
				best = { tier: Tier.Initials, cost, ranges: toRanges(at) };
			continue;
		}
		if (best) continue;
		// Scattered: in order, preferring a word start for each letter, else the next occurrence.
		const at2: number[] = [s];
		let i = s + 1;
		for (let k = 1; k < text.length; k++) {
			let j = i;
			while (j < name.length && !(lower[j] === text[k] && isWordStart(name, j))) j++;
			if (j >= name.length) j = lower.indexOf(text[k] ?? "", i);
			if (j < 0) break;
			at2.push(j);
			i = j + 1;
		}
		if (at2.length === text.length) {
			best = {
				tier: Tier.Scattered,
				cost: (at2.at(-1) ?? 0) - s + name.length,
				ranges: toRanges(at2),
			};
		}
	}
	return best;
}
