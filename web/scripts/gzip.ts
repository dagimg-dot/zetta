import { pageCsp } from "./csp";

// The binary embeds the page gzipped and serves it with Content-Encoding: gzip.
const html = await Bun.file("dist/index.html").bytes();
const text = new TextDecoder().decode(html);

// Only the page is served, so a url() that Vite left unresolved would 404 at runtime.
const unresolved = text.match(/url\(\s*["']?(?!data:|#)[^)"']+/g);
if (unresolved)
	throw new Error(`dist/index.html links files that are not inlined: ${unresolved.join(", ")}`);

await Bun.write("dist/csp.txt", pageCsp(text));
const gz = Bun.gzipSync(html, { level: 9 });
await Bun.write("dist/index.html.gz", gz);
console.log(`dist/index.html.gz  ${(gz.length / 1024).toFixed(1)} kB`);
