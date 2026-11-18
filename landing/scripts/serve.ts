// Serves dist/ the way Netlify does, compressed and with the headers from netlify.toml, so a
// Lighthouse run here measures what visitors get. Usage: bun scripts/serve.ts [port]
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const dist = join(import.meta.dir, "..", "dist");
const port = Number(process.argv[2] ?? 4331);

const compressible = /\.(html|css|js|mjs|json|svg|txt|md|xml|wasm|webmanifest)$/;

function resolve(pathname: string): string | null {
	const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
	let file = join(dist, rel);
	if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
	return existsSync(file) ? file : null;
}

Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		const file = resolve(url.pathname);
		if (!file) {
			const notFound = resolve("/404.html");
			return new Response(notFound ? Bun.file(notFound) : "Not found", { status: 404 });
		}
		const blob = Bun.file(file);
		const headers = new Headers({ "Content-Type": blob.type });
		if (url.pathname.startsWith("/_astro/")) {
			headers.set("Cache-Control", "public, max-age=31536000, immutable");
		} else {
			headers.set("Cache-Control", "public, max-age=0, must-revalidate");
		}
		if (compressible.test(file) && req.headers.get("accept-encoding")?.includes("br")) {
			const body = brotliCompressSync(new Uint8Array(await blob.arrayBuffer()), {
				params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
			});
			headers.set("Content-Encoding", "br");
			headers.set("Vary", "Accept-Encoding");
			return new Response(body, { headers });
		}
		return new Response(blob, { headers });
	},
});

console.log(`Serving ${dist} at http://127.0.0.1:${port}/`);
