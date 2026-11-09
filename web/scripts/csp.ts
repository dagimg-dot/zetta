/** A comment, or a whole inline script or style. Comments are matched so that their text is skipped. */
const block = /<!--[\s\S]*?-->|<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

function sha256(text: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(text).digest("base64");
	return `'sha256-${digest}'`;
}

/**
 * The Content-Security-Policy for the single-file page. Scripts and style elements run only if
 * they are the exact ones built here, so markup injected through a bug cannot run or restyle the
 * page, and nothing can be fetched from or sent to anywhere but zetta. Style attributes stay
 * allowed because Solid's templates and the page's skeleton use them, and they cannot run code.
 */
export function pageCsp(html: string): string {
	const hashes = { script: new Set<string>(), style: new Set<string>() };
	for (const [, tag, attributes, body] of html.matchAll(block)) {
		if (!tag) continue;
		if (/\bsrc\s*=/i.test(attributes ?? ""))
			throw new Error(`the page must inline everything, but a script has ${attributes}`);
		hashes[tag.toLowerCase() as keyof typeof hashes].add(sha256(body ?? ""));
	}
	return [
		"default-src 'none'",
		`script-src ${[...hashes.script].join(" ")}`,
		`style-src-elem ${[...hashes.style].join(" ")}`,
		"style-src-attr 'unsafe-inline'",
		"img-src data:",
		"font-src data:",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}
