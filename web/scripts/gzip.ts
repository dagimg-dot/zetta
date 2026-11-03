// The binary embeds the page gzipped and serves it with Content-Encoding: gzip.
const html = await Bun.file("dist/index.html").bytes();
const gz = Bun.gzipSync(html, { level: 9 });
await Bun.write("dist/index.html.gz", gz);
console.log(`dist/index.html.gz  ${(gz.length / 1024).toFixed(1)} kB`);
