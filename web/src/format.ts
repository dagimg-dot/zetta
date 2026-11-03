export function formatMs(ms: number): string {
	return `${ms < 10 ? ms.toFixed(1) : Math.round(ms).toLocaleString()} ms`;
}

export function plural(n: number, word: string): string {
	return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}
