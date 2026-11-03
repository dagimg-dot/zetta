export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

/**
 * Writes plain text and an HTML table together, so spreadsheets paste cells. Browsers allow this
 * only on HTTPS or localhost; elsewhere it falls back to the plain text.
 */
export async function copyRich(text: string, html: string): Promise<boolean> {
	if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return copyText(text);
	try {
		await navigator.clipboard.write([
			new ClipboardItem({
				"text/plain": new Blob([text], { type: "text/plain" }),
				"text/html": new Blob([html], { type: "text/html" }),
			}),
		]);
		return true;
	} catch {
		return copyText(text);
	}
}
