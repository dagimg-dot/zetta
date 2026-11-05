// The binary embeds the page gzipped and serves it with Content-Encoding: gzip.
const html = await Bun.file("dist/index.html").bytes();

// Only the page is served, so a url() that Vite left unresolved would 404 at runtime.
const unresolved = new TextDecoder().decode(html).match(/url\(\s*["']?(?!data:|#)[^)"']+/g);
if (unresolved)
	throw new Error(`dist/index.html links files that are not inlined: ${unresolved.join(", ")}`);

const gz = Bun.gzipSync(html, { level: 9 });
await Bun.write("dist/index.html.gz", gz);
console.log(`dist/index.html.gz  ${(gz.length / 1024).toFixed(1)} kB`);
